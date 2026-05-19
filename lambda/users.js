const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
	DynamoDBDocumentClient,
	PutCommand,
	ScanCommand,
	QueryCommand,
} = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const USERS_TABLE = process.env.TABLE_NAME;
const ORDERS_TABLE = process.env.ORDERS_TABLE_NAME;

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

const isEmail = (value) =>
	typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

exports.handler = async (event) => {
	const method = event.httpMethod;
	const resource = event.resource || "";
	const pathParameters = event.pathParameters || {};
	const query = event.queryStringParameters || {};

	try {
		if (resource.includes("/products")) {
			const userId = pathParameters.userId;

			if (!userId) {
				return jsonResponse(400, { error: "userId es requerido" });
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

				if (
					body.quantity !== undefined &&
					(!Number.isInteger(body.quantity) || body.quantity <= 0)
				) {
					return jsonResponse(400, { error: "quantity debe ser entero positivo" });
				}

				const purchase = {
					userId,
					productId: body.productId,
					purchaseDate: new Date().toISOString(),
					quantity: body.quantity || 1,
				};

				await docClient.send(new PutCommand({ TableName: ORDERS_TABLE, Item: purchase }));
				return jsonResponse(201, { message: "Compra registrada con exito", purchase });
			}

			if (method === "GET") {
				const limit = Math.min(Number(query.limit) || 25, 100);
				const data = await docClient.send(
					new QueryCommand({
						TableName: ORDERS_TABLE,
						KeyConditionExpression: "userId = :u",
						ExpressionAttributeValues: { ":u": userId },
						Limit: limit,
					})
				);

				return jsonResponse(200, {
					items: data.Items || [],
					lastEvaluatedKey: data.LastEvaluatedKey || null,
				});
			}

			return jsonResponse(405, { error: "Metodo no permitido" });
		}

		if (method === "GET") {
			const limit = Math.min(Number(query.limit) || 25, 100);
			const data = await docClient.send(new ScanCommand({ TableName: USERS_TABLE, Limit: limit }));
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
			if (typeof body.userId !== "string" || body.userId.trim() === "") {
				return jsonResponse(400, { error: "userId es requerido" });
			}

			if (typeof body.name !== "string" || body.name.trim() === "") {
				return jsonResponse(400, { error: "name es requerido" });
			}

			if (!isEmail(body.email)) {
				return jsonResponse(400, { error: "email invalido" });
			}

			const item = {
				userId: body.userId,
				name: body.name,
				email: body.email,
			};

			await docClient.send(new PutCommand({ TableName: USERS_TABLE, Item: item }));
			return jsonResponse(201, { message: "Usuario creado con exito", item });
		}

		return jsonResponse(405, { error: "Metodo no permitido" });
	} catch (error) {
		console.error("users.handler error", error);
		return jsonResponse(500, { error: "Error interno del servidor" });
	}
};
