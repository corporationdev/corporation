import { $, createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Nango } from "@nangohq/node";
import { createMiddleware } from "hono/factory";
import { Octokit } from "octokit";
import { type AuthVariables, authMiddleware } from "./auth";

const GITHUB_PROVIDER_KEY = "github";

type GitHubVariables = AuthVariables & {
	octokit: Octokit;
};

type GitHubEnv = {
	Bindings: Env;
	Variables: GitHubVariables;
};

const githubMiddleware = createMiddleware<GitHubEnv>(async (c, next) => {
	const { sub: userId } = c.get("jwtPayload");
	const nango = new Nango({ secretKey: c.env.NANGO_SECRET_KEY });
	const { connections } = await nango.listConnections({ userId });

	const conn = connections.find(
		(connection) => connection.provider_config_key === GITHUB_PROVIDER_KEY
	);

	if (!conn) {
		return c.json({ error: "No GitHub connection found" }, 401);
	}

	const token = await nango.getToken(GITHUB_PROVIDER_KEY, conn.connection_id);

	if (typeof token !== "string") {
		return c.json({ error: "Unexpected token format" }, 500);
	}

	c.set("octokit", new Octokit({ auth: token }));
	await next();
});

// ---------------------------------------------------------------------------
// GET / - List GitHub repositories
// ---------------------------------------------------------------------------

const listGitHubReposRoute = createRoute({
	method: "get",
	path: "/",
	middleware: [authMiddleware, githubMiddleware],
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
// App
// ---------------------------------------------------------------------------

export const githubApp = $(
	new OpenAPIHono<GitHubEnv>().openapi(listGitHubReposRoute, async (c) => {
		const octokit = c.get("octokit");

		try {
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
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: message }, 500);
		}
	})
);
