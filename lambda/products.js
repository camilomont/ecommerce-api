const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
	DynamoDBDocumentClient,
	PutCommand,
	ScanCommand,
} = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const tableName = process.env.TABLE_NAME;

const jsonResponse = (statusCode, body) => ({
	statusCode,
	headers: { "Content-Type": "application/json" },
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
	const query = event.queryStringParameters || {};

	try {
		if (method === "GET") {
			const limit = Math.min(Number(query.limit) || 25, 100);
			const data = await docClient.send(new ScanCommand({ TableName: tableName, Limit: limit }));
			return jsonResponse(200, {
				items: data.Items || [],
				lastEvaluatedKey: data.LastEvaluatedKey || null,
			});
		}

		if (method === "POST") {
			const parsed = parseBody(event.body);
			if (parsed.error) {
				return jsonResponse(400, { error: parsed.error });
			}

			const body = parsed.value;
			if (typeof body.productId !== "string" || body.productId.trim() === "") {
				return jsonResponse(400, { error: "productId es requerido" });
			}

			if (typeof body.name !== "string" || body.name.trim() === "") {
				return jsonResponse(400, { error: "name es requerido" });
			}

			if (typeof body.price !== "number" || body.price <= 0) {
				return jsonResponse(400, { error: "price debe ser numero mayor que 0" });
			}

			const item = {
				productId: body.productId,
				name: body.name,
				price: body.price,
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
