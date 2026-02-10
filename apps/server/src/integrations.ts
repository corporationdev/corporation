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
// GET / - List integrations
// ---------------------------------------------------------------------------

const listIntegrationsRoute = createRoute({
	method: "get",
	path: "/",
	middleware: [authMiddleware],
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({
						configs: z.array(
							z.object({
								unique_key: z
									.string()
									.openapi({ description: "Integration unique key" }),
								provider: z.string().openapi({ description: "Provider name" }),
								logo: z
									.string()
									.optional()
									.openapi({ description: "Logo URL" }),
								created_at: z
									.string()
									.openapi({ description: "ISO 8601 timestamp" }),
								updated_at: z
									.string()
									.openapi({ description: "ISO 8601 timestamp" }),
							})
						),
					}),
				},
			},
			description: "List of available integrations",
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
// App
// ---------------------------------------------------------------------------

export const integrationsApp = $(
	new OpenAPIHono<IntegrationsEnv>()
		.openapi(listIntegrationsRoute, async (c) => {
			const nango = new Nango({ secretKey: c.env.NANGO_SECRET_KEY });

			try {
				const response = await nango.listIntegrations();
				return c.json({ configs: response.configs }, 200);
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
					end_user: { id: userId },
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
);
