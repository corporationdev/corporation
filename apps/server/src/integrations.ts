import { $, createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Nango } from "@nangohq/node";
import { authMiddleware } from "./auth";

const EndUserSchema = z.object({
	email: z
		.email()
		.optional()
		.openapi({ description: "End user email", example: "user@example.com" }),
	display_name: z
		.string()
		.optional()
		.openapi({ description: "Display name", example: "Jane Doe" }),
});

const CreateConnectSessionRequestSchema = z.object({
	end_user: EndUserSchema,
	allowed_integrations: z
		.array(z.string())
		.optional()
		.openapi({
			description: "Filter which integrations are available",
			example: ["github"],
		}),
	integrations_config_defaults: z
		.record(z.string(), z.record(z.string(), z.unknown()))
		.optional()
		.openapi({ description: "Per-integration config defaults" }),
});

const CreateConnectSessionResponseSchema = z.object({
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
});

const IntegrationSchema = z.object({
	unique_key: z.string().openapi({ description: "Integration unique key" }),
	provider: z.string().openapi({ description: "Provider name" }),
	logo: z.string().optional().openapi({ description: "Logo URL" }),
	created_at: z.string().openapi({ description: "ISO 8601 timestamp" }),
	updated_at: z.string().openapi({ description: "ISO 8601 timestamp" }),
});

const ListIntegrationsResponseSchema = z.object({
	configs: z.array(IntegrationSchema),
});

const ErrorResponseSchema = z.object({
	error: z.string().openapi({ description: "Error message" }),
});

const listIntegrationsRoute = createRoute({
	method: "get",
	path: "/",
	middleware: [authMiddleware],
	responses: {
		200: {
			content: {
				"application/json": {
					schema: ListIntegrationsResponseSchema,
				},
			},
			description: "List of available integrations",
		},
		500: {
			content: {
				"application/json": {
					schema: ErrorResponseSchema,
				},
			},
			description: "Failed to list integrations",
		},
	},
});

const createConnectSessionRoute = createRoute({
	method: "post",
	path: "/connect",
	middleware: [authMiddleware],
	request: {
		body: {
			content: {
				"application/json": {
					schema: CreateConnectSessionRequestSchema,
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
					schema: CreateConnectSessionResponseSchema,
				},
			},
			description: "Connect session created successfully",
		},
		500: {
			content: {
				"application/json": {
					schema: ErrorResponseSchema,
				},
			},
			description: "Failed to create connect session",
		},
	},
});

type IntegrationsEnv = {
	Bindings: Env;
	Variables: { jwtPayload: import("jose").JWTPayload };
};

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
					end_user: { ...body.end_user, id: userId },
					allowed_integrations: body.allowed_integrations,
					integrations_config_defaults: body.integrations_config_defaults,
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
