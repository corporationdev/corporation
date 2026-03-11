import { $, createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { type AuthVariables, authMiddleware } from "./auth";
import {
	createIntegrationConnectSession,
	disconnectIntegration,
	listIntegrations,
} from "./services/integrations";

const ErrorResponseSchema = z.object({
	error: z.string().openapi({ description: "Error message" }),
});

type IntegrationsEnv = {
	Bindings: Env;
	Variables: AuthVariables;
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
			try {
				return c.json(
					await listIntegrations(c.env, c.get("jwtPayload").sub),
					200
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: `Nango API error: ${message}` }, 500);
			}
		})
		.openapi(createConnectSessionRoute, async (c) => {
			const body = c.req.valid("json");
			try {
				return c.json(
					await createIntegrationConnectSession(c.env, c.get("jwtPayload"), {
						allowedIntegrations: body.allowed_integrations,
					}),
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
			try {
				return c.json(
					await disconnectIntegration(c.env, {
						connectionId,
						providerConfigKey: provider_config_key,
					}),
					200
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: `Nango API error: ${message}` }, 500);
			}
		})
);
