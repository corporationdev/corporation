import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";

async function requireOwnedRepository(
	ctx: MutationCtx,
	userId: string,
	id: Id<"repositories">
): Promise<Doc<"repositories">> {
	const repo = await ctx.db.get(id);
	if (!repo || repo.userId !== userId) {
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
		installCommand: v.optional(v.string()),
		devCommand: v.optional(v.string()),
		envVars: v.optional(
			v.array(v.object({ key: v.string(), value: v.string() }))
		),
	},
	handler: async (ctx, args) => {
		const now = Date.now();

		return await ctx.db.insert("repositories", {
			userId: ctx.userId,
			githubRepoId: args.githubRepoId,
			owner: args.owner,
			name: args.name,
			defaultBranch: args.defaultBranch,
			installCommand: args.installCommand,
			devCommand: args.devCommand,
			envVars: args.envVars,
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const update = authedMutation({
	args: {
		id: v.id("repositories"),
		installCommand: v.optional(v.string()),
		devCommand: v.optional(v.string()),
		envVars: v.optional(
			v.array(v.object({ key: v.string(), value: v.string() }))
		),
	},
	handler: async (ctx, args) => {
		await requireOwnedRepository(ctx, ctx.userId, args.id);
		await ctx.db.patch(args.id, {
			installCommand: args.installCommand,
			devCommand: args.devCommand,
			envVars: args.envVars,
			updatedAt: Date.now(),
		});
	},
});

export const remove = authedMutation({
	args: {
		id: v.id("repositories"),
	},
	handler: async (ctx, args) => {
		await requireOwnedRepository(ctx, ctx.userId, args.id);
		await ctx.db.delete(args.id);
	},
});
