import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";

export const getLatest = authedQuery({
	args: {
		projectId: v.id("projects"),
	},
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.projectId);
		if (!project || project.userId !== ctx.userId) {
			throw new ConvexError("Project not found");
		}

		return await ctx.db
			.query("snapshots")
			.withIndex("by_project_and_startedAt", (q) =>
				q.eq("projectId", project._id)
			)
			.order("desc")
			.first();
	},
});

export const listByProject = authedQuery({
	args: {
		projectId: v.id("projects"),
	},
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.projectId);
		if (!project || project.userId !== ctx.userId) {
			throw new ConvexError("Project not found");
		}

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

		const project = await ctx.db.get(snapshot.projectId);
		if (!project || project.userId !== ctx.userId) {
			throw new ConvexError("Snapshot not found");
		}

		return snapshot;
	},
});

type DbCtx = {
	db: QueryCtx["db"] | MutationCtx["db"];
};

export async function withDerivedSnapshotState(
	ctx: DbCtx,
	project: Doc<"projects">
) {
	const [latestSnapshot, activeSnapshot, defaultSnapshot] = await Promise.all([
		ctx.db
			.query("snapshots")
			.withIndex("by_project_and_startedAt", (q) =>
				q.eq("projectId", project._id)
			)
			.order("desc")
			.first(),
		ctx.db
			.query("snapshots")
			.withIndex("by_project_status_startedAt", (q) =>
				q.eq("projectId", project._id).eq("status", "ready")
			)
			.order("desc")
			.first(),
		project.defaultSnapshotId ? ctx.db.get(project.defaultSnapshotId) : null,
	]);

	return {
		...project,
		latestSnapshot,
		activeSnapshot,
		defaultSnapshot,
	};
}

export async function scheduleInitialSnapshot(
	ctx: MutationCtx,
	project: Doc<"projects">,
	options?: { setAsDefault?: boolean }
): Promise<Id<"snapshots">> {
	const latestSnapshot = await ctx.db
		.query("snapshots")
		.withIndex("by_project_and_startedAt", (q) =>
			q.eq("projectId", project._id)
		)
		.order("desc")
		.first();

	if (latestSnapshot?.status === "building") {
		throw new ConvexError("A snapshot build is already in progress");
	}

	const now = Date.now();
	const snapshotId = await ctx.db.insert("snapshots", {
		projectId: project._id,
		label: "Base Snapshot",
		status: "building",
		startedAt: now,
	});

	await ctx.db.patch(project._id, { updatedAt: now });

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
		const project = await ctx.db.get(args.projectId);
		if (!project || project.userId !== ctx.userId) {
			throw new ConvexError("Project not found");
		}

		await scheduleInitialSnapshot(ctx, project);
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
