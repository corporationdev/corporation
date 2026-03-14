import { ConvexError, v } from "convex/values";
import { asyncMap } from "convex-helpers";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { buildConvexPatch } from "./lib/patch";
import { requireProjectInActiveOrg } from "./lib/projectAccess";
import { spaceBootstrapSourceValidator, spaceStatusValidator } from "./schema";

async function requireOwnedSpace(
	ctx: QueryCtx & { userId: string; activeOrganizationId: string | null },
	space: Doc<"spaces">
): Promise<{
	space: Doc<"spaces">;
	project: Doc<"projects">;
}> {
	if (space.userId !== ctx.userId) {
		throw new ConvexError("Space not found");
	}

	const project = requireProjectInActiveOrg(
		await ctx.db.get(space.projectId),
		ctx.activeOrganizationId,
		"Space",
		{ allowBase: true }
	);

	return { space, project };
}

async function requireProjectAccess(
	ctx: QueryCtx & { activeOrganizationId: string | null },
	projectId: Id<"projects">,
	options?: { allowBase?: boolean }
): Promise<Doc<"projects">> {
	return requireProjectInActiveOrg(
		await ctx.db.get(projectId),
		ctx.activeOrganizationId,
		"Project",
		options
	);
}

type EnsureSpaceInput = {
	slug: string;
	userId: string;
	project: Doc<"projects">;
	bootstrapSource?: "snapshot" | "base-template";
	snapshotId?: Id<"snapshots">;
	name?: string;
	firstMessage?: string;
};

type SpaceUpdatePatch = {
	bootstrapSource?: Doc<"spaces">["bootstrapSource"];
	status?: Doc<"spaces">["status"];
	snapshotId?: Id<"snapshots">;
	error?: string;
};

type InternalSpaceUpdatePatch = SpaceUpdatePatch & {
	name?: string;
};

function buildExistingSpacePatch(
	existing: Doc<"spaces">,
	args: EnsureSpaceInput,
	bootstrapSource: "snapshot" | "base-template"
) {
	if (existing.status === "running") {
		return null;
	}

	const shouldUpdateSnapshot =
		bootstrapSource === "snapshot" &&
		args.snapshotId !== undefined &&
		existing.snapshotId !== args.snapshotId;
	const shouldUpdateBootstrapSource =
		existing.bootstrapSource !== bootstrapSource;

	if (!(shouldUpdateSnapshot || shouldUpdateBootstrapSource)) {
		return null;
	}

	return {
		bootstrapSource,
		...(shouldUpdateSnapshot && args.snapshotId !== undefined
			? {
					snapshotId: args.snapshotId,
				}
			: {}),
		updatedAt: Date.now(),
	};
}

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

export async function resolveSnapshotIdForProject(
	ctx: MutationCtx,
	project: Doc<"projects">,
	requestedSnapshotId?: Id<"snapshots">
): Promise<Id<"snapshots">> {
	if (requestedSnapshotId) {
		await requireReadySnapshot(ctx, project, requestedSnapshotId);
		return requestedSnapshotId;
	}

	const latestReadySnapshot = (
		await ctx.db
			.query("snapshots")
			.withIndex("by_project_and_startedAt", (q) =>
				q.eq("projectId", project._id)
			)
			.order("desc")
			.collect()
	).find(
		(snapshot) => snapshot.status === "ready" && snapshot.externalSnapshotId
	);

	if (latestReadySnapshot) {
		return latestReadySnapshot._id;
	}

	if (project.defaultSnapshotId) {
		await requireReadySnapshot(ctx, project, project.defaultSnapshotId);
		return project.defaultSnapshotId;
	}

	throw new ConvexError("Project does not have a ready snapshot");
}

export async function ensureSpaceRecord(
	ctx: MutationCtx,
	args: EnsureSpaceInput
): Promise<Id<"spaces">> {
	const bootstrapSource = args.bootstrapSource ?? "snapshot";
	if (bootstrapSource === "snapshot" && !args.snapshotId) {
		throw new ConvexError("Snapshot is required for snapshot bootstraps");
	}

	const slug = args.slug.trim();
	const existing = await ctx.db
		.query("spaces")
		.withIndex("by_slug", (q) => q.eq("slug", slug))
		.unique();

	if (existing) {
		if (
			existing.projectId !== args.project._id ||
			existing.userId !== args.userId
		) {
			throw new ConvexError("Space slug already belongs to another space");
		}

		const patch = buildExistingSpacePatch(existing, args, bootstrapSource);
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
		userId: args.userId,
		slug,
		projectId: args.project._id,
		bootstrapSource,
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
		const spaces = await ctx.db
			.query("spaces")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		const visibleSpaces = (
			await asyncMap(spaces, async (space) => {
				try {
					requireProjectInActiveOrg(
						await ctx.db.get(space.projectId),
						ctx.activeOrganizationId,
						"Space"
					);
				} catch {
					return null;
				}
				return space;
			})
		).filter((space): space is Doc<"spaces"> => !!space);

		visibleSpaces.sort((a, b) => b.updatedAt - a.updatedAt);
		return visibleSpaces.filter((space) => !space.archived);
	},
});

export const listByProject = authedQuery({
	args: {},
	handler: async (ctx) => {
		const activeOrganizationId = ctx.activeOrganizationId;
		if (!activeOrganizationId) {
			return [];
		}

		const projects = (
			await ctx.db
				.query("projects")
				.withIndex("by_organization", (q) =>
					q.eq("organizationId", activeOrganizationId)
				)
				.collect()
		).filter((project) => project.kind === "standard");

		const spacesByProject = new Map<Id<"projects">, Doc<"spaces">[]>();
		const projectSpaces = await asyncMap(projects, async (project) => ({
			projectId: project._id,
			spaces: await ctx.db
				.query("spaces")
				.withIndex("by_user_and_project", (q) =>
					q.eq("userId", ctx.userId).eq("projectId", project._id)
				)
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
		const { project, space: ownedSpace } = await requireOwnedSpace(ctx, space);

		return {
			...ownedSpace,
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
		const { project, space: ownedSpace } = await requireOwnedSpace(ctx, space);

		return {
			...ownedSpace,
			project,
		};
	},
});

export const update = authedMutation({
	args: {
		id: v.id("spaces"),
		bootstrapSource: v.optional(spaceBootstrapSourceValidator),
		status: v.optional(spaceStatusValidator),
		snapshotId: v.optional(v.id("snapshots")),
		error: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		const patch = buildConvexPatch<SpaceUpdatePatch, typeof args>(args, {
			assign: ["bootstrapSource", "status", "snapshotId"],
			clearable: ["error"],
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
		bootstrapSource: v.optional(spaceBootstrapSourceValidator),
		status: v.optional(spaceStatusValidator),
		snapshotId: v.optional(v.id("snapshots")),
		error: v.optional(v.union(v.string(), v.null())),
		name: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const patch = buildConvexPatch<InternalSpaceUpdatePatch, typeof args>(
			args,
			{
				assign: ["bootstrapSource", "status", "snapshotId", "name"],
				clearable: ["error"],
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

export const internalGetByUserAndProject = internalQuery({
	args: {
		userId: v.string(),
		projectId: v.id("projects"),
	},
	handler: async (ctx, args) => {
		const spaces = await ctx.db
			.query("spaces")
			.withIndex("by_user_and_project", (q) =>
				q.eq("userId", args.userId).eq("projectId", args.projectId)
			)
			.collect();

		const activeSpaces = spaces.filter((space) => !space.archived);
		activeSpaces.sort((a, b) => b.updatedAt - a.updatedAt);
		return activeSpaces[0] ?? null;
	},
});

// TODO: migrate to use environments table - sandboxId is now tracked on environments
export const getBySandboxId = internalQuery({
	args: { sandboxId: v.string() },
	handler: async (ctx, args) => {
		const spaces = await ctx.db.query("spaces").collect();
		return (
			spaces.find(
				(s) => (s as Record<string, unknown>).sandboxId === args.sandboxId
			) ?? null
		);
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
		bootstrapSource: v.optional(spaceBootstrapSourceValidator),
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
				userId: ctx.userId,
				project,
				bootstrapSource: args.bootstrapSource,
				snapshotId,
				firstMessage: args.firstMessage,
			});
		}

		if (!args.projectId) {
			throw new ConvexError("projectId is required when creating a space");
		}

		const project = await requireProjectAccess(ctx, args.projectId);
		const bootstrapSource = args.bootstrapSource ?? "snapshot";
		const snapshotId =
			bootstrapSource === "snapshot"
				? await resolveSnapshotIdForProject(ctx, project, args.snapshotId)
				: undefined;

		return await ensureSpaceRecord(ctx, {
			slug,
			userId: ctx.userId,
			project,
			bootstrapSource,
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

		// TODO: migrate to use environments table
		const sandboxId = (space as Record<string, unknown>).sandboxId as
			| string
			| undefined;
		if (sandboxId) {
			await ctx.scheduler.runAfter(0, internal.sandboxActions.archiveSandbox, {
				sandboxId,
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
		// TODO: migrate to use environments table
		const hasSandboxId = !!(space as Record<string, unknown>).sandboxId;
		if (
			!(
				hasSandboxId ||
				space.snapshotId ||
				space.bootstrapSource === "base-template"
			)
		) {
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
		// TODO: migrate to use environments table
		if (
			space.status !== "running" ||
			!(space as Record<string, unknown>).sandboxId
		) {
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

		// TODO: migrate to use environments table
		const sandboxId = (space as Record<string, unknown>).sandboxId as
			| string
			| undefined;
		await ctx.db.delete(args.id);

		if (sandboxId) {
			await ctx.scheduler.runAfter(0, internal.sandboxActions.deleteSandbox, {
				sandboxId,
			});
		}
	},
});
export { del as delete };
