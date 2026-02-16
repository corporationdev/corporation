import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { authedMutation, authedQuery } from "./functions";

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
		return await ctx.db
			.query("repositories")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();
	},
});

export const create = authedMutation({
	args: {
		githubRepoId: v.number(),
		owner: v.string(),
		name: v.string(),
		defaultBranch: v.string(),
		installCommand: v.string(),
		devCommand: v.string(),
		envVars: v.optional(
			v.array(v.object({ key: v.string(), value: v.string() }))
		),
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

		const repositoryId = await ctx.db.insert("repositories", {
			userId: ctx.userId,
			githubRepoId: args.githubRepoId,
			owner: args.owner,
			name: args.name,
			defaultBranch: args.defaultBranch,
			installCommand: args.installCommand,
			createdAt: now,
			updatedAt: now,
		});

		await ctx.db.insert("environments", {
			repositoryId,
			name: "Default",
			devCommand: args.devCommand,
			envVars: args.envVars,
			createdAt: now,
			updatedAt: now,
		});

		return repositoryId;
	},
});

export const update = authedMutation({
	args: {
		id: v.id("repositories"),
		installCommand: v.string(),
	},
	handler: async (ctx, args) => {
		const repo = await ctx.db.get(args.id);
		if (!repo) {
			throw new ConvexError("Repository not found");
		}
		requireOwnedRepository(ctx.userId, repo);
		await ctx.db.patch(args.id, {
			installCommand: args.installCommand,
			updatedAt: Date.now(),
		});
	},
});

export const remove = authedMutation({
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
