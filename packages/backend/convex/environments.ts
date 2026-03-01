import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { normalizeEnvByPath } from "./lib/envByPath";
import { scheduleSnapshotBuild } from "./snapshot";

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
		if (environment.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

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
		createdAt: now,
		updatedAt: now,
	});

	await ctx.scheduler.runAfter(0, internal.snapshotActions.buildSnapshot, {
		request: {
			environmentId: envId,
			type: "build",
		},
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

export const completeSnapshotBuild = internalMutation({
	args: {
		id: v.id("environments"),
	},
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}

		const now = Date.now();

		await ctx.db.patch(args.id, { updatedAt: now });

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

		await scheduleSnapshotBuild(ctx, environment, "rebuild");
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
		if (environment.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

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
