import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { $, createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { type AuthVariables, authMiddleware } from "./auth";
import {
	bootSandboxAgent,
	ensureSandboxAgentRunning,
	getPreviewUrl,
} from "./lib/sandbox";

type Space = FunctionReturnType<typeof api.spaces.getById>;

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

async function provisionSandbox(
	convex: ConvexHttpClient,
	daytona: Daytona,
	spaceId: Id<"spaces">,
	snapshotName: string,
	anthropicApiKey: string
): Promise<Sandbox> {
	await convex.mutation(api.spaces.update, {
		id: spaceId,
		status: "creating",
	});
	const sandbox = await daytona.create({
		snapshot: snapshotName,
		envVars: { ANTHROPIC_API_KEY: anthropicApiKey },
		autoStopInterval: 0,
	});
	await bootSandboxAgent(sandbox);
	return sandbox;
}

async function resolveSandbox(
	convex: ConvexHttpClient,
	daytona: Daytona,
	space: Space,
	anthropicApiKey: string
): Promise<Sandbox> {
	const { snapshotName } = space.environment.repository;

	if (!space.sandboxId) {
		return await provisionSandbox(
			convex,
			daytona,
			space._id,
			snapshotName,
			anthropicApiKey
		);
	}

	let sandbox: Sandbox;
	try {
		sandbox = await daytona.get(space.sandboxId);
	} catch {
		return await provisionSandbox(
			convex,
			daytona,
			space._id,
			snapshotName,
			anthropicApiKey
		);
	}

	const { state } = sandbox;

	if (state === "started") {
		await ensureSandboxAgentRunning(sandbox);
		return sandbox;
	}

	if (state === "stopped" || state === "archived") {
		await convex.mutation(api.spaces.update, {
			id: space._id,
			status: "starting",
		});
		await sandbox.start();
		await bootSandboxAgent(sandbox);
		return sandbox;
	}

	// error / unknown state — reprovision
	return await provisionSandbox(
		convex,
		daytona,
		space._id,
		snapshotName,
		anthropicApiKey
	);
}

async function ensureSandbox(
	convex: ConvexHttpClient,
	daytona: Daytona,
	spaceId: Id<"spaces">,
	anthropicApiKey: string
): Promise<{ spaceId: string; sandboxUrl: string }> {
	const space = await convex.query(api.spaces.getById, {
		id: spaceId,
	});

	const sandbox = await resolveSandbox(convex, daytona, space, anthropicApiKey);

	const sandboxUrl = await getPreviewUrl(sandbox);

	await convex.mutation(api.spaces.update, {
		id: space._id,
		status: "started",
		sandboxId: sandbox.id,
		sandboxUrl,
	});

	return { spaceId: space._id, sandboxUrl };
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
						sandboxUrl: z.string().openapi({
							description: "Preview URL to the sandbox-agent server",
						}),
					}),
				},
			},
			description: "Sandbox is running and ready",
		},
		400: {
			content: {
				"application/json": { schema: ErrorResponseSchema },
			},
			description: "Invalid request parameters",
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
			if (body.spaceId) {
				spaceId = body.spaceId as Id<"spaces">;
			} else {
				if (!body.environmentId) {
					return c.json(
						{ error: "environmentId is required when spaceId is absent" },
						400
					);
				}
				spaceId = await convex.mutation(api.spaces.create, {
					environmentId: body.environmentId as Id<"environments">,
					branchName: "main",
				});
			}

			const result = await ensureSandbox(
				convex,
				daytona,
				spaceId,
				c.env.ANTHROPIC_API_KEY
			);

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
