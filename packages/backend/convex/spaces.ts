import { ConvexError, v } from "convex/values";
import { asyncMap } from "convex-helpers";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { buildConvexPatch } from "./lib/patch";
import { spaceStatusValidator } from "./schema";

async function requireOwnedSpace(
	ctx: QueryCtx & { userId: string },
	space: Doc<"spaces">
): Promise<{
	space: Doc<"spaces">;
	project: Doc<"projects">;
}> {
	if (!space.projectId) {
		throw new ConvexError("Space not found");
	}
	const project = await ctx.db.get(space.projectId);
	if (!project || project.userId !== ctx.userId) {
		throw new ConvexError("Space not found");
	}

	return { space, project };
}

type EnsureSpaceInput = {
	slug: string;
	project: Doc<"projects">;
	snapshotId?: Id<"snapshots">;
	name?: string;
	firstMessage?: string;
};

type SpaceUpdatePatch = {
	status?: Doc<"spaces">["status"];
	snapshotId?: Id<"snapshots">;
	sandboxId?: string;
	agentUrl?: string;
	error?: string;
};

type InternalSpaceUpdatePatch = SpaceUpdatePatch & {
	name?: string;
};

async function requireReadySnapshot(
	ctx: MutationCtx,
	project: Doc<"projects">,
	snapshotId: Id<"snapshots">
): Promise<Doc<"snapshots">> {
	const snapshot = await ctx.db.get(snapshotId);
	if (!snapshot || snapshot.projectId !== project._id) {
		throw new ConvexError("Snapshot not found");
	}
	if (snapshot.status !== "ready" || !snapshot.externalSnapshotId) {
		throw new ConvexError("Snapshot is not ready");
	}
	return snapshot;
}

export async function ensureSpaceRecord(
	ctx: MutationCtx,
	args: EnsureSpaceInput
): Promise<Id<"spaces">> {
	const slug = args.slug.trim();
	const existing = await ctx.db
		.query("spaces")
		.withIndex("by_slug", (q) => q.eq("slug", slug))
		.unique();

	if (existing) {
		if (existing.projectId !== args.project._id) {
			throw new ConvexError("Space slug already belongs to another project");
		}

		const patch =
			existing.status !== "running" &&
			args.snapshotId !== undefined &&
			existing.snapshotId !== args.snapshotId
				? {
						snapshotId: args.snapshotId,
						updatedAt: Date.now(),
					}
				: null;
		if (patch) {
			await ctx.db.patch(existing._id, patch);
		}

		if (existing.status !== "running") {
			await ctx.scheduler.runAfter(
				0,
				internal.sandboxActions.provisionForSpace,
				{
					spaceId: existing._id,
				}
			);
		}
		return existing._id;
	}

	const now = Date.now();
	const spaceId = await ctx.db.insert("spaces", {
		slug,
		projectId: args.project._id,
		snapshotId: args.snapshotId,
		name: args.name ?? "New Space",
		status: "creating",
		createdAt: now,
		updatedAt: now,
	});

	await ctx.scheduler.runAfter(0, internal.sandboxActions.provisionForSpace, {
		spaceId,
	});

	if (args.firstMessage) {
		await ctx.scheduler.runAfter(0, internal.spaces.requestAutoRename, {
			spaceId,
			firstMessage: args.firstMessage,
		});
	}

	return spaceId;
}

export const list = authedQuery({
	args: {},
	handler: async (ctx) => {
		const projects = (
			await ctx.db
				.query("projects")
				.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
				.collect()
		).filter((project) => project.type === "workspace");

		const spaces = (
			await asyncMap(projects, (project) =>
				ctx.db
					.query("spaces")
					.withIndex("by_project", (q) => q.eq("projectId", project._id))
					.collect()
			)
		).flat();

		spaces.sort((a, b) => b.updatedAt - a.updatedAt);
		return spaces.filter((s) => !s.archived);
	},
});

export const listByProject = authedQuery({
	args: {},
	handler: async (ctx) => {
		const projects = (
			await ctx.db
				.query("projects")
				.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
				.collect()
		).filter((project) => project.type === "workspace");

		const spacesByProject = new Map<Id<"projects">, Doc<"spaces">[]>();
		const projectSpaces = await asyncMap(projects, async (project) => ({
			projectId: project._id,
			spaces: await ctx.db
				.query("spaces")
				.withIndex("by_project", (q) => q.eq("projectId", project._id))
				.collect(),
		}));
		for (const { projectId, spaces } of projectSpaces) {
			spacesByProject.set(projectId, spaces);
		}

		const grouped = projects.map((project) => {
			const spaces = (spacesByProject.get(project._id) ?? []).filter(
				(space) => !space.archived
			);
			spaces.sort((a, b) => b.updatedAt - a.updatedAt);

			return {
				project,
				spaces,
			};
		});

		grouped.sort((a, b) => a.project.name.localeCompare(b.project.name));
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
		const { project } = await requireOwnedSpace(ctx, space);

		return {
			...space,
			project,
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
		const { project } = await requireOwnedSpace(ctx, space);

		return {
			...space,
			project,
		};
	},
});

export const update = authedMutation({
	args: {
		id: v.id("spaces"),
		status: v.optional(spaceStatusValidator),
		snapshotId: v.optional(v.id("snapshots")),
		sandboxId: v.optional(v.union(v.string(), v.null())),
		agentUrl: v.optional(v.union(v.string(), v.null())),
		error: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		const patch = buildConvexPatch<SpaceUpdatePatch, typeof args>(args, {
			assign: ["status", "snapshotId"],
			clearable: ["sandboxId", "agentUrl", "error"],
		});

		await ctx.db.patch(args.id, patch);
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
		snapshotId: v.optional(v.id("snapshots")),
		sandboxId: v.optional(v.union(v.string(), v.null())),
		agentUrl: v.optional(v.union(v.string(), v.null())),
		error: v.optional(v.union(v.string(), v.null())),
		name: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const patch = buildConvexPatch<InternalSpaceUpdatePatch, typeof args>(
			args,
			{
				assign: ["status", "snapshotId", "name"],
				clearable: ["sandboxId", "agentUrl", "error"],
			}
		);

		await ctx.db.patch(args.id, patch);
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

		const project = await ctx.db.get(space.projectId);
		if (!project) {
			throw new ConvexError("Project not found");
		}

		return {
			...space,
			project,
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
		projectId: v.optional(v.id("projects")),
		snapshotId: v.optional(v.id("snapshots")),
		firstMessage: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const slug = args.slug.trim();

		const existing = await ctx.db
			.query("spaces")
			.withIndex("by_slug", (q) => q.eq("slug", slug))
			.unique();
		if (existing) {
			const { project } = await requireOwnedSpace(ctx, existing);
			if (args.projectId && args.projectId !== project._id) {
				throw new ConvexError("Space slug already belongs to another project");
			}

			const snapshotId = args.snapshotId;
			if (snapshotId) {
				await requireReadySnapshot(ctx, project, snapshotId);
			}

			return await ensureSpaceRecord(ctx, {
				slug,
				project,
				snapshotId,
				firstMessage: args.firstMessage,
			});
		}

		if (!args.projectId) {
			throw new ConvexError("projectId is required when creating a space");
		}

		const projectId = args.projectId;

		const project = await ctx.db.get(projectId);
		if (!project || project.userId !== ctx.userId) {
			throw new ConvexError("Project not found");
		}

		const snapshotId =
			args.snapshotId ?? project.defaultSnapshotId ?? undefined;
		if (!snapshotId) {
			throw new ConvexError("Project does not have a default snapshot");
		}
		await requireReadySnapshot(ctx, project, snapshotId);

		return await ensureSpaceRecord(ctx, {
			slug,
			project,
			snapshotId,
			firstMessage: args.firstMessage,
		});
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

export const startSandbox = authedMutation({
	args: {
		id: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		if (space.status === "running" || space.status === "creating") {
			return;
		}
		if (!(space.sandboxId || space.snapshotId)) {
			throw new ConvexError("Sandbox cannot be started");
		}

		await ctx.db.patch(args.id, {
			status: "creating",
			updatedAt: Date.now(),
		});

		await ctx.scheduler.runAfter(0, internal.sandboxActions.provisionForSpace, {
			spaceId: args.id,
		});
	},
});

export const pauseSandbox = authedMutation({
	args: {
		id: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		if (space.status === "paused") {
			return;
		}
		if (space.status !== "running" || !space.sandboxId) {
			throw new ConvexError("Sandbox is not running");
		}

		await ctx.db.patch(args.id, {
			status: "paused",
			updatedAt: Date.now(),
		});

		await ctx.scheduler.runAfter(0, internal.sandboxActions.pauseForSpace, {
			spaceId: args.id,
		});
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
