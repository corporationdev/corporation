import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
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
		serviceIds: v.optional(v.array(v.id("services"))),
	},
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}
		await requireOwnedEnvironment(ctx, environment);

		if (args.serviceIds) {
			for (const serviceId of args.serviceIds) {
				const service = await ctx.db.get(serviceId);
				if (!service || service.repositoryId !== environment.repositoryId) {
					throw new ConvexError("Invalid service ID");
				}
			}
		}

		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries({ ...fields, updatedAt: Date.now() }).filter(
				([, v]) => v !== undefined
			)
		);

		await ctx.db.patch(id, patch);
	},
});

export async function createEnvironmentHelper(
	ctx: MutationCtx & { userId: string },
	args: {
		repositoryId: Id<"repositories">;
		name: string;
		serviceIds: Id<"services">[];
	}
): Promise<Id<"environments">> {
	const now = Date.now();
	const envId = await ctx.db.insert("environments", {
		userId: ctx.userId,
		repositoryId: args.repositoryId,
		name: args.name,
		snapshotStatus: "building",
		serviceIds: args.serviceIds,
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
		serviceIds: v.array(v.id("services")),
	},
	handler: async (ctx, args) => {
		const repository = await ctx.db.get(args.repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Repository not found");
		}

		for (const serviceId of args.serviceIds) {
			const service = await ctx.db.get(serviceId);
			if (!service || service.repositoryId !== args.repositoryId) {
				throw new ConvexError("Invalid service ID");
			}
		}

		return await createEnvironmentHelper(ctx, args);
	},
});

export const internalUpdate = internalMutation({
	args: {
		id: v.id("environments"),
		snapshotName: v.optional(v.string()),
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

async function rebuildSnapshotHelper(
	ctx: MutationCtx,
	environment: Doc<"environments">
) {
	if (environment.snapshotStatus === "building") {
		return;
	}

	await ctx.db.patch(environment._id, {
		snapshotStatus: "building",
		updatedAt: Date.now(),
	});

	await ctx.scheduler.runAfter(0, internal.snapshotActions.buildSnapshot, {
		environmentId: environment._id,
	});
}

export const rebuildSnapshot = authedMutation({
	args: { id: v.id("environments") },
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}
		await requireOwnedEnvironment(ctx, environment);

		// Cancel any existing scheduled rebuild — manual takes priority
		if (environment.scheduledRebuildId) {
			try {
				await ctx.scheduler.cancel(environment.scheduledRebuildId);
			} catch {
				// Already executed or cancelled
			}
			await ctx.db.patch(args.id, {
				scheduledRebuildId: undefined,
				updatedAt: Date.now(),
			});
		}

		await rebuildSnapshotHelper(ctx, environment);
	},
});

export const internalRebuildSnapshot = internalMutation({
	args: { id: v.id("environments") },
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}
		await rebuildSnapshotHelper(ctx, environment);
	},
});

export const completeSnapshotBuild = internalMutation({
	args: {
		id: v.id("environments"),
		snapshotName: v.string(),
		snapshotCommitSha: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}

		const oldSnapshotName = environment.snapshotName;
		if (oldSnapshotName && oldSnapshotName !== args.snapshotName) {
			await ctx.scheduler.runAfter(0, internal.snapshotActions.deleteSnapshot, {
				snapshotName: oldSnapshotName,
			});
		}

		const now = Date.now();

		await ctx.db.patch(args.id, {
			snapshotName: args.snapshotName,
			snapshotCommitSha: args.snapshotCommitSha,
			snapshotStatus: "ready",
			lastSnapshotBuildAt: now,
			updatedAt: now,
		});

		// Schedule the next rebuild if an interval is configured
		if (environment.rebuildIntervalMs) {
			await ctx.scheduler.runAfter(
				0,
				internal.environments.scheduleNextRebuild,
				{ id: args.id }
			);
		}
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

		// Cancel any existing scheduled rebuild
		if (environment.scheduledRebuildId) {
			try {
				await ctx.scheduler.cancel(environment.scheduledRebuildId);
			} catch {
				// Already executed or cancelled
			}
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

		// Trigger the rebuild — completeSnapshotBuild will schedule the next one
		await rebuildSnapshotHelper(ctx, environment);
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

		// Cancel existing scheduled rebuild
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

		// If a new interval is set, start the scheduling chain
		if (args.rebuildIntervalMs) {
			await ctx.scheduler.runAfter(
				0,
				internal.environments.scheduleNextRebuild,
				{ id: args.id }
			);
		}
	},
});
