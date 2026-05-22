const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const {
	DynamoDBDocumentClient,
	ScanCommand,
	PutCommand,
} = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const s3Client = new S3Client({});

const tableName = process.env.TABLE_NAME;
const bucketName = process.env.BUCKET_NAME;

const getHeader = (headers, name) => {
	if (!headers) return "";
	return headers[name] || headers[name.toLowerCase()] || "";
};

const isMultipartRequest = (event) => {
	const contentType = String(getHeader(event.headers, "Content-Type"));
	return contentType.toLowerCase().includes("multipart/form-data");
};

const toNumber = (value) => {
	const n = Number(value);
	return Number.isFinite(n) ? n : NaN;
};

const parseMultipartFormData = (event) => {
	const contentType = String(getHeader(event.headers, "Content-Type"));
	const boundaryMatch = contentType.match(/boundary=([^;]+)/i);

	if (!boundaryMatch) {
		throw new Error("Boundary multipart no encontrada");
	}

	const boundary = `--${boundaryMatch[1].trim().replace(/^"|"$/g, "")}`;
	const bodyBuffer = event.isBase64Encoded
		? Buffer.from(event.body || "", "base64")
		: Buffer.from(event.body || "", "utf8");
	const raw = bodyBuffer.toString("binary");
	const rawParts = raw.split(boundary).slice(1, -1);

	const fields = {};
	const files = [];

	for (const rawPart of rawParts) {
		let part = rawPart;
		if (part.startsWith("\r\n")) part = part.slice(2);
		if (part.endsWith("\r\n")) part = part.slice(0, -2);

		const separatorIndex = part.indexOf("\r\n\r\n");
		if (separatorIndex === -1) continue;

		const headersText = part.slice(0, separatorIndex);
		const contentBinary = part.slice(separatorIndex + 4);
		const headerLines = headersText.split("\r\n");

		const disposition =
			headerLines.find((h) => h.toLowerCase().startsWith("content-disposition")) || "";
		const nameMatch = disposition.match(/name="([^"]+)"/i);
		if (!nameMatch) continue;

		const fieldname = nameMatch[1];
		const filenameMatch = disposition.match(/filename="([^"]*)"/i);
		const contentTypeLine =
			headerLines.find((h) => h.toLowerCase().startsWith("content-type")) || "";
		const contentTypeValue = contentTypeLine.includes(":")
			? contentTypeLine.split(":")[1].trim()
			: "application/octet-stream";

		if (filenameMatch && filenameMatch[1]) {
			files.push({
				fieldname,
				filename: filenameMatch[1],
				contentType: contentTypeValue,
				content: Buffer.from(contentBinary, "binary"),
			});
		} else {
			fields[fieldname] = Buffer.from(contentBinary, "binary").toString("utf8").trim();
		}
	}

	return { fields, files };
};

const uploadCoverImage = async (file) => {
	if (!file || !file.filename || !file.content) return null;

	const safeFileName = String(file.filename).replace(/[^a-zA-Z0-9._-]/g, "_");
	const objectKey = `projects/${Date.now()}-${safeFileName}`;

	await s3Client.send(
		new PutObjectCommand({
			Bucket: bucketName,
			Key: objectKey,
			Body: file.content,
			ContentType: file.contentType || "application/octet-stream",
		})
	);

	return `https://${bucketName}.s3.amazonaws.com/${objectKey}`;
};

const jsonResponse = (statusCode, body) => ({
	statusCode,
	headers: {
		"Content-Type": "application/json",
		"Access-Control-Allow-Origin": "*",
	},
	body: JSON.stringify(body),
});

const generateProjectId = () => {
	return `proj_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
};

exports.handler = async (event) => {
	const method = event.httpMethod;

	try {
		if (method === "GET") {
			const data = await docClient.send(new ScanCommand({ TableName: tableName }));
			return jsonResponse(200, {
				items: data.Items || [],
				lastEvaluatedKey: data.LastEvaluatedKey || null,
			});
		}

		if (method === "POST") {
			if (!isMultipartRequest(event)) {
				return jsonResponse(400, { error: "Se requiere Content-Type multipart/form-data" });
			}

			const form = parseMultipartFormData(event);
			const { title, description, price } = form.fields;
			const imageFile = (form.files || []).find((f) => f.fieldname === "image");

			if (typeof title !== "string" || title.trim() === "") {
				return jsonResponse(400, { error: "title es requerido" });
			}

			if (typeof description !== "string" || description.trim() === "") {
				return jsonResponse(400, { error: "description es requerido" });
			}

			const numericPrice = toNumber(price);
			if (Number.isNaN(numericPrice) || numericPrice < 0) {
				return jsonResponse(400, { error: "price debe ser un numero mayor o igual a 0" });
			}

			const imageUrl = imageFile ? await uploadCoverImage(imageFile) : null;

			const item = {
				projectId: generateProjectId(),
				title: title.trim(),
				description: description.trim(),
				price: numericPrice,
				imageUrl,
				createdAt: new Date().toISOString(),
			};

			await docClient.send(new PutCommand({ TableName: tableName, Item: item }));
			return jsonResponse(201, { message: "Proyecto creado con exito", item });
		}

		return jsonResponse(405, { error: "Metodo no permitido" });
	} catch (error) {
		console.error("projects.handler error", error);
		return jsonResponse(500, { error: "Error interno del servidor" });
	}
};
