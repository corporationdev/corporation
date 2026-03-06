import { ConvexError, v } from "convex/values";
import { asyncMap } from "convex-helpers";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { generateBranchName, isGeneratedBranchName } from "./lib/branchName";
import { normalizeBranchName } from "./lib/git";
import { getSandboxWorkdir } from "./lib/sandbox";
import { spaceStatusValidator } from "./schema";
import { withDerivedSnapshotState } from "./snapshot";

async function requireOwnedSpace(
	ctx: QueryCtx & { userId: string },
	space: Doc<"spaces">
): Promise<{
	space: Doc<"spaces">;
	repository: Doc<"repositories">;
}> {
	const repository = await ctx.db.get(space.repositoryId);
	if (!repository || repository.userId !== ctx.userId) {
		throw new ConvexError("Space not found");
	}

	return { space, repository };
}

type BranchRenameCtx = Pick<MutationCtx, "db" | "scheduler">;

function parseBranchNameOrThrow(branchName: string): string {
	try {
		return normalizeBranchName(branchName);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Invalid branch name";
		throw new ConvexError(message);
	}
}

async function applyBranchNameUpdate(
	ctx: BranchRenameCtx,
	space: Doc<"spaces">,
	branchName: string
): Promise<void> {
	const newBranchName = parseBranchNameOrThrow(branchName);
	const oldBranchName = space.branchName;
	if (oldBranchName === newBranchName) {
		return;
	}

	if (space.sandboxId && space.status === "running") {
		await ctx.db.patch(space._id, {
			error: "",
		});
		await ctx.scheduler.runAfter(0, internal.sandboxActions.renameBranch, {
			spaceId: space._id,
			oldBranchName,
			newBranchName,
		});
		return;
	}

	await ctx.db.patch(space._id, {
		branchName: newBranchName,
		error: "",
	});
}

export const list = authedQuery({
	args: {},
	handler: async (ctx) => {
		const repositories = await ctx.db
			.query("repositories")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		const spaces = (
			await asyncMap(repositories, (repository) =>
				ctx.db
					.query("spaces")
					.withIndex("by_repository", (q) =>
						q.eq("repositoryId", repository._id)
					)
					.collect()
			)
		).flat();

		spaces.sort((a, b) => b.updatedAt - a.updatedAt);
		return spaces.filter((s) => !s.archived);
	},
});

export const listByRepository = authedQuery({
	args: {},
	handler: async (ctx) => {
		const repositories = await ctx.db
			.query("repositories")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		const spacesByRepository = new Map<Id<"repositories">, Doc<"spaces">[]>();
		const repositorySpaces = await asyncMap(
			repositories,
			async (repository) => ({
				repositoryId: repository._id,
				spaces: await ctx.db
					.query("spaces")
					.withIndex("by_repository", (q) =>
						q.eq("repositoryId", repository._id)
					)
					.collect(),
			})
		);
		for (const { repositoryId, spaces } of repositorySpaces) {
			spacesByRepository.set(repositoryId, spaces);
		}

		const grouped = await asyncMap(repositories, async (repository) => {
			const spaces = (spacesByRepository.get(repository._id) ?? []).filter(
				(space) => !space.archived
			);
			spaces.sort((a, b) => b.updatedAt - a.updatedAt);

			return {
				repository,
				defaultEnvironment: await withDerivedSnapshotState(ctx, repository),
				spaces,
			};
		});

		grouped.sort((a, b) => {
			const aName = `${a.repository.owner}/${a.repository.name}`;
			const bName = `${b.repository.owner}/${b.repository.name}`;
			return aName.localeCompare(bName);
		});
		return grouped;
	},
});

export const getBySlug = authedQuery({
	args: { slug: v.string() },
	handler: async (ctx, args) => {
		const space = await ctx.db
			.query("spaces")
			.withIndex("by_slug", (q) => q.eq("slug", args.slug))
			.unique();
		if (!space) {
			return null;
		}
		const { repository } = await requireOwnedSpace(ctx, space);
		const repositoryWithSnapshot = await withDerivedSnapshotState(
			ctx,
			repository
		);

		return {
			...space,
			workdir: getSandboxWorkdir(repository),
			environment: {
				...repositoryWithSnapshot,
				repository,
			},
		};
	},
});

export const get = authedQuery({
	args: { id: v.id("spaces") },
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		const { repository } = await requireOwnedSpace(ctx, space);
		const repositoryWithSnapshot = await withDerivedSnapshotState(
			ctx,
			repository
		);

		return {
			...space,
			workdir: getSandboxWorkdir(repository),
			environment: {
				...repositoryWithSnapshot,
				repository,
			},
		};
	},
});

export const update = authedMutation({
	args: {
		id: v.id("spaces"),
		status: v.optional(spaceStatusValidator),
		sandboxId: v.optional(v.string()),
		agentUrl: v.optional(v.string()),
		error: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries(fields).filter(([, v]) => v !== undefined)
		);

		await ctx.db.patch(id, patch);
	},
});

export const touch = authedMutation({
	args: {
		id: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);
		await ctx.db.patch(args.id, { updatedAt: Date.now() });
	},
});

export const internalUpdate = internalMutation({
	args: {
		id: v.id("spaces"),
		status: v.optional(spaceStatusValidator),
		sandboxId: v.optional(v.string()),
		agentUrl: v.optional(v.string()),
		lastSyncedCommitSha: v.optional(v.string()),
		prUrl: v.optional(v.string()),
		error: v.optional(v.string()),
		branchName: v.optional(v.string()),
		sandboxExpiresAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries(fields).filter(([, val]) => val !== undefined)
		);
		await ctx.db.patch(id, patch);
	},
});

export const internalUpdateBranchName = internalMutation({
	args: {
		id: v.id("spaces"),
		expectedBranchName: v.string(),
		branchName: v.string(),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		if (space.branchName !== args.expectedBranchName) {
			return;
		}

		await applyBranchNameUpdate(ctx, space, args.branchName);
	},
});

export const internalGet = internalQuery({
	args: { id: v.id("spaces") },
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}

		const repository = await ctx.db.get(space.repositoryId);
		if (!repository) {
			throw new ConvexError("Repository not found");
		}
		const repositoryWithSnapshot = await withDerivedSnapshotState(
			ctx,
			repository
		);

		return {
			...space,
			environment: { ...repositoryWithSnapshot, repository },
		};
	},
});

export const getBySandboxId = internalQuery({
	args: { sandboxId: v.string() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("spaces")
			.withIndex("by_sandboxId", (q) => q.eq("sandboxId", args.sandboxId))
			.unique();
	},
});

export const requestAutoBranchRename = internalMutation({
	args: {
		spaceId: v.id("spaces"),
		firstMessage: v.string(),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.spaceId);
		if (!space) {
			throw new ConvexError("Space not found");
		}

		const firstMessage = args.firstMessage.trim();
		if (!(firstMessage && isGeneratedBranchName(space.branchName))) {
			return;
		}

		await ctx.scheduler.runAfter(
			0,
			internal.spaceBranchActions.generateAndApplyBranchName,
			{
				spaceId: args.spaceId,
				oldBranchName: space.branchName,
				firstMessage: firstMessage.slice(0, 2000),
			}
		);
	},
});

export const stop = authedMutation({
	args: {
		id: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		await ctx.scheduler.runAfter(0, internal.sandboxActions.stopSandbox, {
			spaceId: args.id,
		});
	},
});

export const ensure = authedMutation({
	args: {
		slug: v.string(),
		repositoryId: v.optional(v.id("repositories")),
	},
	handler: async (ctx, args) => {
		const slug = args.slug.trim();

		// Look up by slug — may already exist from a prior call
		const existing = await ctx.db
			.query("spaces")
			.withIndex("by_slug", (q) => q.eq("slug", slug))
			.unique();
		if (existing) {
			await requireOwnedSpace(ctx, existing);
			if (existing.status !== "running") {
				await ctx.scheduler.runAfter(0, internal.sandboxActions.ensureSandbox, {
					spaceId: existing._id,
				});
			}
			return existing._id;
		}

		if (!args.repositoryId) {
			throw new ConvexError("repositoryId is required when creating a space");
		}

		const repository = await ctx.db.get(args.repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Repository not found");
		}

		const now = Date.now();
		const spaceId = await ctx.db.insert("spaces", {
			slug,
			repositoryId: args.repositoryId,
			branchName: generateBranchName(),
			status: "creating",
			createdAt: now,
			updatedAt: now,
		});

		await ctx.scheduler.runAfter(0, internal.sandboxActions.ensureSandbox, {
			spaceId,
		});

		return spaceId;
	},
});

export const archive = authedMutation({
	args: {
		id: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		await ctx.db.patch(args.id, {
			archived: true,
			updatedAt: Date.now(),
		});

		if (space.sandboxId) {
			await ctx.scheduler.runAfter(0, internal.sandboxActions.archiveSandbox, {
				sandboxId: space.sandboxId,
			});
		}
	},
});

export const updateBranchName = authedMutation({
	args: {
		id: v.id("spaces"),
		branchName: v.string(),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		await applyBranchNameUpdate(ctx, space, args.branchName);
	},
});

export const createPullRequest = authedMutation({
	args: {
		id: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		if (space.status !== "running") {
			throw new ConvexError("Space must be running to create a pull request");
		}

		if (space.prUrl) {
			throw new ConvexError("Pull request already exists");
		}

		await ctx.scheduler.runAfter(0, internal.sandboxActions.pushAndCreatePR, {
			spaceId: args.id,
		});
	},
});

export const pushCode = authedMutation({
	args: {
		id: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		if (space.status !== "running") {
			throw new ConvexError("Space must be running to push code");
		}

		if (!space.prUrl) {
			throw new ConvexError("No pull request exists yet");
		}

		await ctx.scheduler.runAfter(0, internal.sandboxActions.pushCode, {
			spaceId: args.id,
		});
	},
});

const del = authedMutation({
	args: {
		id: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		const { sandboxId } = space;
		await ctx.db.delete(args.id);

		if (sandboxId) {
			await ctx.scheduler.runAfter(0, internal.sandboxActions.deleteSandbox, {
				sandboxId,
			});
		}
	},
});
export { del as delete };
