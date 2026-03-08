import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";

export const list = authedQuery({
	args: {},
	handler: async (ctx) => {
		const keys = await ctx.db
			.query("apiKeys")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		return keys.map((key) => ({
			name: key.name,
			hint: key.hint,
			createdAt: key.createdAt,
		}));
	},
});

export const upsert = authedMutation({
	args: {
		name: v.string(),
		apiKey: v.string(),
	},
	handler: async (ctx, args) => {
		await ctx.scheduler.runAfter(0, internal.apiKeyActions.encryptAndStore, {
			userId: ctx.userId,
			name: args.name,
			apiKey: args.apiKey,
		});
	},
});

export const upsertInternal = internalMutation({
	args: {
		userId: v.string(),
		name: v.string(),
		encryptedKey: v.string(),
		iv: v.string(),
		hint: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("apiKeys")
			.withIndex("by_user_and_name", (q) =>
				q.eq("userId", args.userId).eq("name", args.name)
			)
			.unique();

		const now = Date.now();

		if (existing) {
			await ctx.db.patch(existing._id, {
				encryptedKey: args.encryptedKey,
				iv: args.iv,
				hint: args.hint,
				updatedAt: now,
			});
		} else {
			await ctx.db.insert("apiKeys", {
				userId: args.userId,
				name: args.name,
				encryptedKey: args.encryptedKey,
				iv: args.iv,
				hint: args.hint,
				createdAt: now,
				updatedAt: now,
			});
		}
	},
});

export const remove = authedMutation({
	args: {
		name: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("apiKeys")
			.withIndex("by_user_and_name", (q) =>
				q.eq("userId", ctx.userId).eq("name", args.name)
			)
			.unique();

		if (!existing) {
			throw new ConvexError("API key not found");
		}

		await ctx.db.delete(existing._id);
	},
});

export const getByUser = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("apiKeys")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.collect();
	},
});
