const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
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
const tableName = process.env.TABLE_NAME;

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
		if (resource === "/products/{productId}") {
			const productId = pathParameters.productId;

			if (!productId) {
				return jsonResponse(400, { error: "productId es requerido" });
			}

			if (method === "PUT") {
				const parsed = parseBody(event.body);
				if (parsed.error) {
					return jsonResponse(400, { error: parsed.error });
				}

				const body = parsed.value;
				if (typeof body.name !== "string" || body.name.trim() === "") {
					return jsonResponse(400, { error: "name es requerido" });
				}

				if (typeof body.price !== "number" || body.price <= 0) {
					return jsonResponse(400, { error: "price debe ser numero mayor que 0" });
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
						UpdateExpression: "SET #name = :name, price = :price",
						ExpressionAttributeNames: { "#name": "name" },
						ExpressionAttributeValues: {
							":name": body.name,
							":price": body.price,
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
