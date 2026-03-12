import { v } from "convex/values";
import { authedQuery } from "./functions";
import { internalMutation, internalQuery } from "./_generated/server";

export const list = authedQuery({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db
			.query("agentCredentials")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		rows.sort((a, b) => b.updatedAt - a.updatedAt);

		return rows.map((row) => ({
			agentId: row.agentId,
			schemaVersion: row.schemaVersion,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			lastSyncedAt: row.lastSyncedAt ?? null,
			hasCredentials: true,
		}));
	},
});

export const getMetadata = authedQuery({
	args: {
		agentId: v.string(),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("agentCredentials")
			.withIndex("by_user_and_agent", (q) =>
				q.eq("userId", ctx.userId).eq("agentId", args.agentId)
			)
			.unique();

		if (!row) {
			return null;
		}

		return {
			agentId: row.agentId,
			schemaVersion: row.schemaVersion,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			lastSyncedAt: row.lastSyncedAt ?? null,
			hasCredentials: true,
		};
	},
});

export const listByUser = internalQuery({
	args: {
		userId: v.string(),
	},
	handler: async (ctx, args) =>
		await ctx.db
			.query("agentCredentials")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.collect(),
});

export const getByUserAndAgent = internalQuery({
	args: {
		userId: v.string(),
		agentId: v.string(),
	},
	handler: async (ctx, args) =>
		await ctx.db
			.query("agentCredentials")
			.withIndex("by_user_and_agent", (q) =>
				q.eq("userId", args.userId).eq("agentId", args.agentId)
			)
			.unique(),
});

export const upsertInternal = internalMutation({
	args: {
		userId: v.string(),
		agentId: v.string(),
		encryptedBundle: v.string(),
		iv: v.string(),
		schemaVersion: v.number(),
		lastSyncedAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("agentCredentials")
			.withIndex("by_user_and_agent", (q) =>
				q.eq("userId", args.userId).eq("agentId", args.agentId)
			)
			.unique();

		const now = Date.now();

		if (existing) {
			await ctx.db.patch(existing._id, {
				encryptedBundle: args.encryptedBundle,
				iv: args.iv,
				schemaVersion: args.schemaVersion,
				lastSyncedAt: args.lastSyncedAt,
				updatedAt: now,
			});
			return existing._id;
		}

		return await ctx.db.insert("agentCredentials", {
			userId: args.userId,
			agentId: args.agentId,
			encryptedBundle: args.encryptedBundle,
			iv: args.iv,
			schemaVersion: args.schemaVersion,
			lastSyncedAt: args.lastSyncedAt,
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const removeByUserAndAgentInternal = internalMutation({
	args: {
		userId: v.string(),
		agentId: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("agentCredentials")
			.withIndex("by_user_and_agent", (q) =>
				q.eq("userId", args.userId).eq("agentId", args.agentId)
			)
			.unique();

		if (!existing) {
			return;
		}

		await ctx.db.delete(existing._id);
	},
});

export const markSyncedInternal = internalMutation({
	args: {
		userId: v.string(),
		agentId: v.string(),
		syncedAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("agentCredentials")
			.withIndex("by_user_and_agent", (q) =>
				q.eq("userId", args.userId).eq("agentId", args.agentId)
			)
			.unique();

		if (!existing) {
			return null;
		}

		const syncedAt = args.syncedAt ?? Date.now();
		await ctx.db.patch(existing._id, {
			lastSyncedAt: syncedAt,
			updatedAt: Date.now(),
		});

		return existing._id;
	},
});
