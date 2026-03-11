import { $, createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { type AuthVariables, authMiddleware } from "./auth";
import { listGitHubRepos } from "./services/github";

// ---------------------------------------------------------------------------
// GET / - List GitHub repositories
// ---------------------------------------------------------------------------

const listGitHubReposRoute = createRoute({
	method: "get",
	path: "/",
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
		401: {
			content: {
				"application/json": {
					schema: z.object({ error: z.string() }),
				},
			},
			description: "No GitHub connection found",
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
	new OpenAPIHono<{
		Bindings: Env;
		Variables: AuthVariables;
	}>().openapi(listGitHubReposRoute, async (c) => {
		try {
			return c.json(await listGitHubRepos(c.env, c.get("jwtPayload").sub), 200);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{ error: message },
				message === "No GitHub connection found" ? 401 : 500
			);
		}
	})
);
