"use node";

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { action, internalAction } from "./_generated/server";
import { authComponent } from "./auth";
import { decrypt, deriveUserKey, encrypt } from "./lib/crypto";

function getMasterKey(): string {
	const masterKey = process.env.CORPORATION_API_KEY_MASTER_KEY;
	if (!masterKey) {
		throw new Error("Missing CORPORATION_API_KEY_MASTER_KEY env var");
	}
	return masterKey;
}

async function requireAuthUserId(
	ctx: Parameters<typeof authComponent.safeGetAuthUser>[0]
): Promise<string> {
	const authUser = await authComponent.safeGetAuthUser(ctx);
	if (!authUser) {
		throw new ConvexError("Unauthenticated");
	}
	return authUser._id;
}

type ResolvedAgentCredential = {
	agentId: string;
	bundle: string;
	schemaVersion: number;
	createdAt: number;
	updatedAt: number;
	lastSyncedAt: number | null;
};

export const saveForCurrentUser = action({
	args: {
		agentId: v.string(),
		bundle: v.string(),
		schemaVersion: v.optional(v.number()),
		lastSyncedAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const userId = await requireAuthUserId(ctx);
		const userKey = await deriveUserKey(getMasterKey(), userId);
		const { ciphertext, iv } = await encrypt(userKey, args.bundle);

		await ctx.runMutation(internal.agentCredentials.upsertInternal, {
			userId,
			agentId: args.agentId,
			encryptedBundle: ciphertext,
			iv,
			schemaVersion: args.schemaVersion ?? 1,
			lastSyncedAt: args.lastSyncedAt,
		});

		return null;
	},
});

export const removeForCurrentUser = action({
	args: {
		agentId: v.string(),
	},
	handler: async (ctx, args) => {
		const userId = await requireAuthUserId(ctx);

		await ctx.runMutation(internal.agentCredentials.removeByUserAndAgentInternal, {
			userId,
			agentId: args.agentId,
		});

		return null;
	},
});

export const resolveForCurrentUser = action({
	args: {
		agentId: v.string(),
	},
	handler: async (ctx, args): Promise<ResolvedAgentCredential | null> => {
		const userId = await requireAuthUserId(ctx);
		const row: Doc<"agentCredentials"> | null = await ctx.runQuery(
			internal.agentCredentials.getByUserAndAgent,
			{
				userId,
				agentId: args.agentId,
			}
		);

		if (!row) {
			return null;
		}

		const userKey = await deriveUserKey(getMasterKey(), userId);

		return {
			agentId: row.agentId,
			bundle: await decrypt(userKey, row.encryptedBundle, row.iv),
			schemaVersion: row.schemaVersion,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			lastSyncedAt: row.lastSyncedAt ?? null,
		};
	},
});

export const resolveForUser = internalAction({
	args: {
		userId: v.string(),
		agentId: v.string(),
	},
	handler: async (ctx, args): Promise<ResolvedAgentCredential | null> => {
		const row: Doc<"agentCredentials"> | null = await ctx.runQuery(
			internal.agentCredentials.getByUserAndAgent,
			{
				userId: args.userId,
				agentId: args.agentId,
			}
		);

		if (!row) {
			return null;
		}

		const userKey = await deriveUserKey(getMasterKey(), args.userId);

		return {
			agentId: row.agentId,
			bundle: await decrypt(userKey, row.encryptedBundle, row.iv),
			schemaVersion: row.schemaVersion,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			lastSyncedAt: row.lastSyncedAt ?? null,
		};
	},
});

export const markSyncedForUser = internalAction({
	args: {
		userId: v.string(),
		agentId: v.string(),
		syncedAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await ctx.runMutation(internal.agentCredentials.markSyncedInternal, args);
		return null;
	},
});
