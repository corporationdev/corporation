import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { snapshotTypeValidator } from "./schema";

export const getActive = authedQuery({
	args: {
		environmentId: v.id("environments"),
	},
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.environmentId);
		if (!environment || environment.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		return getActiveSnapshotForEnvironment(ctx, environment);
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

type ScheduleSnapshotRequest =
	| { type: "build" | "rebuild" }
	| { type: "override"; sandboxId: string; snapshotCommitSha?: string };

const MAX_SNAPSHOT_LOG_CHARS = 200_000;
const TERMINAL_SCHEDULED_FUNCTION_STATES = ["success", "failed", "canceled"];

function isTerminalScheduledFunctionState(kind: string): boolean {
	return TERMINAL_SCHEDULED_FUNCTION_STATES.includes(kind);
}

export async function getScheduledRebuildCleanupPatch(
	ctx: MutationCtx,
	environmentId: Id<"environments">,
	scheduledRebuildId: Id<"_scheduled_functions"> | undefined
): Promise<{ scheduledRebuildId?: undefined }> {
	if (!scheduledRebuildId) {
		return {};
	}

	const scheduledFunction = await ctx.db.system.get(scheduledRebuildId);
	if (
		scheduledFunction &&
		!isTerminalScheduledFunctionState(scheduledFunction.state.kind)
	) {
		try {
			await ctx.scheduler.cancel(scheduledRebuildId);
		} catch (error) {
			const latestScheduledFunction =
				await ctx.db.system.get(scheduledRebuildId);
			if (
				latestScheduledFunction &&
				!isTerminalScheduledFunctionState(latestScheduledFunction.state.kind)
			) {
				console.error("Failed to cancel scheduled rebuild", {
					environmentId,
					scheduledRebuildId,
					state: latestScheduledFunction.state.kind,
					error,
				});
				throw error;
			}
		}
	}

	return { scheduledRebuildId: undefined };
}

export async function getActiveSnapshotForEnvironment(
	ctx: DbCtx,
	environment: Doc<"environments">
): Promise<Doc<"snapshots"> | null> {
	if (environment.activeSnapshotId) {
		const active = await ctx.db.get(environment.activeSnapshotId);
		if (active && active.environmentId === environment._id) {
			return active;
		}
	}

	return await ctx.db
		.query("snapshots")
		.withIndex("by_environment_and_startedAt", (q) =>
			q.eq("environmentId", environment._id)
		)
		.order("desc")
		.first();
}

export async function withDerivedSnapshotState(
	ctx: DbCtx,
	environment: Doc<"environments">
) {
	const activeSnapshot = await getActiveSnapshotForEnvironment(
		ctx,
		environment
	);

	return {
		...environment,
		snapshotStatus: activeSnapshot?.status,
		snapshotId: activeSnapshot?._id,
		snapshotCommitSha: activeSnapshot?.snapshotCommitSha,
		externalSnapshotId: activeSnapshot?.externalSnapshotId,
	};
}

export async function scheduleSnapshot(
	ctx: MutationCtx,
	environment: Doc<"environments">,
	request: ScheduleSnapshotRequest
): Promise<void> {
	const activeSnapshot = await getActiveSnapshotForEnvironment(
		ctx,
		environment
	);
	if (activeSnapshot?.status === "building") {
		throw new ConvexError("A snapshot build is already in progress");
	}

	const scheduledRebuildPatch = await getScheduledRebuildCleanupPatch(
		ctx,
		environment._id,
		environment.scheduledRebuildId
	);

	await ctx.db.patch(environment._id, {
		...scheduledRebuildPatch,
		updatedAt: Date.now(),
	});

	if (request.type === "override") {
		await ctx.scheduler.runAfter(0, internal.snapshotActions.overrideSnapshot, {
			environmentId: environment._id,
			sandboxId: request.sandboxId,
			snapshotCommitSha: request.snapshotCommitSha,
		});
		return;
	}

	const buildRequest =
		request.type === "rebuild" && activeSnapshot?.externalSnapshotId
			? {
					type: "rebuild" as const,
					oldExternalSnapshotId: activeSnapshot.externalSnapshotId,
				}
			: { type: "build" as const };

	await ctx.scheduler.runAfter(0, internal.snapshotActions.buildSnapshot, {
		request: {
			environmentId: environment._id,
			...buildRequest,
		},
	});
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
			}),
			v.object({
				type: v.literal("override"),
				environmentId: v.id("environments"),
				spaceId: v.id("spaces"),
			})
		),
	},
	handler: async (ctx, args) => {
		const { request } = args;
		let scheduledRequest: ScheduleSnapshotRequest =
			request.type === "rebuild" ? { type: "rebuild" } : { type: "build" };

		const environment = await ctx.db.get(request.environmentId);
		if (!environment || environment.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		if (request.type === "override") {
			const space = await ctx.db.get(request.spaceId);
			if (!space) {
				throw new ConvexError("Space not found");
			}

			if (space.environmentId !== environment._id) {
				throw new ConvexError("Space does not belong to the environment");
			}

			if (!space.sandboxId) {
				throw new ConvexError("Space has no running sandbox");
			}
			if (space.status !== "running") {
				throw new ConvexError("Space must be running to save as base snapshot");
			}

			scheduledRequest = {
				type: "override",
				sandboxId: space.sandboxId,
				snapshotCommitSha: space.lastSyncedCommitSha,
			};
		}

		await scheduleSnapshot(ctx, environment, scheduledRequest);
	},
});

export const startSnapshot = internalMutation({
	args: {
		environmentId: v.id("environments"),
		type: snapshotTypeValidator,
	},
	handler: async (ctx, args) => {
		const snapshotId = await ctx.db.insert("snapshots", {
			environmentId: args.environmentId,
			type: args.type,
			status: "building",
			logs: "",
			startedAt: Date.now(),
		});

		await ctx.db.patch(args.environmentId, {
			activeSnapshotId: snapshotId,
			updatedAt: Date.now(),
		});

		return snapshotId;
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
		await ctx.db.patch(args.environmentId, {
			activeSnapshotId: args.snapshotId,
			updatedAt: Date.now(),
		});
		await ctx.db.patch(args.snapshotId, {
			status: "ready",
			completedAt: Date.now(),
			externalSnapshotId: args.externalSnapshotId,
			snapshotCommitSha: args.snapshotCommitSha,
		});
	},
});
