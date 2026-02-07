import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";

const agentSessionValidator = v.object({
	_id: v.id("agentSessions"),
	_creationTime: v.number(),
	title: v.string(),
	userId: v.string(),
	createdAt: v.number(),
	updatedAt: v.number(),
	archivedAt: v.union(v.number(), v.null()),
});

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

export const list = authedQuery({
	args: {},
	returns: v.array(agentSessionValidator),
	handler: async (ctx) => {
		return await ctx.db
			.query("agentSessions")
			.withIndex("by_user_and_updated", (q) => q.eq("userId", ctx.userId))
			.order("desc")
			.collect();
	},
});

export const create = authedMutation({
	args: {
		title: v.string(),
	},
	returns: v.id("agentSessions"),
	handler: async (ctx, args) => {
		const now = Date.now();

		return await ctx.db.insert("agentSessions", {
			title: args.title,
			userId: ctx.userId,
			createdAt: now,
			updatedAt: now,
			archivedAt: null,
		});
	},
});

export const update = authedMutation({
	args: {
		id: v.id("agentSessions"),
		title: v.optional(v.string()),
		archivedAt: v.optional(v.union(v.number(), v.null())),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireOwnedSession(ctx, ctx.userId, args.id);

		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries({ ...fields, updatedAt: Date.now() }).filter(
				([, v]) => v !== undefined
			)
		);

		await ctx.db.patch(id, patch);
		return null;
	},
});

export const touch = authedMutation({
	args: {
		id: v.id("agentSessions"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireOwnedSession(ctx, ctx.userId, args.id);

		await ctx.db.patch(args.id, {
			updatedAt: Date.now(),
			archivedAt: null,
		});

		return null;
	},
});

export const remove = authedMutation({
	args: {
		id: v.id("agentSessions"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireOwnedSession(ctx, ctx.userId, args.id);

		await ctx.db.delete(args.id);
		return null;
	},
});
