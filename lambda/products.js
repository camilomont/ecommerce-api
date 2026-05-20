const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	UpdateCommand,
	DeleteCommand,
	ScanCommand,
} = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const s3Client = new S3Client({});
const tableName = process.env.TABLE_NAME;
const bucketName = process.env.BUCKET_NAME;

const getHeader = (headers, name) => {
	if (!headers) {
		return "";
	}

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

	const boundary = `--${boundaryMatch[1].trim().replace(/^\"|\"$/g, "")}`;
	const bodyBuffer = event.isBase64Encoded
		? Buffer.from(event.body || "", "base64")
		: Buffer.from(event.body || "", "utf8");
	const raw = bodyBuffer.toString("binary");
	const rawParts = raw.split(boundary).slice(1, -1);

	const fields = {};
	const files = [];

	for (const rawPart of rawParts) {
		let part = rawPart;
		if (part.startsWith("\r\n")) {
			part = part.slice(2);
		}
		if (part.endsWith("\r\n")) {
			part = part.slice(0, -2);
		}

		const separatorIndex = part.indexOf("\r\n\r\n");
		if (separatorIndex === -1) {
			continue;
		}

		const headersText = part.slice(0, separatorIndex);
		const contentBinary = part.slice(separatorIndex + 4);
		const headerLines = headersText.split("\r\n");

		const disposition =
			headerLines.find((h) => h.toLowerCase().startsWith("content-disposition")) || "";
		const nameMatch = disposition.match(/name=\"([^\"]+)\"/i);
		if (!nameMatch) {
			continue;
		}

		const fieldname = nameMatch[1];
		const filenameMatch = disposition.match(/filename=\"([^\"]*)\"/i);
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

const uploadProductImageIfPresent = async (file) => {
	if (!file || !file.filename || !file.content) {
		return null;
	}

	const safeFileName = String(file.filename).replace(/[^a-zA-Z0-9._-]/g, "_");
	const objectKey = `products/${Date.now()}-${safeFileName}`;

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

const parseBody = (rawBody) => {
	try {
		return { value: JSON.parse(rawBody || "{}") };
	} catch {
		return { error: "JSON invalido" };
	}
};

exports.handler = async (event) => {
	const method = event.httpMethod;
	const resource = event.resource || "";
	const pathParameters = event.pathParameters || {};
	const query = event.queryStringParameters || {};

	try {
		if (resource === "/products/upload-url") {
			if (method !== "POST") {
				return jsonResponse(405, { error: "Metodo no permitido" });
			}

			const parsed = parseBody(event.body);
			if (parsed.error) {
				return jsonResponse(400, { error: parsed.error });
			}

			const { fileName, contentType } = parsed.value;
			if (typeof fileName !== "string" || fileName.trim() === "") {
				return jsonResponse(400, { error: "fileName es requerido" });
			}

			const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
			const objectKey = `products/${Date.now()}-${safeFileName}`;

			const uploadCommand = new PutObjectCommand({
				Bucket: bucketName,
				Key: objectKey,
				ContentType:
					typeof contentType === "string" && contentType.trim() !== ""
						? contentType
						: "application/octet-stream",
			});

			const uploadUrl = await getSignedUrl(s3Client, uploadCommand, {
				expiresIn: 300,
			});

			const imageUrl = `https://${bucketName}.s3.amazonaws.com/${objectKey}`;
			return jsonResponse(200, { uploadUrl, imageUrl, objectKey });
		}

		if (resource === "/products/{productId}") {
			const productId = pathParameters.productId;

			if (!productId) {
				return jsonResponse(400, { error: "productId es requerido" });
			}

			if (method === "PUT") {
				let body;
				let uploadedImageUrl = null;

				if (isMultipartRequest(event)) {
					const form = parseMultipartFormData(event);
					body = {
						name: form.fields.name,
						price: toNumber(form.fields.price),
						imageUrl: form.fields.imageUrl,
					};
					uploadedImageUrl = await uploadProductImageIfPresent(
						(form.files || []).find((f) => f.fieldname === "image")
					);
				} else {
					const parsed = parseBody(event.body);
					if (parsed.error) {
						return jsonResponse(400, { error: parsed.error });
					}
					body = parsed.value;
				}

				if (typeof body.name !== "string" || body.name.trim() === "") {
					return jsonResponse(400, { error: "name es requerido" });
				}

				if (typeof body.price !== "number" || body.price <= 0) {
					return jsonResponse(400, { error: "price debe ser numero mayor que 0" });
				}

				if (
					uploadedImageUrl === null &&
					body.imageUrl !== undefined &&
					(typeof body.imageUrl !== "string" || body.imageUrl.trim() === "")
				) {
					return jsonResponse(400, { error: "imageUrl debe ser texto valido" });
				}

				const productExists = await docClient.send(
					new GetCommand({
						TableName: tableName,
						Key: { productId },
					})
				);

				if (!productExists.Item) {
					return jsonResponse(404, { error: "El producto no existe" });
				}

				await docClient.send(
					new UpdateCommand({
						TableName: tableName,
						Key: { productId },
						UpdateExpression:
							"SET #name = :name, price = :price, imageUrl = :imageUrl",
						ExpressionAttributeNames: { "#name": "name" },
						ExpressionAttributeValues: {
							":name": body.name,
							":price": body.price,
							":imageUrl": uploadedImageUrl || body.imageUrl || null,
						},
					})
				);

				return jsonResponse(200, { message: "Producto actualizado con exito" });
			}

			if (method === "DELETE") {
				const productExists = await docClient.send(
					new GetCommand({
						TableName: tableName,
						Key: { productId },
					})
				);

				if (!productExists.Item) {
					return jsonResponse(404, { error: "El producto no existe" });
				}

				await docClient.send(
					new DeleteCommand({
						TableName: tableName,
						Key: { productId },
					})
				);

				return jsonResponse(200, { message: "Producto eliminado con exito" });
			}

			return jsonResponse(405, { error: "Metodo no permitido" });
		}

		if (method === "GET") {
			const limit = Math.min(Number(query.limit) || 25, 100);
			const data = await docClient.send(new ScanCommand({ TableName: tableName, Limit: limit }));
			return jsonResponse(200, {
				items: data.Items || [],
				lastEvaluatedKey: data.LastEvaluatedKey || null,
			});
		}

		if (method === "POST") {
			let body;
			let uploadedImageUrl = null;

			if (isMultipartRequest(event)) {
				const form = parseMultipartFormData(event);
				body = {
					productId: form.fields.productId,
					name: form.fields.name,
					price: toNumber(form.fields.price),
					imageUrl: form.fields.imageUrl,
				};
				uploadedImageUrl = await uploadProductImageIfPresent(
					(form.files || []).find((f) => f.fieldname === "image")
				);
			} else {
				const parsed = parseBody(event.body);
				if (parsed.error) {
					return jsonResponse(400, { error: parsed.error });
				}
				body = parsed.value;
			}

			if (typeof body.productId !== "string" || body.productId.trim() === "") {
				return jsonResponse(400, { error: "productId es requerido" });
			}

			if (typeof body.name !== "string" || body.name.trim() === "") {
				return jsonResponse(400, { error: "name es requerido" });
			}

			if (typeof body.price !== "number" || body.price <= 0) {
				return jsonResponse(400, { error: "price debe ser numero mayor que 0" });
			}

			if (
				uploadedImageUrl === null &&
				body.imageUrl !== undefined &&
				(typeof body.imageUrl !== "string" || body.imageUrl.trim() === "")
			) {
				return jsonResponse(400, { error: "imageUrl debe ser texto valido" });
			}

			const item = {
				productId: body.productId,
				name: body.name,
				price: body.price,
				imageUrl: uploadedImageUrl || body.imageUrl || null,
			};

			await docClient.send(new PutCommand({ TableName: tableName, Item: item }));
			return jsonResponse(201, { message: "Producto creado con exito", item });
		}

		return jsonResponse(405, { error: "Metodo no permitido" });
	} catch (error) {
		console.error("products.handler error", error);
		return jsonResponse(500, { error: "Error interno del servidor" });
	}
};
