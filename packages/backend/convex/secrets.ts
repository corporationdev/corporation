import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { VALID_SECRET_NAMES } from "./lib/validSecrets";

export const list = authedQuery({
	args: {},
	handler: async (ctx) => {
		const keys = await ctx.db
			.query("secrets")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		return keys
			.filter((key) => VALID_SECRET_NAMES.has(key.name))
			.map((key) => ({
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
		if (!VALID_SECRET_NAMES.has(args.name)) {
			throw new ConvexError(
				`Invalid secret name: ${args.name}. Allowed: ${[...VALID_SECRET_NAMES].join(", ")}`
			);
		}

		await ctx.scheduler.runAfter(0, internal.secretActions.encryptAndStore, {
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
			.query("secrets")
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
			await ctx.db.insert("secrets", {
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
			.query("secrets")
			.withIndex("by_user_and_name", (q) =>
				q.eq("userId", ctx.userId).eq("name", args.name)
			)
			.unique();

		if (!existing) {
			throw new ConvexError("Secret not found");
		}

		await ctx.db.delete(existing._id);
	},
});

export const removeInternal = internalMutation({
	args: {
		id: v.id("secrets"),
	},
	handler: async (ctx, args) => {
		await ctx.db.delete(args.id);
	},
});

export const getByUser = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("secrets")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.collect();
	},
});

export const getByUserAndName = internalQuery({
	args: { userId: v.string(), name: v.string() },
	handler: async (ctx, args) => {
		if (!VALID_SECRET_NAMES.has(args.name)) {
			return null;
		}

		return await ctx.db
			.query("secrets")
			.withIndex("by_user_and_name", (q) =>
				q.eq("userId", args.userId).eq("name", args.name)
			)
			.unique();
	},
});
