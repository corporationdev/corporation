import { ConvexError, v } from "convex/values";
import { asyncMap } from "convex-helpers";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { buildConvexPatch } from "./lib/patch";
import { requireProjectInActiveOrg } from "./lib/projectAccess";
import {
	sandboxStatusValidator,
	spaceBootstrapSourceValidator,
} from "./schema";

type SandboxBootstrapInput =
	| {
			bootstrapSource?: "snapshot";
			snapshotId?: Id<"snapshots">;
	  }
	| {
			bootstrapSource: "base-template";
	  };

type CreateSpaceInput = {
	slug: string;
	userId: string;
	project: Doc<"projects">;
	name?: string;
	firstMessage?: string;
};

type SandboxUpdatePatch = {
	status?: Doc<"sandboxes">["status"];
	externalSandboxId?: string;
	snapshotId?: Id<"snapshots">;
	bootstrapSource?: Doc<"sandboxes">["bootstrapSource"];
	error?: string;
};

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

async function requireDefaultSnapshotIdForProject(
	ctx: MutationCtx,
	project: Doc<"projects">
): Promise<Id<"snapshots">> {
	if (!project.defaultSnapshotId) {
		throw new ConvexError("Project does not have a default snapshot");
	}

	await requireReadySnapshot(ctx, project, project.defaultSnapshotId);
	return project.defaultSnapshotId;
}

async function requireConnectedEnvironment(
	ctx: MutationCtx,
	userId: string,
	environmentId: Id<"environments">
): Promise<Doc<"environments">> {
	const environment = await ctx.db.get(environmentId);
	if (!environment || environment.userId !== userId) {
		throw new ConvexError("Environment not found");
	}
	if (environment.status !== "connected") {
		throw new ConvexError("Environment is not connected");
	}
	return environment;
}

async function getSandboxForSpace(
	ctx: Pick<QueryCtx, "db">,
	spaceId: Id<"spaces">
): Promise<Doc<"sandboxes"> | null> {
	return (
		(await ctx.db
			.query("sandboxes")
			.withIndex("by_space", (q) => q.eq("spaceId", spaceId))
			.unique()) ?? null
	);
}

async function getActiveEnvironmentForSpace(
	ctx: Pick<QueryCtx, "db">,
	space: Doc<"spaces">,
	sandbox: Doc<"sandboxes"> | null
): Promise<Doc<"environments"> | null> {
	const activeBacking = space.activeBacking;
	if (!activeBacking) {
		return null;
	}

	if (activeBacking.type === "environment") {
		return (await ctx.db.get(activeBacking.environmentId)) ?? null;
	}

	if (!sandbox?.externalSandboxId) {
		return null;
	}
	const externalSandboxId = sandbox.externalSandboxId;

	return (
		(await ctx.db
			.query("environments")
			.withIndex("by_user_and_clientId", (q) =>
				q.eq("userId", space.userId).eq("clientId", externalSandboxId)
			)
			.unique()) ?? null
	);
}

async function buildSpaceResult(
	ctx: Pick<QueryCtx, "db">,
	space: Doc<"spaces">,
	project: Doc<"projects">
) {
	const sandbox = await getSandboxForSpace(ctx, space._id);
	const activeEnvironment = await getActiveEnvironmentForSpace(
		ctx,
		space,
		sandbox
	);

	return {
		...space,
		project,
		sandbox,
		activeEnvironment,
	};
}

async function maybeScheduleAutoRename(
	ctx: MutationCtx,
	spaceId: Id<"spaces">,
	firstMessage?: string
) {
	if (!firstMessage) {
		return;
	}

	await ctx.scheduler.runAfter(0, internal.spaces.requestAutoRename, {
		spaceId,
		firstMessage,
	});
}

export async function createSpaceRecord(
	ctx: MutationCtx,
	args: CreateSpaceInput
): Promise<Id<"spaces">> {
	const slug = args.slug.trim();
	if (!slug) {
		throw new ConvexError("Space slug is required");
	}

	const existing = await ctx.db
		.query("spaces")
		.withIndex("by_slug", (q) => q.eq("slug", slug))
		.unique();
	if (existing) {
		throw new ConvexError("Space slug already belongs to another space");
	}

	const now = Date.now();
	const spaceId = await ctx.db.insert("spaces", {
		userId: args.userId,
		slug,
		projectId: args.project._id,
		name: args.name ?? "New Space",
		createdAt: now,
		updatedAt: now,
	});

	await maybeScheduleAutoRename(ctx, spaceId, args.firstMessage);

	return spaceId;
}

export async function ensureSandboxRecordForSpace(
	ctx: MutationCtx,
	space: Doc<"spaces">,
	project: Doc<"projects">,
	options?: SandboxBootstrapInput
): Promise<Id<"sandboxes">> {
	const bootstrapSource = options?.bootstrapSource ?? "snapshot";
	const requestedSnapshotId =
		options && "snapshotId" in options ? options.snapshotId : undefined;
	const snapshotId =
		bootstrapSource === "snapshot"
			? (requestedSnapshotId ??
				(await requireDefaultSnapshotIdForProject(ctx, project)))
			: undefined;

	const existingSandbox = await getSandboxForSpace(ctx, space._id);
	if (existingSandbox) {
		const hasSnapshotChanged =
			bootstrapSource === "snapshot" &&
			existingSandbox.snapshotId !== snapshotId;
		const hasBootstrapChanged =
			existingSandbox.bootstrapSource !== bootstrapSource;
		const shouldReprovision =
			hasSnapshotChanged ||
			hasBootstrapChanged ||
			(existingSandbox.status !== "running" &&
				existingSandbox.status !== "creating");

		if (hasSnapshotChanged || hasBootstrapChanged) {
			await ctx.db.patch(existingSandbox._id, {
				bootstrapSource,
				snapshotId,
				updatedAt: Date.now(),
			});
		}

		if (
			space.activeBacking?.type !== "sandbox" ||
			space.activeBacking.sandboxId !== existingSandbox._id
		) {
			await ctx.db.patch(space._id, {
				activeBacking: {
					type: "sandbox",
					sandboxId: existingSandbox._id,
				},
				updatedAt: Date.now(),
			});
		}

		if (shouldReprovision) {
			await ctx.scheduler.runAfter(
				0,
				internal.sandboxActions.provisionForSpace,
				{
					spaceId: space._id,
				}
			);
		}

		return existingSandbox._id;
	}

	const now = Date.now();
	const sandboxId = await ctx.db.insert("sandboxes", {
		spaceId: space._id,
		status: "provisioning",
		snapshotId,
		bootstrapSource,
		createdAt: now,
		updatedAt: now,
	});

	await ctx.db.patch(space._id, {
		activeBacking: {
			type: "sandbox",
			sandboxId,
		},
		updatedAt: now,
	});

	await ctx.scheduler.runAfter(0, internal.sandboxActions.provisionForSpace, {
		spaceId: space._id,
	});

	return sandboxId;
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
		return await buildSpaceResult(ctx, ownedSpace, project);
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
		return await buildSpaceResult(ctx, ownedSpace, project);
	},
});

export const create = authedMutation({
	args: {
		slug: v.string(),
		projectId: v.id("projects"),
		name: v.optional(v.string()),
		firstMessage: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const project = await requireProjectAccess(ctx, args.projectId);
		return await createSpaceRecord(ctx, {
			slug: args.slug,
			userId: ctx.userId,
			project,
			name: args.name,
			firstMessage: args.firstMessage,
		});
	},
});

export const attachEnvironment = authedMutation({
	args: {
		id: v.id("spaces"),
		environmentId: v.id("environments"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}

		await requireOwnedSpace(ctx, space);
		await requireConnectedEnvironment(ctx, ctx.userId, args.environmentId);

		await ctx.db.patch(space._id, {
			activeBacking: {
				type: "environment",
				environmentId: args.environmentId,
			},
			updatedAt: Date.now(),
		});
	},
});

export const ensureSandbox = authedMutation({
	args: {
		id: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}

		const { project, space: ownedSpace } = await requireOwnedSpace(ctx, space);
		return await ensureSandboxRecordForSpace(ctx, ownedSpace, project);
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

export const internalUpdateSandbox = internalMutation({
	args: {
		id: v.id("sandboxes"),
		status: v.optional(sandboxStatusValidator),
		externalSandboxId: v.optional(v.string()),
		snapshotId: v.optional(v.id("snapshots")),
		bootstrapSource: v.optional(spaceBootstrapSourceValidator),
		error: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		const patch = buildConvexPatch<SandboxUpdatePatch, typeof args>(args, {
			assign: ["status", "externalSandboxId", "snapshotId", "bootstrapSource"],
			clearable: ["error"],
		});

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

		return await buildSpaceResult(ctx, space, project);
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

export const getByExternalSandboxId = internalQuery({
	args: { externalSandboxId: v.string() },
	handler: async (ctx, args) => {
		const sandbox = await ctx.db
			.query("sandboxes")
			.withIndex("by_externalSandboxId", (q) =>
				q.eq("externalSandboxId", args.externalSandboxId)
			)
			.unique();
		if (!sandbox) {
			return null;
		}

		const space = await ctx.db.get(sandbox.spaceId);
		if (!space) {
			return null;
		}

		const project = await ctx.db.get(space.projectId);
		if (!project) {
			return null;
		}

		return await buildSpaceResult(ctx, space, project);
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

		const sandbox = await getSandboxForSpace(ctx, space._id);
		if (sandbox?.externalSandboxId) {
			await ctx.scheduler.runAfter(0, internal.sandboxActions.archiveSandbox, {
				sandboxId: sandbox.externalSandboxId,
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

		const { project, space: ownedSpace } = await requireOwnedSpace(ctx, space);
		await ensureSandboxRecordForSpace(ctx, ownedSpace, project);
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

		const sandbox = await getSandboxForSpace(ctx, space._id);
		if (!sandbox) {
			throw new ConvexError("Space has no sandbox");
		}
		if (sandbox.status === "paused") {
			return;
		}
		if (sandbox.status !== "running" || !sandbox.externalSandboxId) {
			throw new ConvexError("Sandbox is not running");
		}

		await ctx.db.patch(sandbox._id, {
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

		const sandbox = await getSandboxForSpace(ctx, space._id);
		if (sandbox) {
			if (sandbox.externalSandboxId) {
				await ctx.scheduler.runAfter(0, internal.sandboxActions.deleteSandbox, {
					sandboxId: sandbox.externalSandboxId,
				});
			}
			await ctx.db.delete(sandbox._id);
		}

		await ctx.db.delete(args.id);
	},
});
export { del as delete };
