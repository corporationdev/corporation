import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { assertValidDevPort } from "./lib/devPort";
import { normalizeEnvByPath } from "./lib/envByPath";
import { scheduleSnapshot, withDerivedSnapshotState } from "./snapshot";

function requireOwnedRepository(
	userId: string,
	repo: Doc<"repositories">
): Doc<"repositories"> {
	if (repo.userId !== userId) {
		throw new ConvexError("Repository not found");
	}
	return repo;
}

export const list = authedQuery({
	args: {},
	handler: async (ctx) => {
		const repositories = await ctx.db
			.query("repositories")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		return await Promise.all(
			repositories.map((repository) =>
				withDerivedSnapshotState(ctx, repository)
			)
		);
	},
});

export const get = authedQuery({
	args: { id: v.id("repositories") },
	handler: async (ctx, args) => {
		const repository = await ctx.db.get(args.id);
		if (!repository) {
			throw new ConvexError("Repository not found");
		}
		requireOwnedRepository(ctx.userId, repository);

		return await withDerivedSnapshotState(ctx, repository);
	},
});

export const create = authedMutation({
	args: {
		githubRepoId: v.number(),
		owner: v.string(),
		name: v.string(),
		defaultBranch: v.string(),
		setupCommand: v.string(),
		updateCommand: v.string(),
		devCommand: v.string(),
		devPort: v.number(),
		envByPath: v.optional(
			v.record(v.string(), v.record(v.string(), v.string()))
		),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("repositories")
			.withIndex("by_user_and_github_repo", (q) =>
				q.eq("userId", ctx.userId).eq("githubRepoId", args.githubRepoId)
			)
			.first();

		if (existing) {
			throw new ConvexError("Repository already connected");
		}

		assertValidDevPort(args.devPort);
		const now = Date.now();
		const normalizedEnvByPath = normalizeEnvByPath(args.envByPath);

		const repositoryId = await ctx.db.insert("repositories", {
			userId: ctx.userId,
			githubRepoId: args.githubRepoId,
			owner: args.owner,
			name: args.name,
			defaultBranch: args.defaultBranch,
			setupCommand: args.setupCommand,
			updateCommand: args.updateCommand,
			devCommand: args.devCommand,
			devPort: args.devPort,
			envByPath: normalizedEnvByPath,
			createdAt: now,
			updatedAt: now,
		});

		const repository = await ctx.db.get(repositoryId);
		if (!repository) {
			throw new ConvexError("Repository not found");
		}

		await scheduleSnapshot(ctx, repository, "setup");

		return repositoryId;
	},
});

export const update = authedMutation({
	args: {
		id: v.id("repositories"),
		defaultBranch: v.optional(v.string()),
		setupCommand: v.optional(v.string()),
		updateCommand: v.optional(v.string()),
		devCommand: v.optional(v.string()),
		devPort: v.optional(v.number()),
		envByPath: v.optional(
			v.record(v.string(), v.record(v.string(), v.string()))
		),
	},
	handler: async (ctx, args) => {
		const repository = await ctx.db.get(args.id);
		if (!repository) {
			throw new ConvexError("Repository not found");
		}
		requireOwnedRepository(ctx.userId, repository);

		if (args.devPort !== undefined) {
			assertValidDevPort(args.devPort);
		}

		const { id, envByPath, ...fields } = args;
		const normalizedEnvByPath =
			envByPath === undefined ? undefined : normalizeEnvByPath(envByPath);
		const patch = Object.fromEntries(
			Object.entries({
				...fields,
				envByPath: normalizedEnvByPath,
				updatedAt: Date.now(),
			}).filter(([, value]) => value !== undefined)
		);

		await ctx.db.patch(id, patch);
	},
});

const del = authedMutation({
	args: {
		id: v.id("repositories"),
	},
	handler: async (ctx, args) => {
		const repository = await ctx.db.get(args.id);
		if (!repository) {
			throw new ConvexError("Repository not found");
		}
		requireOwnedRepository(ctx.userId, repository);

		const [spaces, snapshots] = await Promise.all([
			ctx.db
				.query("spaces")
				.withIndex("by_repository", (q) => q.eq("repositoryId", args.id))
				.collect(),
			ctx.db
				.query("snapshots")
				.withIndex("by_repository", (q) => q.eq("repositoryId", args.id))
				.collect(),
		]);

		for (const space of spaces) {
			if (space.sandboxId) {
				await ctx.scheduler.runAfter(0, internal.sandboxActions.deleteSandbox, {
					sandboxId: space.sandboxId,
				});
			}
			await ctx.db.delete(space._id);
		}

		for (const snapshot of snapshots) {
			await ctx.db.delete(snapshot._id);
		}

		await ctx.db.delete(args.id);
	},
});
export { del as delete };

export const internalGet = internalQuery({
	args: { id: v.id("repositories") },
	handler: async (ctx, args) => {
		const repository = await ctx.db.get(args.id);
		if (!repository) {
			throw new ConvexError("Repository not found");
		}
		return repository;
	},
});

export const completeSnapshotBuild = internalMutation({
	args: {
		id: v.id("repositories"),
	},
	handler: async (ctx, args) => {
		const repository = await ctx.db.get(args.id);
		if (!repository) {
			throw new ConvexError("Repository not found");
		}

		await ctx.db.patch(args.id, { updatedAt: Date.now() });
	},
});

export const internalGetByGithubRepoId = internalQuery({
	args: { githubRepoId: v.number() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("repositories")
			.withIndex("by_github_repo", (q) =>
				q.eq("githubRepoId", args.githubRepoId)
			)
			.collect();
	},
});
