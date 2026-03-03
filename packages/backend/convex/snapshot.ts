import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { snapshotTypeValidator } from "./schema";

export const getLatest = authedQuery({
	args: {
		environmentId: v.id("environments"),
	},
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.environmentId);
		if (!environment || environment.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		return await ctx.db
			.query("snapshots")
			.withIndex("by_environment_and_startedAt", (q) =>
				q.eq("environmentId", environment._id)
			)
			.order("desc")
			.first();
	},
});

export const listByEnvironment = authedQuery({
	args: {
		environmentId: v.id("environments"),
	},
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.environmentId);
		if (!environment || environment.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		const snapshots = await ctx.db
			.query("snapshots")
			.withIndex("by_environment_and_startedAt", (q) =>
				q.eq("environmentId", args.environmentId)
			)
			.order("desc")
			.collect();

		return snapshots.map(({ logs: _logs, ...rest }) => rest);
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

		const environment = await ctx.db.get(snapshot.environmentId);
		if (!environment || environment.userId !== ctx.userId) {
			throw new ConvexError("Snapshot not found");
		}

		return snapshot;
	},
});

type DbCtx = {
	db: QueryCtx["db"] | MutationCtx["db"];
};

const MAX_SNAPSHOT_LOG_CHARS = 200_000;

export async function withDerivedSnapshotState(
	ctx: DbCtx,
	environment: Doc<"environments">
) {
	const [latestSnapshot, activeSnapshot] = await Promise.all([
		ctx.db
			.query("snapshots")
			.withIndex("by_environment_and_startedAt", (q) =>
				q.eq("environmentId", environment._id)
			)
			.order("desc")
			.first(),
		ctx.db
			.query("snapshots")
			.withIndex("by_environment_status_startedAt", (q) =>
				q.eq("environmentId", environment._id).eq("status", "ready")
			)
			.order("desc")
			.first(),
	]);

	return {
		...environment,
		latestSnapshot,
		activeSnapshot,
	};
}

export async function scheduleSnapshot(
	ctx: MutationCtx,
	environment: Doc<"environments">,
	type: "build" | "rebuild"
): Promise<Id<"snapshots">> {
	const [latestSnapshot, activeSnapshot] = await Promise.all([
		ctx.db
			.query("snapshots")
			.withIndex("by_environment_and_startedAt", (q) =>
				q.eq("environmentId", environment._id)
			)
			.order("desc")
			.first(),
		ctx.db
			.query("snapshots")
			.withIndex("by_environment_status_startedAt", (q) =>
				q.eq("environmentId", environment._id).eq("status", "ready")
			)
			.order("desc")
			.first(),
	]);
	if (latestSnapshot?.status === "building") {
		throw new ConvexError("A snapshot build is already in progress");
	}

	const buildRequest =
		type === "rebuild" && activeSnapshot?.externalSnapshotId
			? {
					type: "rebuild" as const,
					oldExternalSnapshotId: activeSnapshot.externalSnapshotId,
				}
			: { type: "build" as const };

	const now = Date.now();
	const snapshotId = await ctx.db.insert("snapshots", {
		environmentId: environment._id,
		type: buildRequest.type,
		status: "building",
		logs: "",
		startedAt: now,
	});

	await ctx.db.patch(environment._id, {
		updatedAt: now,
	});

	await ctx.scheduler.runAfter(0, internal.snapshotActions.buildSnapshot, {
		request: {
			environmentId: environment._id,
			snapshotId,
			...buildRequest,
		},
	});

	return snapshotId;
}

export const createSnapshot = authedMutation({
	args: {
		request: v.union(
			v.object({
				type: v.literal("build"),
				environmentId: v.id("environments"),
			}),
			v.object({
				type: v.literal("rebuild"),
				environmentId: v.id("environments"),
			})
		),
	},
	handler: async (ctx, args) => {
		const { request } = args;

		const environment = await ctx.db.get(request.environmentId);
		if (!environment || environment.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		await scheduleSnapshot(ctx, environment, request.type);
	},
});

export const startSnapshot = internalMutation({
	args: {
		snapshotId: v.id("snapshots"),
		environmentId: v.id("environments"),
		type: snapshotTypeValidator,
	},
	handler: async (ctx, args) => {
		const snapshot = await ctx.db.get(args.snapshotId);
		if (!snapshot) {
			throw new ConvexError("Snapshot not found");
		}
		if (snapshot.environmentId !== args.environmentId) {
			throw new ConvexError("Snapshot does not belong to environment");
		}
		if (snapshot.type !== args.type) {
			throw new ConvexError("Snapshot type mismatch");
		}
		if (snapshot.status !== "building") {
			throw new ConvexError("Snapshot is not building");
		}

		return snapshot._id;
	},
});

export const reportSnapshotProgress = internalMutation({
	args: {
		id: v.id("snapshots"),
		logChunk: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const snapshot = await ctx.db.get(args.id);
		if (!snapshot) {
			throw new ConvexError("Snapshot not found");
		}
		if (snapshot.status !== "building") {
			throw new ConvexError("Snapshot is not building");
		}

		const patch: { logs?: string; logsTruncated?: boolean } = {};
		if (
			args.logChunk !== undefined &&
			args.logChunk.length > 0 &&
			!snapshot.logsTruncated
		) {
			const available = MAX_SNAPSHOT_LOG_CHARS - snapshot.logs.length;
			if (available > 0) {
				patch.logs =
					snapshot.logs + args.logChunk.slice(0, Math.max(0, available));
			}
			if (available <= 0 || args.logChunk.length > available) {
				patch.logsTruncated = true;
			}
		}

		if (Object.keys(patch).length === 0) {
			return;
		}
		await ctx.db.patch(args.id, patch);
	},
});

export const completeSnapshot = internalMutation({
	args: {
		snapshotId: v.id("snapshots"),
		status: v.union(v.literal("ready"), v.literal("error")),
		environmentId: v.optional(v.id("environments")),
		externalSnapshotId: v.optional(v.string()),
		snapshotCommitSha: v.optional(v.string()),
		error: v.optional(v.string()),
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

		if (!(args.environmentId && args.externalSnapshotId)) {
			throw new ConvexError(
				"environmentId and externalSnapshotId are required when status is ready"
			);
		}

		if (snapshot.environmentId !== args.environmentId) {
			throw new ConvexError("Snapshot does not belong to environment");
		}
		await ctx.db.patch(args.snapshotId, {
			status: "ready",
			completedAt: Date.now(),
			externalSnapshotId: args.externalSnapshotId,
			snapshotCommitSha: args.snapshotCommitSha,
		});
	},
});
