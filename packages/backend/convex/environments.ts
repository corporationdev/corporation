import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { authedQuery } from "./functions";

export const verifyInternalApiKey = internalAction({
	args: { apiKey: v.string() },
	handler: async (_ctx, args) => {
		const expected = process.env.CORPORATION_INTERNAL_API_KEY?.trim();
		if (!expected) {
			throw new Error("CORPORATION_INTERNAL_API_KEY is not configured");
		}
		if (args.apiKey !== expected) {
			throw new Error("Unauthorized");
		}
	},
});

export const connectAction = internalAction({
	args: {
		apiKey: v.string(),
		userId: v.string(),
		clientId: v.string(),
		name: v.string(),
		metadata: v.optional(v.record(v.string(), v.string())),
	},
	handler: async (ctx, args): Promise<string> => {
		await ctx.runAction(internal.environments.verifyInternalApiKey, {
			apiKey: args.apiKey,
		});
		const { apiKey: _, ...mutationArgs } = args;
		return await ctx.runMutation(internal.environments.connect, mutationArgs);
	},
});

export const disconnectAction = internalAction({
	args: {
		apiKey: v.string(),
		userId: v.string(),
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		await ctx.runAction(internal.environments.verifyInternalApiKey, {
			apiKey: args.apiKey,
		});
		await ctx.runMutation(internal.environments.disconnect, {
			userId: args.userId,
			clientId: args.clientId,
		});
	},
});

export const connect = internalMutation({
	args: {
		userId: v.string(),
		clientId: v.string(),
		name: v.string(),
		metadata: v.optional(v.record(v.string(), v.string())),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("environments")
			.withIndex("by_user_and_clientId", (q) =>
				q.eq("userId", args.userId).eq("clientId", args.clientId)
			)
			.unique();

		const now = Date.now();

		if (existing) {
			await ctx.db.patch(existing._id, {
				status: "connected",
				name: args.name,
				metadata: args.metadata,
				lastConnectedAt: now,
				updatedAt: now,
				error: undefined,
			});
			return existing._id;
		}

		return await ctx.db.insert("environments", {
			userId: args.userId,
			clientId: args.clientId,
			name: args.name,
			status: "connected",
			metadata: args.metadata,
			lastConnectedAt: now,
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const disconnect = internalMutation({
	args: {
		userId: v.string(),
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("environments")
			.withIndex("by_user_and_clientId", (q) =>
				q.eq("userId", args.userId).eq("clientId", args.clientId)
			)
			.unique();

		if (!existing) {
			return;
		}

		await ctx.db.patch(existing._id, {
			status: "disconnected",
			updatedAt: Date.now(),
		});
	},
});

export const listForUser = authedQuery({
	args: {},
	handler: async (ctx) => {
		const environments = await ctx.db
			.query("environments")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		environments.sort((a, b) => b.updatedAt - a.updatedAt);
		return environments;
	},
});
