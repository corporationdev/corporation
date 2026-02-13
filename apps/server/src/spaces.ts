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

type SpacesEnv = {
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

async function generateAndStoreSandboxUrl(
	convex: ConvexHttpClient,
	sandbox: Sandbox,
	spaceId: Id<"spaces">
): Promise<string> {
	const sandboxUrl = await getPreviewUrl(sandbox);
	await convex.mutation(api.spaces.update, { id: spaceId, sandboxUrl });
	return sandboxUrl;
}

async function ensureExistingSandbox(
	convex: ConvexHttpClient,
	daytona: Daytona,
	spaceId: Id<"spaces">,
	anthropicApiKey: string
): Promise<{ spaceId: string; sandboxUrl: string | undefined }> {
	const record = await convex.query(api.spaces.getById, {
		id: spaceId,
	});

	if (!record.sandboxId) {
		return await provisionDaytonaSandbox(
			convex,
			daytona,
			record._id,
			anthropicApiKey
		);
	}

	let sandbox: Sandbox;
	try {
		sandbox = await daytona.get(record.sandboxId);
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

		if (record.sandboxUrl && (await isPreviewUrlHealthy(record.sandboxUrl))) {
			return { spaceId: record._id, sandboxUrl: undefined };
		}

		const sandboxUrl = await generateAndStoreSandboxUrl(
			convex,
			sandbox,
			record._id
		);
		return { spaceId: record._id, sandboxUrl };
	}

	if (state === "stopped" || state === "archived") {
		await convex.mutation(api.spaces.update, {
			id: record._id,
			status: "starting",
		});
		await sandbox.start();
		await bootSandboxAgent(sandbox);
		await convex.mutation(api.spaces.update, {
			id: record._id,
			status: "started",
		});
		const sandboxUrl = await generateAndStoreSandboxUrl(
			convex,
			sandbox,
			record._id
		);
		return { spaceId: record._id, sandboxUrl };
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
	spaceId: Id<"spaces">,
	anthropicApiKey: string
): Promise<{ spaceId: string; sandboxUrl: string }> {
	const sandbox = await createReadySandbox(daytona, anthropicApiKey);
	const sandboxUrl = await getPreviewUrl(sandbox);

	await convex.mutation(api.spaces.update, {
		id: spaceId,
		status: "started",
		sandboxId: sandbox.id,
		sandboxUrl,
	});

	return { spaceId, sandboxUrl };
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
								"Convex environment ID (required when spaceId is absent)",
						}),
						repositoryId: z.string().optional().openapi({
							description:
								"Convex repository ID (required when spaceId is absent)",
						}),
						spaceId: z.string().optional().openapi({
							description: "Convex space ID if one already exists",
						}),
					}),
				},
			},
			required: true,
			description: "Ensure a running sandbox exists for the given space",
		},
	},
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({
						spaceId: z.string().openapi({ description: "Convex space ID" }),
						sandboxUrl: z.string().optional().openapi({
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

export const spacesApp = $(
	new OpenAPIHono<SpacesEnv>().openapi(ensureRoute, async (c) => {
		const body = c.req.valid("json");
		const token = getBearerToken(c.req.header("Authorization"));
		const convex = createConvexClient(c.env.CONVEX_URL, token);
		const daytona = new Daytona({ apiKey: c.env.DAYTONA_API_KEY });

		let spaceId: Id<"spaces"> | undefined;

		try {
			let result: { spaceId: string; sandboxUrl: string | undefined };

			if (body.spaceId) {
				spaceId = body.spaceId as Id<"spaces">;
				result = await ensureExistingSandbox(
					convex,
					daytona,
					spaceId,
					c.env.ANTHROPIC_API_KEY
				);
			} else {
				if (!body.environmentId) {
					return c.json(
						{ error: "environmentId is required when spaceId is absent" },
						500
					);
				}

				spaceId = await convex.mutation(api.spaces.create, {
					environmentId: body.environmentId as Id<"environments">,
					branchName: "main",
				});

				result = await provisionDaytonaSandbox(
					convex,
					daytona,
					spaceId,
					c.env.ANTHROPIC_API_KEY
				);
			}

			return c.json(result, 200);
		} catch (error) {
			if (spaceId) {
				try {
					await convex.mutation(api.spaces.update, {
						id: spaceId,
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
