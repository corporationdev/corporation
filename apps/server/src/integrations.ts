import { $, createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Nango } from "@nangohq/node";
import { authMiddleware } from "./auth";

const EndUserSchema = z.object({
	id: z.string().openapi({ description: "End user ID", example: "user_123" }),
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

const ErrorResponseSchema = z.object({
	error: z.string().openapi({ description: "Error message" }),
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
	new OpenAPIHono<IntegrationsEnv>().openapi(
		createConnectSessionRoute,
		async (c) => {
			const body = c.req.valid("json");
			const nango = new Nango({ secretKey: c.env.NANGO_SECRET_KEY });

			try {
				const { data } = await nango.createConnectSession({
					end_user: body.end_user,
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
		}
	)
);
