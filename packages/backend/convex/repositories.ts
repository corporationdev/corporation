import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import { createEnvironmentHelper } from "./environments";
import { authedMutation, authedQuery } from "./functions";
import { normalizeEnvByPath } from "./lib/envByPath";

function requireOwnedRepository(
	userId: string,
	repo: Doc<"repositories">
): Doc<"repositories"> {
	if (repo.userId !== userId) {
		throw new ConvexError("Repository not found");
	}
	return repo;
}

export const list = authedQuery({
	args: {},
	handler: async (ctx) => {
		const repos = await ctx.db
			.query("repositories")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		return Promise.all(
			repos.map(async (repo) => {
				const defaultEnv = await ctx.db
					.query("environments")
					.withIndex("by_repository", (q) => q.eq("repositoryId", repo._id))
					.first();

				return {
					...repo,
					defaultEnvironment: defaultEnv,
				};
			})
		);
	},
});

export const get = authedQuery({
	args: { id: v.id("repositories") },
	handler: async (ctx, args) => {
		const repo = await ctx.db.get(args.id);
		if (!repo) {
			throw new ConvexError("Repository not found");
		}
		requireOwnedRepository(ctx.userId, repo);

		const environments = await ctx.db
			.query("environments")
			.withIndex("by_repository", (q) => q.eq("repositoryId", args.id))
			.collect();
		environments.sort((a, b) => a.createdAt - b.createdAt);

		const defaultEnvironment = environments[0] ?? null;

		return { ...repo, environments, defaultEnvironment };
	},
});

export const create = authedMutation({
	args: {
		githubRepoId: v.number(),
		owner: v.string(),
		name: v.string(),
		defaultBranch: v.string(),
		environmentConfig: v.object({
			name: v.optional(v.string()),
			setupCommand: v.string(),
			devCommand: v.string(),
			envByPath: v.optional(
				v.record(v.string(), v.record(v.string(), v.string()))
			),
		}),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("repositories")
			.withIndex("by_user_and_github_repo", (q) =>
				q.eq("userId", ctx.userId).eq("githubRepoId", args.githubRepoId)
			)
			.first();

		if (existing) {
			throw new ConvexError("Repository already connected");
		}

		const now = Date.now();
		const normalizedEnvByPath = normalizeEnvByPath(
			args.environmentConfig.envByPath
		);

		const repositoryId = await ctx.db.insert("repositories", {
			userId: ctx.userId,
			githubRepoId: args.githubRepoId,
			owner: args.owner,
			name: args.name,
			defaultBranch: args.defaultBranch,
			createdAt: now,
			updatedAt: now,
		});

		await createEnvironmentHelper(ctx, {
			repositoryId,
			name: args.environmentConfig.name ?? "Default",
			setupCommand: args.environmentConfig.setupCommand,
			devCommand: args.environmentConfig.devCommand,
			envByPath: normalizedEnvByPath,
		});

		return repositoryId;
	},
});

export const update = authedMutation({
	args: {
		id: v.id("repositories"),
		defaultBranch: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const repo = await ctx.db.get(args.id);
		if (!repo) {
			throw new ConvexError("Repository not found");
		}
		requireOwnedRepository(ctx.userId, repo);

		const patch: { defaultBranch?: string; updatedAt: number } = {
			updatedAt: Date.now(),
		};
		if (args.defaultBranch !== undefined) {
			patch.defaultBranch = args.defaultBranch;
		}

		await ctx.db.patch(args.id, patch);
	},
});

const del = authedMutation({
	args: {
		id: v.id("repositories"),
	},
	handler: async (ctx, args) => {
		const repo = await ctx.db.get(args.id);
		if (!repo) {
			throw new ConvexError("Repository not found");
		}
		requireOwnedRepository(ctx.userId, repo);

		const environments = await ctx.db
			.query("environments")
			.withIndex("by_repository", (q) => q.eq("repositoryId", args.id))
			.collect();

		for (const env of environments) {
			await ctx.db.delete(env._id);
		}

		await ctx.db.delete(args.id);
	},
});
export { del as delete };

export const internalGetByGithubRepoId = internalQuery({
	args: { githubRepoId: v.number() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("repositories")
			.withIndex("by_github_repo", (q) =>
				q.eq("githubRepoId", args.githubRepoId)
			)
			.collect();
	},
});
