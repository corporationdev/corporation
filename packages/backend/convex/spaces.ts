import { ConvexError, v } from "convex/values";
import { asyncMap } from "convex-helpers";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
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
	if (!space.repositoryId) {
		throw new ConvexError("Space not found");
	}
	const repository = await ctx.db.get(space.repositoryId);
	if (!repository || repository.userId !== ctx.userId) {
		throw new ConvexError("Space not found");
	}

	return { space, repository };
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
			const repositoryWithSnapshots = await withDerivedSnapshotState(
				ctx,
				repository
			);

			return {
				repository: repositoryWithSnapshots,
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
			repository: repositoryWithSnapshot,
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
			repository: repositoryWithSnapshot,
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
		error: v.optional(v.string()),
		name: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries(fields).filter(([, val]) => val !== undefined)
		);
		await ctx.db.patch(id, patch);
	},
});

export const internalUpdateName = internalMutation({
	args: {
		id: v.id("spaces"),
		expectedName: v.string(),
		name: v.string(),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		if (space.name !== args.expectedName) {
			return;
		}

		await ctx.db.patch(space._id, { name: args.name });
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
			repository: repositoryWithSnapshot,
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

export const requestAutoRename = internalMutation({
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
		if (!(firstMessage && space.name === "New Space")) {
			return;
		}

		await ctx.scheduler.runAfter(
			0,
			internal.spaceBranchActions.generateAndApplyName,
			{
				spaceId: args.spaceId,
				oldName: space.name,
				firstMessage: firstMessage.slice(0, 2000),
			}
		);
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
				await ctx.scheduler.runAfter(
					0,
					internal.sandboxActions.provisionForSpace,
					{ spaceId: existing._id }
				);
			}
			return existing._id;
		}

		if (!args.repositoryId) {
			throw new ConvexError("repositoryId is required when creating a space");
		}

		const repositoryId = args.repositoryId;

		const repository = await ctx.db.get(repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Repository not found");
		}

		// Check for a warm sandbox for this repo
		const warmSandbox = await ctx.db
			.query("warmSandboxes")
			.withIndex("by_user_and_repository", (q) =>
				q.eq("userId", ctx.userId).eq("repositoryId", repositoryId)
			)
			.first();

		const now = Date.now();

		if (
			warmSandbox?.status === "ready" &&
			warmSandbox.sandboxId &&
			warmSandbox.agentUrl
		) {
			// Warm sandbox is ready — claim it immediately
			const spaceId = await ctx.db.insert("spaces", {
				slug,
				repositoryId,
				name: "New Space",
				status: "running",
				sandboxId: warmSandbox.sandboxId,
				agentUrl: warmSandbox.agentUrl,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.delete(warmSandbox._id);
			return spaceId;
		}

		if (warmSandbox?.status === "provisioning") {
			// Warm sandbox is still provisioning — hand off via spaceId
			const spaceId = await ctx.db.insert("spaces", {
				slug,
				repositoryId,
				name: "New Space",
				status: "creating",
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.patch(warmSandbox._id, { spaceId });
			return spaceId;
		}

		// No warm sandbox available — cold start
		const spaceId = await ctx.db.insert("spaces", {
			slug,
			repositoryId,
			name: "New Space",
			status: "creating",
			createdAt: now,
			updatedAt: now,
		});

		await ctx.scheduler.runAfter(0, internal.sandboxActions.provisionForSpace, {
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

export const updateName = authedMutation({
	args: {
		id: v.id("spaces"),
		name: v.string(),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		const name = args.name.trim();
		if (!name) {
			throw new ConvexError("Name cannot be empty");
		}
		if (name === space.name) {
			return;
		}

		await ctx.db.patch(space._id, { name });
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
