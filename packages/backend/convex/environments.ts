import { ConvexError, v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";

export const internalGet = internalQuery({
	args: { id: v.id("environments") },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.id);
	},
});

export const list = authedQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db
			.query("environments")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();
	},
});

export const get = authedQuery({
	args: { id: v.id("environments") },
	handler: async (ctx, args) => {
		const env = await ctx.db.get(args.id);
		if (!env || env.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}
		return env;
	},
});

export async function createEnvironment(
	ctx: MutationCtx,
	args: {
		userId: string;
		connectionId: string;
		name: string;
		status: "connected" | "disconnected";
		metadata?: Record<string, any>;
	}
) {
	const now = Date.now();
	return await ctx.db.insert("environments", {
		userId: args.userId,
		connectionId: args.connectionId,
		name: args.name,
		status: args.status,
		metadata: args.metadata,
		lastConnectedAt: args.status === "connected" ? now : undefined,
		createdAt: now,
		updatedAt: now,
	});
}

export const connect = internalMutation({
	args: {
		userId: v.string(),
		connectionId: v.string(),
		name: v.string(),
		metadata: v.optional(v.record(v.string(), v.any())),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("environments")
			.withIndex("by_user_and_connectionId", (q) =>
				q.eq("userId", args.userId).eq("connectionId", args.connectionId)
			)
			.unique();

		if (existing) {
			const now = Date.now();
			await ctx.db.patch(existing._id, {
				status: "connected",
				lastConnectedAt: now,
				updatedAt: now,
				error: undefined,
			});
			return existing._id;
		}

		return await createEnvironment(ctx, {
			userId: args.userId,
			connectionId: args.connectionId,
			name: args.name,
			status: "connected",
			metadata: args.metadata,
		});
	},
});

export const disconnect = internalMutation({
	args: { connectionId: v.string(), userId: v.string() },
	handler: async (ctx, args) => {
		const env = await ctx.db
			.query("environments")
			.withIndex("by_user_and_connectionId", (q) =>
				q.eq("userId", args.userId).eq("connectionId", args.connectionId)
			)
			.unique();

		if (!env) {
			throw new ConvexError("Environment not found");
		}

		await ctx.db.patch(env._id, {
			status: "disconnected",
			updatedAt: Date.now(),
		});
	},
});

export const rename = authedMutation({
	args: {
		id: v.id("environments"),
		name: v.string(),
	},
	handler: async (ctx, args) => {
		const env = await ctx.db.get(args.id);
		if (!env || env.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		const name = args.name.trim();
		if (!name) {
			throw new ConvexError("Name cannot be empty");
		}

		await ctx.db.patch(args.id, { name, updatedAt: Date.now() });
	},
});

const del = authedMutation({
	args: { id: v.id("environments") },
	handler: async (ctx, args) => {
		const env = await ctx.db.get(args.id);
		if (!env || env.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		await ctx.db.delete(args.id);
	},
});
export { del as delete };
