import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalQuery } from "./_generated/server";
import { authedQuery } from "./functions";

export const internalGet = internalQuery({
	args: { id: v.id("backings") },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.id);
	},
});

export async function createBacking(
	ctx: MutationCtx,
	args: {
		spaceId: Id<"spaces">;
		environmentId: Id<"environments">;
	}
) {
	const now = Date.now();
	const backingId = await ctx.db.insert("backings", {
		spaceId: args.spaceId,
		environmentId: args.environmentId,
		createdAt: now,
		updatedAt: now,
	});

	await ctx.db.patch(args.spaceId, {
		activeBackingId: backingId,
		updatedAt: now,
	});

	return backingId;
}

export async function getActiveBacking(
	ctx: Pick<QueryCtx, "db">,
	spaceId: Id<"spaces">
) {
	const space = await ctx.db.get(spaceId);
	if (!space?.activeBackingId) {
		return null;
	}
	return await ctx.db.get(space.activeBackingId);
}

export const getForSpace = authedQuery({
	args: { spaceId: v.id("spaces") },
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.spaceId);
		if (!space || space.userId !== ctx.userId) {
			throw new ConvexError("Space not found");
		}
		if (!space.activeBackingId) {
			return null;
		}
		const backing = await ctx.db.get(space.activeBackingId);
		if (!backing) {
			return null;
		}
		const environment = await ctx.db.get(backing.environmentId);
		return { backing, environment };
	},
});

export const listForEnvironment = authedQuery({
	args: { environmentId: v.id("environments") },
	handler: async (ctx, args) => {
		const env = await ctx.db.get(args.environmentId);
		if (!env || env.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		return await ctx.db
			.query("backings")
			.withIndex("by_environment", (q) =>
				q.eq("environmentId", args.environmentId)
			)
			.collect();
	},
});
