import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { $, createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ConvexHttpClient } from "convex/browser";
import { type AuthVariables, authMiddleware } from "./auth";
import {
	bootSandboxAgent,
	createReadySandbox,
	ensureSandboxAgentRunning,
	getPreviewUrl,
	isPreviewUrlHealthy,
} from "./sandbox-lifecycle";

type SandboxesEnv = {
	Bindings: Env;
	Variables: AuthVariables;
};

const ErrorResponseSchema = z.object({
	error: z.string().openapi({ description: "Error message" }),
});

function createConvexClient(
	convexUrl: string,
	token: string
): ConvexHttpClient {
	const client = new ConvexHttpClient(convexUrl);
	client.setAuth(token);
	return client;
}

function getBearerToken(authHeader: string | undefined): string {
	if (!authHeader?.startsWith("Bearer ")) {
		throw new Error("Missing bearer token");
	}
	return authHeader.slice(7);
}

async function generateAndStorePreviewUrl(
	convex: ConvexHttpClient,
	sandbox: Sandbox,
	sandboxId: Id<"sandboxes">
): Promise<string> {
	const baseUrl = await getPreviewUrl(sandbox);
	await convex.mutation(api.sandboxes.update, { id: sandboxId, baseUrl });
	return baseUrl;
}

async function ensureExistingSandbox(
	convex: ConvexHttpClient,
	daytona: Daytona,
	sandboxId: Id<"sandboxes">,
	anthropicApiKey: string
): Promise<{ sandboxId: string; baseUrl: string | undefined }> {
	const record = await convex.query(api.sandboxes.getById, {
		id: sandboxId,
	});

	if (!record.daytonaSandboxId) {
		return await provisionDaytonaSandbox(
			convex,
			daytona,
			record._id,
			anthropicApiKey
		);
	}

	let sandbox: Sandbox;
	try {
		sandbox = await daytona.get(record.daytonaSandboxId);
	} catch {
		return await provisionDaytonaSandbox(
			convex,
			daytona,
			record._id,
			anthropicApiKey
		);
	}

	const state = sandbox.state;

	if (state === "started") {
		await ensureSandboxAgentRunning(sandbox);

		if (record.baseUrl && (await isPreviewUrlHealthy(record.baseUrl))) {
			return { sandboxId: record._id, baseUrl: undefined };
		}

		const baseUrl = await generateAndStorePreviewUrl(
			convex,
			sandbox,
			record._id
		);
		return { sandboxId: record._id, baseUrl };
	}

	if (state === "stopped" || state === "archived") {
		await convex.mutation(api.sandboxes.update, {
			id: record._id,
			status: "starting",
		});
		await sandbox.start();
		await bootSandboxAgent(sandbox);
		await convex.mutation(api.sandboxes.update, {
			id: record._id,
			status: "started",
		});
		const baseUrl = await generateAndStorePreviewUrl(
			convex,
			sandbox,
			record._id
		);
		return { sandboxId: record._id, baseUrl };
	}

	// error / unknown — reprovision
	return await provisionDaytonaSandbox(
		convex,
		daytona,
		record._id,
		anthropicApiKey
	);
}

async function provisionDaytonaSandbox(
	convex: ConvexHttpClient,
	daytona: Daytona,
	sandboxId: Id<"sandboxes">,
	anthropicApiKey: string
): Promise<{ sandboxId: string; baseUrl: string }> {
	const sandbox = await createReadySandbox(daytona, anthropicApiKey);
	const baseUrl = await getPreviewUrl(sandbox);

	await convex.mutation(api.sandboxes.update, {
		id: sandboxId,
		status: "started",
		daytonaSandboxId: sandbox.id,
		baseUrl,
	});

	return { sandboxId, baseUrl };
}

// ---------------------------------------------------------------------------
// POST /ensure — Ensure a running sandbox exists
// ---------------------------------------------------------------------------

const ensureRoute = createRoute({
	method: "post",
	path: "/ensure",
	middleware: [authMiddleware],
	request: {
		body: {
			content: {
				"application/json": {
					schema: z.object({
						environmentId: z.string().optional().openapi({
							description:
								"Convex environment ID (required when sandboxId is absent)",
						}),
						repositoryId: z.string().optional().openapi({
							description:
								"Convex repository ID (required when sandboxId is absent)",
						}),
						sandboxId: z.string().optional().openapi({
							description: "Convex sandbox ID if one already exists",
						}),
					}),
				},
			},
			required: true,
			description: "Ensure a running sandbox exists for the given environment",
		},
	},
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({
						sandboxId: z.string().openapi({ description: "Convex sandbox ID" }),
						baseUrl: z.string().optional().openapi({
							description:
								"Preview URL to the sandbox-agent server. Undefined if the cached URL is still valid.",
						}),
					}),
				},
			},
			description: "Sandbox is running and ready",
		},
		500: {
			content: {
				"application/json": { schema: ErrorResponseSchema },
			},
			description: "Failed to ensure sandbox",
		},
	},
});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export const sandboxesApp = $(
	new OpenAPIHono<SandboxesEnv>().openapi(ensureRoute, async (c) => {
		const body = c.req.valid("json");
		const token = getBearerToken(c.req.header("Authorization"));
		const convex = createConvexClient(c.env.CONVEX_URL, token);
		const daytona = new Daytona({ apiKey: c.env.DAYTONA_API_KEY });

		let sandboxId: Id<"sandboxes"> | undefined;

		try {
			let result: { sandboxId: string; baseUrl: string | undefined };

			if (body.sandboxId) {
				sandboxId = body.sandboxId as Id<"sandboxes">;
				result = await ensureExistingSandbox(
					convex,
					daytona,
					sandboxId,
					c.env.ANTHROPIC_API_KEY
				);
			} else {
				if (!body.environmentId) {
					return c.json(
						{ error: "environmentId is required when sandboxId is absent" },
						500
					);
				}

				sandboxId = await convex.mutation(api.sandboxes.create, {
					environmentId: body.environmentId as Id<"environments">,
					branchName: "main",
				});

				result = await provisionDaytonaSandbox(
					convex,
					daytona,
					sandboxId,
					c.env.ANTHROPIC_API_KEY
				);
			}

			return c.json(result, 200);
		} catch (error) {
			if (sandboxId) {
				try {
					await convex.mutation(api.sandboxes.update, {
						id: sandboxId,
						status: "error",
					});
				} catch {
					// Best effort
				}
			}
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: `Sandbox ensure failed: ${message}` }, 500);
		}
	})
);
