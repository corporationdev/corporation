import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { authComponent } from "./auth";

async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
	const authUser = await authComponent.safeGetAuthUser(ctx);
	if (!authUser) {
		throw new ConvexError("Unauthenticated");
	}
	return authUser._id;
}

async function requireOwnedSession(
	ctx: MutationCtx,
	userId: string,
	id: Id<"agentSessions">
): Promise<Doc<"agentSessions">> {
	const session = await ctx.db.get(id);
	if (!session || session.userId !== userId) {
		throw new ConvexError("Agent session not found");
	}
	return session;
}

export const list = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		return await ctx.db
			.query("agentSessions")
			.withIndex("by_user_and_updated", (q) => q.eq("userId", userId))
			.order("desc")
			.collect();
	},
});

export const create = mutation({
	args: {
		title: v.string(),
	},
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const now = Date.now();

		return await ctx.db.insert("agentSessions", {
			title: args.title,
			userId,
			createdAt: now,
			updatedAt: now,
			archivedAt: null,
		});
	},
});

export const update = mutation({
	args: {
		id: v.id("agentSessions"),
		title: v.optional(v.string()),
		archivedAt: v.optional(v.union(v.number(), v.null())),
	},
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		await requireOwnedSession(ctx, userId, args.id);

		const patch: Partial<Doc<"agentSessions">> = {
			updatedAt: Date.now(),
		};

		if (args.title !== undefined) {
			patch.title = args.title;
		}

		if (args.archivedAt !== undefined) {
			patch.archivedAt = args.archivedAt;
		}

		await ctx.db.patch(args.id, patch);
		return await ctx.db.get(args.id);
	},
});

export const touch = mutation({
	args: {
		id: v.id("agentSessions"),
	},
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		await requireOwnedSession(ctx, userId, args.id);

		await ctx.db.patch(args.id, {
			updatedAt: Date.now(),
			archivedAt: null,
		});

		return { success: true };
	},
});

export const remove = mutation({
	args: {
		id: v.id("agentSessions"),
	},
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		await requireOwnedSession(ctx, userId, args.id);

		await ctx.db.delete(args.id);
		return { success: true };
	},
});
