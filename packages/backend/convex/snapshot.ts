import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { requireProjectInActiveOrg } from "./lib/projectAccess";

const ISO_MILLIS_SUFFIX = /\.\d{3}Z$/;

export const listByProject = authedQuery({
	args: {
		projectId: v.id("projects"),
	},
	handler: async (ctx, args) => {
		requireProjectInActiveOrg(
			await ctx.db.get(args.projectId),
			ctx.activeOrganizationId,
			"Project"
		);

		return await ctx.db
			.query("snapshots")
			.withIndex("by_project_and_startedAt", (q) =>
				q.eq("projectId", args.projectId)
			)
			.order("desc")
			.collect();
	},
});

export const get = authedQuery({
	args: {
		id: v.id("snapshots"),
	},
	handler: async (ctx, args) => {
		const snapshot = await ctx.db.get(args.id);
		if (!snapshot) {
			throw new ConvexError("Snapshot not found");
		}

		requireProjectInActiveOrg(
			await ctx.db.get(snapshot.projectId),
			ctx.activeOrganizationId,
			"Snapshot"
		);

		return snapshot;
	},
});

export const internalGet = internalQuery({
	args: {
		id: v.id("snapshots"),
	},
	handler: async (ctx, args) => {
		const snapshot = await ctx.db.get(args.id);
		if (!snapshot) {
			throw new ConvexError("Snapshot not found");
		}

		return snapshot;
	},
});

function buildDefaultSnapshotLabel(now: Date): string {
	const iso = now.toISOString().replace(ISO_MILLIS_SUFFIX, "Z");
	return `snapshot-${iso}`;
}

async function createSnapshotRecord(
	ctx: MutationCtx,
	project: Doc<"projects">,
	options?: { label?: string }
): Promise<Id<"snapshots">> {
	const now = Date.now();
	const trimmedLabel = options?.label?.trim();
	const snapshotId = await ctx.db.insert("snapshots", {
		projectId: project._id,
		label: trimmedLabel || buildDefaultSnapshotLabel(new Date(now)),
		status: "building",
		startedAt: now,
	});

	await ctx.db.patch(project._id, { updatedAt: now });

	return snapshotId;
}

export async function scheduleInitialSnapshot(
	ctx: MutationCtx,
	project: Doc<"projects">,
	options?: { setAsDefault?: boolean; label?: string }
): Promise<Id<"snapshots">> {
	const snapshotId = await createSnapshotRecord(ctx, project, {
		label: options?.label ?? "Base Snapshot",
	});

	await ctx.scheduler.runAfter(
		0,
		internal.snapshotActions.buildInitialSnapshot,
		{
			projectId: project._id,
			snapshotId,
			setAsDefault: options?.setAsDefault ?? false,
		}
	);

	return snapshotId;
}

export const buildInitialSnapshot = authedMutation({
	args: {
		projectId: v.id("projects"),
	},
	handler: async (ctx, args) => {
		const project = requireProjectInActiveOrg(
			await ctx.db.get(args.projectId),
			ctx.activeOrganizationId,
			"Project"
		);

		await scheduleInitialSnapshot(ctx, project, {
			setAsDefault: true,
		});
	},
});

export async function scheduleRebuildWithSecrets(
	ctx: MutationCtx,
	project: Doc<"projects">
): Promise<Id<"snapshots">> {
	if (!project.defaultSnapshotId) {
		throw new ConvexError("Project has no default snapshot to rebuild from");
	}

	const sourceSnapshot = await ctx.db.get(project.defaultSnapshotId);
	if (
		!sourceSnapshot ||
		sourceSnapshot.status !== "ready" ||
		!sourceSnapshot.externalSnapshotId
	) {
		throw new ConvexError("Default snapshot is not ready");
	}

	const snapshotId = await createSnapshotRecord(ctx, project);

	await ctx.scheduler.runAfter(0, internal.snapshotActions.rebuildWithEnvs, {
		projectId: project._id,
		snapshotId,
		sourceExternalSnapshotId: sourceSnapshot.externalSnapshotId,
	});

	return snapshotId;
}

export const scheduleInitialSnapshotInternal = internalMutation({
	args: {
		projectId: v.id("projects"),
		setAsDefault: v.optional(v.boolean()),
		label: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.projectId);
		if (!project) {
			throw new ConvexError("Project not found");
		}

		return await scheduleInitialSnapshot(ctx, project, {
			setAsDefault: args.setAsDefault,
			label: args.label,
		});
	},
});

export const scheduleRebuildWithSecretsInternal = internalMutation({
	args: {
		projectId: v.id("projects"),
	},
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.projectId);
		if (!project) {
			throw new ConvexError("Project not found");
		}

		return await scheduleRebuildWithSecrets(ctx, project);
	},
});

export const createFromSpace = authedMutation({
	args: {
		spaceId: v.id("spaces"),
		label: v.optional(v.string()),
		setAsDefault: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.spaceId);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		if (space.userId !== ctx.userId) {
			throw new ConvexError("Space not found");
		}

		const project = requireProjectInActiveOrg(
			await ctx.db.get(space.projectId),
			ctx.activeOrganizationId,
			"Space"
		);

		const sandbox = await ctx.db
			.query("sandboxes")
			.withIndex("by_space", (q) => q.eq("spaceId", space._id))
			.unique();
		if (!sandbox?.externalSandboxId) {
			throw new ConvexError("Sandbox is not running");
		}

		const snapshotId = await createSnapshotRecord(ctx, project, {
			label: args.label,
		});

		await ctx.scheduler.runAfter(
			0,
			internal.snapshotActions.createFromSandbox,
			{
				projectId: project._id,
				snapshotId,
				sandboxId: sandbox.externalSandboxId,
				setAsDefault: args.setAsDefault ?? false,
			}
		);

		return snapshotId;
	},
});

export const completeSnapshot = internalMutation({
	args: {
		snapshotId: v.id("snapshots"),
		status: v.union(v.literal("ready"), v.literal("error")),
		projectId: v.optional(v.id("projects")),
		externalSnapshotId: v.optional(v.string()),
		error: v.optional(v.string()),
		setAsDefault: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const snapshot = await ctx.db.get(args.snapshotId);
		if (!snapshot) {
			throw new ConvexError("Snapshot not found");
		}
		if (snapshot.status !== "building") {
			throw new ConvexError("Snapshot is not building");
		}

		if (args.status === "error") {
			if (!args.error) {
				throw new ConvexError("error is required when status is error");
			}
			await ctx.db.patch(args.snapshotId, {
				status: "error",
				completedAt: Date.now(),
				error: args.error,
			});
			return;
		}

		if (!(args.projectId && args.externalSnapshotId)) {
			throw new ConvexError(
				"projectId and externalSnapshotId are required when status is ready"
			);
		}
		if (snapshot.projectId !== args.projectId) {
			throw new ConvexError("Snapshot does not belong to project");
		}
		await ctx.db.patch(args.snapshotId, {
			status: "ready",
			completedAt: Date.now(),
			externalSnapshotId: args.externalSnapshotId,
		});

		if (args.setAsDefault) {
			await ctx.db.patch(args.projectId, {
				defaultSnapshotId: args.snapshotId,
			});
		}
	},
});
