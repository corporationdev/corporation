import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { authedMutation } from "./functions";
import { snapshotTypeValidator } from "./schema";

type DbCtx = {
	db: QueryCtx["db"] | MutationCtx["db"];
};

const MAX_SNAPSHOT_LOG_CHARS = 200_000;
export type EnvironmentWithSnapshotState = Doc<"environments"> & {
	snapshotStatus: "building" | "ready" | "error";
	snapshotId?: string;
	snapshotCommitSha?: string;
};

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
): Promise<EnvironmentWithSnapshotState> {
	const activeSnapshot = await getActiveSnapshotForEnvironment(
		ctx,
		environment
	);
	const snapshotStatus: "building" | "ready" | "error" =
		activeSnapshot?.status ?? "building";
	return {
		...environment,
		snapshotStatus,
		snapshotId: activeSnapshot?.snapshotId,
		snapshotCommitSha: activeSnapshot?.snapshotCommitSha,
	};
}

export async function resolveSnapshotBuildInput(
	ctx: DbCtx,
	environment: Doc<"environments">,
	requestedType: "build" | "rebuild"
): Promise<{ type: "build" } | { type: "rebuild"; snapshotId: string }> {
	const activeSnapshot = await getActiveSnapshotForEnvironment(
		ctx,
		environment
	);
	if (requestedType === "rebuild" && activeSnapshot?.snapshotId) {
		return { type: "rebuild", snapshotId: activeSnapshot.snapshotId };
	}
	return { type: "build" };
}

export async function transitionEnvironmentToBuilding(
	ctx: MutationCtx,
	environment: Doc<"environments">
): Promise<void> {
	const activeSnapshot = await getActiveSnapshotForEnvironment(
		ctx,
		environment
	);
	if (activeSnapshot?.status === "building") {
		throw new ConvexError("A snapshot build is already in progress");
	}

	if (environment.scheduledRebuildId) {
		try {
			await ctx.scheduler.cancel(environment.scheduledRebuildId);
		} catch {
			// Already executed or cancelled.
		}
	}

	await ctx.db.patch(environment._id, {
		scheduledRebuildId: undefined,
		updatedAt: Date.now(),
	});
}

export async function scheduleSnapshotBuild(
	ctx: MutationCtx,
	environment: Doc<"environments">,
	requestedType: "build" | "rebuild"
): Promise<void> {
	await transitionEnvironmentToBuilding(ctx, environment);

	const request = await resolveSnapshotBuildInput(
		ctx,
		environment,
		requestedType
	);
	await ctx.scheduler.runAfter(0, internal.snapshotActions.buildSnapshot, {
		request: {
			environmentId: environment._id,
			...request,
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
				throw new ConvexError("Space and environment mismatch");
			}

			if (!space.sandboxId) {
				throw new ConvexError("Space has no running sandbox");
			}
			if (space.status !== "running") {
				throw new ConvexError("Space must be running to save as base snapshot");
			}

			await transitionEnvironmentToBuilding(ctx, environment);
			await ctx.scheduler.runAfter(
				0,
				internal.snapshotActions.overrideSnapshot,
				{
					environmentId: environment._id,
					sandboxId: space.sandboxId,
					snapshotCommitSha: space.lastSyncedCommitSha,
				}
			);
			return;
		}

		await scheduleSnapshotBuild(ctx, environment, request.type);
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
		snapshotId: v.id("snapshots"),
		logChunk: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const snapshot = await ctx.db.get(args.snapshotId);
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
		await ctx.db.patch(args.snapshotId, patch);
	},
});

export const completeSnapshot = internalMutation({
	args: {
		snapshotId: v.id("snapshots"),
		completion: v.union(
			v.object({
				status: v.literal("ready"),
				snapshotId: v.string(),
				snapshotCommitSha: v.optional(v.string()),
			}),
			v.object({
				status: v.literal("error"),
				error: v.string(),
			})
		),
	},
	handler: async (ctx, args) => {
		const snapshot = await ctx.db.get(args.snapshotId);
		if (!snapshot) {
			throw new ConvexError("Snapshot not found");
		}
		if (snapshot.status !== "building") {
			throw new ConvexError("Snapshot is not building");
		}

		const patch: {
			status: "ready" | "error";
			completedAt: number;
			error?: string;
			snapshotId?: string;
			snapshotCommitSha?: string;
		} = {
			status: args.completion.status,
			completedAt: Date.now(),
		};

		if (args.completion.status === "ready") {
			patch.snapshotId = args.completion.snapshotId;
			patch.snapshotCommitSha = args.completion.snapshotCommitSha;
		} else {
			patch.error = args.completion.error;
		}

		await ctx.db.patch(args.snapshotId, patch);
	},
});
