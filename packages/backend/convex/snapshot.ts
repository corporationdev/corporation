import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";

export const getLatest = authedQuery({
	args: {
		repositoryId: v.id("repositories"),
	},
	handler: async (ctx, args) => {
		const repository = await ctx.db.get(args.repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Repository not found");
		}

		return await ctx.db
			.query("snapshots")
			.withIndex("by_repository_and_startedAt", (q) =>
				q.eq("repositoryId", repository._id)
			)
			.order("desc")
			.first();
	},
});

export const listByRepository = authedQuery({
	args: {
		repositoryId: v.id("repositories"),
	},
	handler: async (ctx, args) => {
		const repository = await ctx.db.get(args.repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Repository not found");
		}

		return await ctx.db
			.query("snapshots")
			.withIndex("by_repository_and_startedAt", (q) =>
				q.eq("repositoryId", args.repositoryId)
			)
			.order("desc")
			.collect();
	},
});

export const get = authedQuery({
	args: {
		id: v.id("snapshots"),
	},
	handler: async (ctx, args) => {
		const snapshot = await ctx.db.get(args.id);
		if (!snapshot) {
			throw new ConvexError("Snapshot not found");
		}

		const repository = await ctx.db.get(snapshot.repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Snapshot not found");
		}

		return snapshot;
	},
});

type DbCtx = {
	db: QueryCtx["db"] | MutationCtx["db"];
};

export async function withDerivedSnapshotState(
	ctx: DbCtx,
	repository: Doc<"repositories">
) {
	const [latestSnapshot, activeSnapshot, defaultSnapshot] = await Promise.all([
		ctx.db
			.query("snapshots")
			.withIndex("by_repository_and_startedAt", (q) =>
				q.eq("repositoryId", repository._id)
			)
			.order("desc")
			.first(),
		ctx.db
			.query("snapshots")
			.withIndex("by_repository_status_startedAt", (q) =>
				q.eq("repositoryId", repository._id).eq("status", "ready")
			)
			.order("desc")
			.first(),
		repository.defaultSnapshotId
			? ctx.db.get(repository.defaultSnapshotId)
			: null,
	]);

	return {
		...repository,
		latestSnapshot,
		activeSnapshot,
		defaultSnapshot,
	};
}

export async function scheduleInitialSnapshot(
	ctx: MutationCtx,
	repository: Doc<"repositories">,
	options?: { setAsDefault?: boolean }
): Promise<Id<"snapshots">> {
	const latestSnapshot = await ctx.db
		.query("snapshots")
		.withIndex("by_repository_and_startedAt", (q) =>
			q.eq("repositoryId", repository._id)
		)
		.order("desc")
		.first();

	if (latestSnapshot?.status === "building") {
		throw new ConvexError("A snapshot build is already in progress");
	}

	const now = Date.now();
	const snapshotId = await ctx.db.insert("snapshots", {
		repositoryId: repository._id,
		label: "Base Snapshot",
		status: "building",
		startedAt: now,
	});

	await ctx.db.patch(repository._id, { updatedAt: now });

	await ctx.scheduler.runAfter(
		0,
		internal.snapshotActions.buildInitialSnapshot,
		{
			repositoryId: repository._id,
			snapshotId,
			setAsDefault: options?.setAsDefault ?? false,
		}
	);

	return snapshotId;
}

export const buildInitialSnapshot = authedMutation({
	args: {
		repositoryId: v.id("repositories"),
	},
	handler: async (ctx, args) => {
		const repository = await ctx.db.get(args.repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Repository not found");
		}

		await scheduleInitialSnapshot(ctx, repository);
	},
});

export const completeSnapshot = internalMutation({
	args: {
		snapshotId: v.id("snapshots"),
		status: v.union(v.literal("ready"), v.literal("error")),
		repositoryId: v.optional(v.id("repositories")),
		externalSnapshotId: v.optional(v.string()),
		error: v.optional(v.string()),
		setAsDefault: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const snapshot = await ctx.db.get(args.snapshotId);
		if (!snapshot) {
			throw new ConvexError("Snapshot not found");
		}
		if (snapshot.status !== "building") {
			throw new ConvexError("Snapshot is not building");
		}

		if (args.status === "error") {
			if (!args.error) {
				throw new ConvexError("error is required when status is error");
			}
			await ctx.db.patch(args.snapshotId, {
				status: "error",
				completedAt: Date.now(),
				error: args.error,
			});
			return;
		}

		if (!(args.repositoryId && args.externalSnapshotId)) {
			throw new ConvexError(
				"repositoryId and externalSnapshotId are required when status is ready"
			);
		}
		if (snapshot.repositoryId !== args.repositoryId) {
			throw new ConvexError("Snapshot does not belong to repository");
		}
		await ctx.db.patch(args.snapshotId, {
			status: "ready",
			completedAt: Date.now(),
			externalSnapshotId: args.externalSnapshotId,
		});

		if (args.setAsDefault) {
			await ctx.db.patch(args.repositoryId, {
				defaultSnapshotId: args.snapshotId,
			});
		}
	},
});
