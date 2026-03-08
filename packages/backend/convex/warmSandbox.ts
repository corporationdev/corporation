import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation } from "./functions";
import { withDerivedSnapshotState } from "./snapshot";

const WARM_SANDBOX_TTL_MS = 5 * 60 * 1000;

export const request = authedMutation({
	args: {
		repositoryId: v.id("repositories"),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("warmSandboxes")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.first();

		if (existing) {
			if (existing.repositoryId === args.repositoryId) {
				return;
			}

			if (existing.sandboxId) {
				await ctx.scheduler.runAfter(0, internal.sandboxActions.deleteSandbox, {
					sandboxId: existing.sandboxId,
				});
			}
			await ctx.db.delete(existing._id);
		}

		const repository = await ctx.db.get(args.repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Repository not found");
		}

		const activeSnapshot = await ctx.db
			.query("snapshots")
			.withIndex("by_repository_status_startedAt", (q) =>
				q.eq("repositoryId", args.repositoryId).eq("status", "ready")
			)
			.order("desc")
			.first();

		if (!activeSnapshot?.externalSnapshotId) {
			return;
		}

		const warmSandboxId = await ctx.db.insert("warmSandboxes", {
			userId: ctx.userId,
			repositoryId: args.repositoryId,
			status: "provisioning",
			createdAt: Date.now(),
		});

		await ctx.scheduler.runAfter(
			0,
			internal.sandboxActions.provisionForWarmSandbox,
			{ warmSandboxId }
		);

		await ctx.scheduler.runAfter(
			WARM_SANDBOX_TTL_MS,
			internal.warmSandbox.cleanup,
			{ id: warmSandboxId }
		);
	},
});

export const cleanup = internalMutation({
	args: { id: v.id("warmSandboxes") },
	handler: async (ctx, args) => {
		const record = await ctx.db.get(args.id);
		if (!record) {
			return;
		}

		if (record.sandboxId) {
			await ctx.scheduler.runAfter(0, internal.sandboxActions.deleteSandbox, {
				sandboxId: record.sandboxId,
			});
		}
		await ctx.db.delete(record._id);
	},
});

export const internalGet = internalQuery({
	args: { id: v.id("warmSandboxes") },
	handler: async (ctx, args) => {
		const record = await ctx.db.get(args.id);
		if (!record) {
			throw new ConvexError("Warm sandbox not found");
		}

		const repository = await ctx.db.get(record.repositoryId);
		if (!repository) {
			throw new ConvexError("Repository not found");
		}

		const repositoryWithSnapshot = await withDerivedSnapshotState(
			ctx,
			repository
		);

		return {
			...record,
			repository: repositoryWithSnapshot,
		};
	},
});

export const markReady = internalMutation({
	args: {
		id: v.id("warmSandboxes"),
		sandboxId: v.string(),
		agentUrl: v.string(),
	},
	handler: async (ctx, args) => {
		const record = await ctx.db.get(args.id);
		if (!record) {
			return { delivered: false as const };
		}

		if (record.spaceId) {
			await ctx.db.patch(record.spaceId, {
				sandboxId: args.sandboxId,
				agentUrl: args.agentUrl,
				status: "running" as const,
			});
			await ctx.db.delete(record._id);
			return { delivered: true as const };
		}

		await ctx.db.patch(record._id, {
			sandboxId: args.sandboxId,
			agentUrl: args.agentUrl,
			status: "ready" as const,
		});
		return { delivered: true as const };
	},
});
