import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { normalizeEnvByPath } from "./lib/envByPath";
import { snapshotStatusValidator } from "./schema";

async function requireOwnedEnvironment(
	ctx: QueryCtx & { userId: string },
	environment: Doc<"environments">
): Promise<Doc<"environments">> {
	const repository = await ctx.db.get(environment.repositoryId);
	if (!repository || repository.userId !== ctx.userId) {
		throw new ConvexError("Environment not found");
	}

	return environment;
}

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
			.query("environments")
			.withIndex("by_repository", (q) =>
				q.eq("repositoryId", args.repositoryId)
			)
			.collect();
	},
});

export const update = authedMutation({
	args: {
		id: v.id("environments"),
		name: v.optional(v.string()),
		setupCommand: v.optional(v.string()),
		devCommand: v.optional(v.string()),
		envByPath: v.optional(
			v.record(v.string(), v.record(v.string(), v.string()))
		),
	},
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}
		await requireOwnedEnvironment(ctx, environment);

		const { id, envByPath, ...fields } = args;
		const normalizedEnvByPath =
			envByPath === undefined ? undefined : normalizeEnvByPath(envByPath);
		const patch = Object.fromEntries(
			Object.entries({
				...fields,
				envByPath: normalizedEnvByPath,
				updatedAt: Date.now(),
			}).filter(([, v]) => v !== undefined)
		);

		await ctx.db.patch(id, patch);
	},
});

export async function createEnvironmentHelper(
	ctx: MutationCtx & { userId: string },
	args: {
		repositoryId: Id<"repositories">;
		name: string;
		setupCommand: string;
		devCommand: string;
		envByPath?: Record<string, Record<string, string>>;
	}
): Promise<Id<"environments">> {
	const now = Date.now();
	const envId = await ctx.db.insert("environments", {
		userId: ctx.userId,
		repositoryId: args.repositoryId,
		name: args.name,
		setupCommand: args.setupCommand,
		devCommand: args.devCommand,
		envByPath: normalizeEnvByPath(args.envByPath),
		snapshotStatus: "building",
		createdAt: now,
		updatedAt: now,
	});

	await ctx.scheduler.runAfter(0, internal.snapshotActions.buildSnapshot, {
		environmentId: envId,
	});

	return envId;
}

export const create = authedMutation({
	args: {
		repositoryId: v.id("repositories"),
		name: v.string(),
		setupCommand: v.string(),
		devCommand: v.string(),
		envByPath: v.optional(
			v.record(v.string(), v.record(v.string(), v.string()))
		),
	},
	handler: async (ctx, args) => {
		const repository = await ctx.db.get(args.repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Repository not found");
		}

		return await createEnvironmentHelper(ctx, args);
	},
});

export const internalUpdate = internalMutation({
	args: {
		id: v.id("environments"),
		snapshotId: v.optional(v.string()),
		snapshotStatus: v.optional(snapshotStatusValidator),
	},
	handler: async (ctx, args) => {
		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries({ ...fields, updatedAt: Date.now() }).filter(
				([, val]) => val !== undefined
			)
		);
		await ctx.db.patch(id, patch);
	},
});

export const internalGet = internalQuery({
	args: { id: v.id("environments") },
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}

		const repository = await ctx.db.get(environment.repositoryId);
		if (!repository) {
			throw new ConvexError("Repository not found");
		}

		return { ...environment, repository };
	},
});

export const internalListByRepository = internalQuery({
	args: { repositoryId: v.id("repositories") },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("environments")
			.withIndex("by_repository", (q) =>
				q.eq("repositoryId", args.repositoryId)
			)
			.collect();
	},
});

/**
 * Cancels any pending scheduled rebuild and transitions to "building" status.
 * Throws if a build is already in progress.
 */
async function transitionToBuilding(
	ctx: MutationCtx,
	environment: Doc<"environments">
): Promise<void> {
	if (environment.snapshotStatus === "building") {
		throw new ConvexError("A snapshot build is already in progress");
	}

	if (environment.scheduledRebuildId) {
		try {
			await ctx.scheduler.cancel(environment.scheduledRebuildId);
		} catch {
			// Already executed or cancelled
		}
	}

	await ctx.db.patch(environment._id, {
		scheduledRebuildId: undefined,
		snapshotStatus: "building",
		updatedAt: Date.now(),
	});
}

/**
 * Transitions to "building" and schedules the appropriate snapshot action
 * (incremental rebuild if a snapshot exists, otherwise full build).
 */
async function scheduleSnapshotRebuild(
	ctx: MutationCtx,
	environment: Doc<"environments">
): Promise<void> {
	await transitionToBuilding(ctx, environment);

	if (environment.snapshotId) {
		await ctx.scheduler.runAfter(0, internal.snapshotActions.rebuildSnapshot, {
			environmentId: environment._id,
			snapshotId: environment.snapshotId,
		});
	} else {
		await ctx.scheduler.runAfter(0, internal.snapshotActions.buildSnapshot, {
			environmentId: environment._id,
		});
	}
}

export const rebuildSnapshot = authedMutation({
	args: { id: v.id("environments") },
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}
		await requireOwnedEnvironment(ctx, environment);

		await scheduleSnapshotRebuild(ctx, environment);
	},
});

export const fullBuildSnapshot = authedMutation({
	args: { id: v.id("environments") },
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}
		await requireOwnedEnvironment(ctx, environment);

		await transitionToBuilding(ctx, environment);

		await ctx.scheduler.runAfter(0, internal.snapshotActions.buildSnapshot, {
			environmentId: args.id,
		});
	},
});

export const overrideSnapshot = authedMutation({
	args: { spaceId: v.id("spaces") },
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.spaceId);
		if (!space) {
			throw new ConvexError("Space not found");
		}

		const environment = await ctx.db.get(space.environmentId);
		if (!environment || environment.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		if (!space.sandboxId) {
			throw new ConvexError("Space has no running sandbox");
		}

		if (space.status !== "running") {
			throw new ConvexError("Space must be running to save as base snapshot");
		}

		await transitionToBuilding(ctx, environment);

		await ctx.scheduler.runAfter(0, internal.snapshotActions.overrideSnapshot, {
			environmentId: environment._id,
			sandboxId: space.sandboxId,
			snapshotCommitSha: space.lastSyncedCommitSha,
		});
	},
});

export const completeSnapshotBuild = internalMutation({
	args: {
		id: v.id("environments"),
		snapshotId: v.string(),
		snapshotCommitSha: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}

		const now = Date.now();

		await ctx.db.patch(args.id, {
			snapshotId: args.snapshotId,
			snapshotCommitSha: args.snapshotCommitSha,
			snapshotStatus: "ready",
			lastSnapshotBuildAt: now,
			updatedAt: now,
		});

		await ctx.scheduler.runAfter(0, internal.environments.scheduleNextRebuild, {
			id: args.id,
		});
	},
});

export const scheduleNextRebuild = internalMutation({
	args: { id: v.id("environments") },
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			return;
		}

		const intervalMs = environment.rebuildIntervalMs;
		if (!intervalMs) {
			if (environment.scheduledRebuildId) {
				await ctx.db.patch(args.id, {
					scheduledRebuildId: undefined,
					updatedAt: Date.now(),
				});
			}
			return;
		}

		const scheduledId = await ctx.scheduler.runAfter(
			intervalMs,
			internal.environments.executeScheduledRebuild,
			{ id: args.id }
		);

		await ctx.db.patch(args.id, {
			scheduledRebuildId: scheduledId,
			updatedAt: Date.now(),
		});
	},
});

export const executeScheduledRebuild = internalMutation({
	args: { id: v.id("environments") },
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			return;
		}

		if (!environment.rebuildIntervalMs) {
			await ctx.db.patch(args.id, {
				scheduledRebuildId: undefined,
				updatedAt: Date.now(),
			});
			return;
		}

		await scheduleSnapshotRebuild(ctx, environment);
	},
});

export const updateRebuildInterval = authedMutation({
	args: {
		id: v.id("environments"),
		rebuildIntervalMs: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}
		await requireOwnedEnvironment(ctx, environment);

		if (environment.scheduledRebuildId) {
			try {
				await ctx.scheduler.cancel(environment.scheduledRebuildId);
			} catch {
				// Already executed or cancelled
			}
		}

		await ctx.db.patch(args.id, {
			rebuildIntervalMs: args.rebuildIntervalMs,
			scheduledRebuildId: undefined,
			updatedAt: Date.now(),
		});

		await ctx.scheduler.runAfter(0, internal.environments.scheduleNextRebuild, {
			id: args.id,
		});
	},
});
