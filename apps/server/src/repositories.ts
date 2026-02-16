import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { Daytona } from "@daytonaio/sdk";
import { $, createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Nango } from "@nangohq/node";
import { ConvexHttpClient } from "convex/browser";
import { Octokit } from "octokit";
import { type AuthVariables, authMiddleware } from "./auth";
import { buildRepoSnapshot, deleteSnapshot } from "./lib/snapshots";

type RepositoriesEnv = {
	Bindings: Env;
	Variables: AuthVariables;
};

const GITHUB_PROVIDER_KEY = "github";

async function getGitHubToken(nango: Nango, userId: string): Promise<string> {
	const { connections } = await nango.listConnections({ userId });

	const conn = connections.find(
		(c) => c.provider_config_key === GITHUB_PROVIDER_KEY
	);

	if (!conn) {
		throw new Error("No GitHub connection found for this user");
	}

	const token = await nango.getToken(GITHUB_PROVIDER_KEY, conn.connection_id);

	if (typeof token !== "string") {
		throw new Error("Unexpected token format for GitHub connection");
	}

	return token;
}

// ---------------------------------------------------------------------------
// GET /github - List GitHub repositories available to connect
// ---------------------------------------------------------------------------

const listGitHubReposRoute = createRoute({
	method: "get",
	path: "/github",
	middleware: [authMiddleware],
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({
						repositories: z.array(
							z.object({
								id: z.number(),
								name: z.string(),
								fullName: z.string(),
								owner: z.string(),
								defaultBranch: z.string(),
								private: z.boolean(),
								url: z.string(),
							})
						),
					}),
				},
			},
			description: "List of GitHub repositories",
		},
		500: {
			content: {
				"application/json": {
					schema: z.object({ error: z.string() }),
				},
			},
			description: "Failed to list repositories",
		},
	},
});

// ---------------------------------------------------------------------------
// POST /connect - Connect a repository and build its snapshot
// ---------------------------------------------------------------------------

const connectRoute = createRoute({
	method: "post",
	path: "/connect",
	middleware: [authMiddleware],
	request: {
		body: {
			content: {
				"application/json": {
					schema: z.object({
						githubRepoId: z.number(),
						owner: z.string(),
						name: z.string(),
						defaultBranch: z.string(),
						installCommand: z.string(),
						services: z.array(
							z.object({
								name: z.string(),
								devCommand: z.string(),
								cwd: z.string().optional(),
								envVars: z
									.array(z.object({ key: z.string(), value: z.string() }))
									.optional(),
							})
						),
					}),
				},
			},
			required: true,
			description: "Connect a GitHub repository and build its Daytona snapshot",
		},
	},
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({
						repositoryId: z
							.string()
							.openapi({ description: "Convex repository ID" }),
					}),
				},
			},
			description: "Repository connected successfully",
		},
		500: {
			content: {
				"application/json": {
					schema: z.object({ error: z.string() }),
				},
			},
			description: "Failed to connect repository",
		},
	},
});

// ---------------------------------------------------------------------------
// DELETE /:id - Delete a repository and its snapshot
// ---------------------------------------------------------------------------

const deleteRoute = createRoute({
	method: "delete",
	path: "/:id",
	middleware: [authMiddleware],
	request: {
		params: z.object({
			id: z.string().openapi({ description: "Convex repository ID" }),
		}),
	},
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({ success: z.boolean() }),
				},
			},
			description: "Repository and snapshot deleted",
		},
		500: {
			content: {
				"application/json": {
					schema: z.object({ error: z.string() }),
				},
			},
			description: "Failed to delete repository",
		},
	},
});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export const repositoriesApp = $(
	new OpenAPIHono<RepositoriesEnv>()
		.openapi(connectRoute, async (c) => {
			const body = c.req.valid("json");
			const { sub: userId } = c.get("jwtPayload");
			const token = c.req.header("Authorization")?.slice(7) ?? "";
			const convex = new ConvexHttpClient(c.env.CONVEX_URL);
			convex.setAuth(token);

			try {
				const nango = new Nango({ secretKey: c.env.NANGO_SECRET_KEY });
				const daytona = new Daytona({ apiKey: c.env.DAYTONA_API_KEY });
				const githubToken = await getGitHubToken(nango, userId);

				const snapshotName = await buildRepoSnapshot(
					daytona,
					body,
					githubToken
				);

				const repositoryId = await convex.mutation(api.repositories.create, {
					...body,
					snapshotName,
				});

				return c.json({ repositoryId }, 200);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				console.error(message);
				return c.json({ error: message }, 500);
			}
		})
		.openapi(deleteRoute, async (c) => {
			const { id } = c.req.valid("param");
			const token = c.req.header("Authorization")?.slice(7) ?? "";
			const convex = new ConvexHttpClient(c.env.CONVEX_URL);
			convex.setAuth(token);

			try {
				const repo = await convex.query(api.repositories.get, {
					id: id as Id<"repositories">,
				});

				const daytona = new Daytona({ apiKey: c.env.DAYTONA_API_KEY });
				await deleteSnapshot(daytona, repo.snapshotName);

				await convex.mutation(api.repositories.delete, {
					id: id as Id<"repositories">,
				});

				return c.json({ success: true }, 200);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: message }, 500);
			}
		})
		.openapi(listGitHubReposRoute, async (c) => {
			const { sub: userId } = c.get("jwtPayload");
			const nango = new Nango({ secretKey: c.env.NANGO_SECRET_KEY });

			try {
				const token = await getGitHubToken(nango, userId);
				const octokit = new Octokit({ auth: token });

				const repos = await octokit.paginate(
					octokit.rest.repos.listForAuthenticatedUser,
					{
						per_page: 100,
						visibility: "all",
						affiliation: "owner,collaborator,organization_member",
						sort: "updated",
						direction: "desc",
					}
				);

				return c.json(
					{
						repositories: repos.map((repo) => ({
							id: repo.id,
							name: repo.name,
							fullName: repo.full_name,
							owner: repo.owner.login,
							defaultBranch: repo.default_branch,
							private: repo.private,
							url: repo.html_url,
						})),
					},
					200
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: message }, 500);
			}
		})
);
