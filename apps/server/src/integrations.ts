import { $, createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Nango } from "@nangohq/node";
import { authMiddleware } from "./auth";

const ErrorResponseSchema = z.object({
	error: z.string().openapi({ description: "Error message" }),
});

type IntegrationsEnv = {
	Bindings: Env;
	Variables: { jwtPayload: import("jose").JWTPayload };
};

// ---------------------------------------------------------------------------
// GET / - List integrations with connection status
// ---------------------------------------------------------------------------

const connectionSchema = z.object({
	connection_id: z.string(),
	provider: z.string(),
	created: z.string(),
	end_user: z
		.object({
			email: z.string().nullable(),
			display_name: z.string().nullable(),
		})
		.nullable(),
});

const listIntegrationsRoute = createRoute({
	method: "get",
	path: "/",
	middleware: [authMiddleware],
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({
						integrations: z.array(
							z.object({
								unique_key: z.string(),
								provider: z.string(),
								logo: z.string().optional(),
								connection: connectionSchema.nullable(),
							})
						),
					}),
				},
			},
			description: "List of integrations with connection status",
		},
		500: {
			content: {
				"application/json": { schema: ErrorResponseSchema },
			},
			description: "Failed to list integrations",
		},
	},
});

// ---------------------------------------------------------------------------
// POST /connect - Create a Nango connect session
// ---------------------------------------------------------------------------

const createConnectSessionRoute = createRoute({
	method: "post",
	path: "/connect",
	middleware: [authMiddleware],
	request: {
		body: {
			content: {
				"application/json": {
					schema: z.object({
						allowed_integrations: z
							.array(z.string())
							.optional()
							.openapi({
								description: "Filter which integrations are available",
								example: ["github"],
							}),
					}),
				},
			},
			required: true,
			description: "Create a Nango connect session",
		},
	},
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({
						token: z.string().openapi({
							description: "Session token for Nango Connect",
							example: "nango_connect_session_abc123",
						}),
						connect_link: z
							.string()
							.optional()
							.openapi({ description: "Direct connection URL" }),
						expires_at: z.string().openapi({
							description: "ISO 8601 expiration timestamp",
							example: "2025-01-01T00:30:00.000Z",
						}),
					}),
				},
			},
			description: "Connect session created successfully",
		},
		500: {
			content: {
				"application/json": { schema: ErrorResponseSchema },
			},
			description: "Failed to create connect session",
		},
	},
});

// ---------------------------------------------------------------------------
// DELETE /connections/:connectionId - Disconnect a connection
// ---------------------------------------------------------------------------

const disconnectRoute = createRoute({
	method: "delete",
	path: "/connections/{connectionId}",
	middleware: [authMiddleware],
	request: {
		params: z.object({
			connectionId: z.string().openapi({ description: "Connection ID" }),
		}),
		query: z.object({
			provider_config_key: z
				.string()
				.openapi({ description: "Integration unique key" }),
		}),
	},
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({
						success: z.boolean(),
					}),
				},
			},
			description: "Connection deleted successfully",
		},
		500: {
			content: {
				"application/json": { schema: ErrorResponseSchema },
			},
			description: "Failed to delete connection",
		},
	},
});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export const integrationsApp = $(
	new OpenAPIHono<IntegrationsEnv>()
		.openapi(listIntegrationsRoute, async (c) => {
			const jwtPayload = c.get("jwtPayload");
			const userId = jwtPayload.sub;

			if (!userId) {
				return c.json({ error: "User ID not found in token" }, 500);
			}

			const nango = new Nango({ secretKey: c.env.NANGO_SECRET_KEY });

			try {
				const [integrationsRes, connectionsRes] = await Promise.all([
					nango.listIntegrations(),
					fetch(
						`https://api.nango.dev/connection?endUserId=${encodeURIComponent(userId)}`,
						{
							headers: {
								Authorization: `Bearer ${c.env.NANGO_SECRET_KEY}`,
							},
						}
					),
				]);

				if (!connectionsRes.ok) {
					throw new Error(
						`Nango connections API returned ${connectionsRes.status}`
					);
				}

				const connectionsData = (await connectionsRes.json()) as {
					connections: {
						connection_id: string;
						provider_config_key: string;
						provider: string;
						created: string;
						end_user: {
							id: string;
							email: string | null;
							display_name: string | null;
						} | null;
					}[];
				};

				const connectionsByKey = new Map(
					connectionsData.connections.map((conn) => [
						conn.provider_config_key,
						conn,
					])
				);

				const integrations = integrationsRes.configs.map(
					(config: { unique_key: string; provider: string; logo?: string }) => {
						const conn = connectionsByKey.get(config.unique_key);
						return {
							unique_key: config.unique_key,
							provider: config.provider,
							logo: config.logo,
							connection: conn
								? {
										connection_id: conn.connection_id,
										provider: conn.provider,
										created: conn.created,
										end_user: conn.end_user
											? {
													email: conn.end_user.email,
													display_name: conn.end_user.display_name,
												}
											: null,
									}
								: null,
						};
					}
				);

				return c.json({ integrations }, 200);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: `Nango API error: ${message}` }, 500);
			}
		})
		.openapi(createConnectSessionRoute, async (c) => {
			const body = c.req.valid("json");
			const jwtPayload = c.get("jwtPayload");
			const userId = jwtPayload.sub;

			if (!userId) {
				return c.json({ error: "User ID not found in token" }, 500);
			}

			const nango = new Nango({ secretKey: c.env.NANGO_SECRET_KEY });

			try {
				const { data } = await nango.createConnectSession({
					end_user: {
						id: userId,
						email: jwtPayload.email as string | undefined,
						display_name: jwtPayload.name as string | undefined,
					},
					allowed_integrations: body.allowed_integrations,
				});

				return c.json(
					{
						token: data.token,
						connect_link: data.connect_link,
						expires_at: data.expires_at,
					},
					200
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: `Nango API error: ${message}` }, 500);
			}
		})
		.openapi(disconnectRoute, async (c) => {
			const { connectionId } = c.req.valid("param");
			const { provider_config_key } = c.req.valid("query");
			const nango = new Nango({ secretKey: c.env.NANGO_SECRET_KEY });

			try {
				await nango.deleteConnection(provider_config_key, connectionId);
				return c.json({ success: true }, 200);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: `Nango API error: ${message}` }, 500);
			}
		})
);
