import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { assertValidDevPort } from "./lib/devPort";
import { normalizeEnvByPath } from "./lib/envByPath";
import { scheduleSnapshot } from "./snapshot";

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
		updateCommand: v.optional(v.string()),
		devCommand: v.optional(v.string()),
		devPort: v.number(),
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
		assertValidDevPort(args.devPort);

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
		updateCommand?: string;
		devCommand: string;
		devPort: number;
		envByPath?: Record<string, Record<string, string>>;
	}
): Promise<Id<"environments">> {
	assertValidDevPort(args.devPort);

	const now = Date.now();
	const environmentId = await ctx.db.insert("environments", {
		userId: ctx.userId,
		repositoryId: args.repositoryId,
		name: args.name,
		setupCommand: args.setupCommand,
		updateCommand: args.updateCommand,
		devCommand: args.devCommand,
		devPort: args.devPort,
		envByPath: normalizeEnvByPath(args.envByPath),
		createdAt: now,
		updatedAt: now,
	});

	const environment = await ctx.db.get(environmentId);
	if (!environment) {
		throw new ConvexError("Environment not found");
	}

	await scheduleSnapshot(ctx, environment, "setup");

	return environmentId;
}

export const create = authedMutation({
	args: {
		repositoryId: v.id("repositories"),
		name: v.string(),
		setupCommand: v.string(),
		updateCommand: v.optional(v.string()),
		devCommand: v.string(),
		devPort: v.number(),
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

		await ctx.db.patch(args.id, { updatedAt: Date.now() });
	},
});
