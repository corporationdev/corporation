import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { $, createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Nango } from "@nangohq/node";
import { ConvexHttpClient } from "convex/browser";
import { type AuthVariables, authMiddleware } from "./auth";
import { getGitHubToken } from "./lib/github";
import {
	bootSandboxAgent,
	cloneRepoIntoSandbox,
	createReadySandbox,
	ensureSandboxAgentRunning,
	getPreviewUrl,
	pullRepoInSandbox,
	type RepoInfo,
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

type GitCredentials = {
	githubToken: string;
	repoInfo: RepoInfo;
};

async function ensureExistingSandbox(
	convex: ConvexHttpClient,
	daytona: Daytona,
	spaceId: Id<"spaces">,
	anthropicApiKey: string,
	git: GitCredentials
): Promise<{ spaceId: string; sandboxUrl: string }> {
	const record = await convex.query(api.spaces.getById, {
		id: spaceId,
	});

	if (!record.sandboxId) {
		return await provisionDaytonaSandbox(
			convex,
			daytona,
			record._id,
			anthropicApiKey,
			git
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
			anthropicApiKey,
			git
		);
	}

	const state = sandbox.state;

	if (state === "started") {
		await ensureSandboxAgentRunning(sandbox);
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
		anthropicApiKey,
		git
	);
}

async function provisionDaytonaSandbox(
	convex: ConvexHttpClient,
	daytona: Daytona,
	spaceId: Id<"spaces">,
	anthropicApiKey: string,
	git: GitCredentials
): Promise<{ spaceId: string; sandboxUrl: string }> {
	const sandbox = await createReadySandbox(daytona, anthropicApiKey);
	await cloneRepoIntoSandbox(sandbox, git.githubToken, git.repoInfo);
	const sandboxUrl = await getPreviewUrl(sandbox);

	await convex.mutation(api.spaces.update, {
		id: spaceId,
		status: "started",
		sandboxId: sandbox.id,
		sandboxUrl,
	});

	return { spaceId, sandboxUrl };
}

async function resolveGitCredentials(
	convex: ConvexHttpClient,
	nango: Nango,
	userId: string,
	spaceId: Id<"spaces">
): Promise<GitCredentials> {
	const [repoInfo, githubToken] = await Promise.all([
		convex.query(api.spaces.getRepoInfo, { id: spaceId }),
		getGitHubToken(nango, userId),
	]);
	return { githubToken, repoInfo };
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
// POST /pull — Pull latest changes into a sandbox
// ---------------------------------------------------------------------------

const pullRoute = createRoute({
	method: "post",
	path: "/pull",
	middleware: [authMiddleware],
	request: {
		body: {
			content: {
				"application/json": {
					schema: z.object({
						spaceId: z
							.string()
							.openapi({ description: "Convex space ID to pull into" }),
					}),
				},
			},
			required: true,
			description: "Pull latest changes from the remote repository",
		},
	},
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({
						success: z
							.boolean()
							.openapi({ description: "Whether the pull succeeded" }),
					}),
				},
			},
			description: "Pull completed successfully",
		},
		500: {
			content: {
				"application/json": { schema: ErrorResponseSchema },
			},
			description: "Failed to pull",
		},
	},
});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export const spacesApp = $(
	new OpenAPIHono<SpacesEnv>()
		.openapi(ensureRoute, async (c) => {
			const body = c.req.valid("json");
			const { sub: userId } = c.get("jwtPayload");
			const token = getBearerToken(c.req.header("Authorization"));
			const convex = createConvexClient(c.env.CONVEX_URL, token);
			const daytona = new Daytona({ apiKey: c.env.DAYTONA_API_KEY });
			const nango = new Nango({ secretKey: c.env.NANGO_SECRET_KEY });

			let spaceId: Id<"spaces"> | undefined;

			try {
				let result: { spaceId: string; sandboxUrl: string };

				if (body.spaceId) {
					spaceId = body.spaceId as Id<"spaces">;
					const git = await resolveGitCredentials(
						convex,
						nango,
						userId,
						spaceId
					);
					result = await ensureExistingSandbox(
						convex,
						daytona,
						spaceId,
						c.env.ANTHROPIC_API_KEY,
						git
					);
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

					const git = await resolveGitCredentials(
						convex,
						nango,
						userId,
						spaceId
					);
					result = await provisionDaytonaSandbox(
						convex,
						daytona,
						spaceId,
						c.env.ANTHROPIC_API_KEY,
						git
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
				const message =
					error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: `Sandbox ensure failed: ${message}` }, 500);
			}
		})
		.openapi(pullRoute, async (c) => {
			const { spaceId: rawSpaceId } = c.req.valid("json");
			const { sub: userId } = c.get("jwtPayload");
			const token = getBearerToken(c.req.header("Authorization"));
			const convex = createConvexClient(c.env.CONVEX_URL, token);
			const daytona = new Daytona({ apiKey: c.env.DAYTONA_API_KEY });
			const nango = new Nango({ secretKey: c.env.NANGO_SECRET_KEY });

			try {
				const spaceId = rawSpaceId as Id<"spaces">;
				const space = await convex.query(api.spaces.getById, { id: spaceId });

				if (!space.sandboxId) {
					throw new Error("Space has no active sandbox");
				}

				const sandbox = await daytona.get(space.sandboxId);
				const githubToken = await getGitHubToken(nango, userId);

				await pullRepoInSandbox(sandbox, githubToken);

				return c.json({ success: true }, 200);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: `Pull failed: ${message}` }, 500);
			}
		})
);
