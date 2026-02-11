import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";

async function requireOwnedEnvironment(
	ctx: QueryCtx & { userId: string },
	id: Id<"environments">
): Promise<Doc<"environments">> {
	const environment = await ctx.db.get(id);
	if (!environment) {
		throw new ConvexError("Environment not found");
	}

	const repository = await ctx.db.get(environment.repositoryId);
	if (!repository || repository.userId !== ctx.userId) {
		throw new ConvexError("Environment not found");
	}

	return environment;
}

export const listByRepository = authedQuery({
	args: {
		repositoryId: v.id("repositories"),
	},
	handler: async (ctx, args) => {
		const repository = await ctx.db.get(args.repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Repository not found");
		}

		return await ctx.db
			.query("environments")
			.withIndex("by_repository", (q) =>
				q.eq("repositoryId", args.repositoryId)
			)
			.collect();
	},
});

export const update = authedMutation({
	args: {
		id: v.id("environments"),
		installCommand: v.optional(v.string()),
		devCommand: v.optional(v.string()),
		envVars: v.optional(
			v.array(v.object({ key: v.string(), value: v.string() }))
		),
	},
	handler: async (ctx, args) => {
		await requireOwnedEnvironment(ctx, args.id);
		await ctx.db.patch(args.id, {
			installCommand: args.installCommand,
			devCommand: args.devCommand,
			envVars: args.envVars,
			updatedAt: Date.now(),
		});
	},
});
