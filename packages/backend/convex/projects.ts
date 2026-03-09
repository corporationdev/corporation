import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { scheduleInitialSnapshot } from "./snapshot";

function requireOwnedProject(
	userId: string,
	project: Doc<"projects">
): Doc<"projects"> {
	if (project.userId !== userId) {
		throw new ConvexError("Project not found");
	}
	return project;
}

async function getUserProject(
	ctx: MutationCtx,
	userId: string
): Promise<Doc<"projects"> | null> {
	return await ctx.db
		.query("projects")
		.withIndex("by_user_and_type", (q) =>
			q.eq("userId", userId).eq("type", "user")
		)
		.unique();
}

export const list = authedQuery({
	args: {},
	handler: async (ctx) =>
		(
			await ctx.db
				.query("projects")
				.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
				.collect()
		).filter((project) => project.type === "workspace"),
});

export const get = authedQuery({
	args: { id: v.id("projects") },
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.id);
		if (!project) {
			throw new ConvexError("Project not found");
		}
		requireOwnedProject(ctx.userId, project);

		const snapshots = await ctx.db
			.query("snapshots")
			.withIndex("by_project_and_startedAt", (q) =>
				q.eq("projectId", project._id)
			)
			.order("desc")
			.collect();

		return { ...project, snapshots };
	},
});

export const create = authedMutation({
	args: {
		name: v.string(),
		githubRepoId: v.optional(v.number()),
		githubOwner: v.optional(v.string()),
		githubName: v.optional(v.string()),
		defaultBranch: v.optional(v.string()),
		secrets: v.optional(v.record(v.string(), v.string())),
	},
	handler: async (ctx, args) => {
		if (args.githubRepoId) {
			const existing = await ctx.db
				.query("projects")
				.withIndex("by_user_and_github_repo", (q) =>
					q.eq("userId", ctx.userId).eq("githubRepoId", args.githubRepoId)
				)
				.first();

			if (existing) {
				throw new ConvexError("Repository already connected to a project");
			}
		}

		const userProject = await getUserProject(ctx, ctx.userId);
		if (!userProject?.defaultSnapshotId) {
			throw new ConvexError(
				"You must create your personal workspace before creating a project"
			);
		}

		const userSnapshot = await ctx.db.get(userProject.defaultSnapshotId);
		if (
			!userSnapshot ||
			userSnapshot.status !== "ready" ||
			!userSnapshot.externalSnapshotId
		) {
			throw new ConvexError(
				"Your personal workspace snapshot is not ready yet"
			);
		}

		const now = Date.now();

		const projectId = await ctx.db.insert("projects", {
			userId: ctx.userId,
			type: "workspace",
			name: args.name,
			githubRepoId: args.githubRepoId,
			githubOwner: args.githubOwner,
			githubName: args.githubName,
			defaultBranch: args.defaultBranch,
			secrets: args.secrets,
			createdAt: now,
			updatedAt: now,
		});

		const project = await ctx.db.get(projectId);
		if (!project) {
			throw new ConvexError("Project not found");
		}

		await scheduleInitialSnapshot(ctx, project, { setAsDefault: true });

		return projectId;
	},
});

export const update = authedMutation({
	args: {
		id: v.id("projects"),
		name: v.optional(v.string()),
		githubRepoId: v.optional(v.number()),
		githubOwner: v.optional(v.string()),
		githubName: v.optional(v.string()),
		defaultBranch: v.optional(v.string()),
		secrets: v.optional(v.record(v.string(), v.string())),
		defaultSnapshotId: v.optional(v.id("snapshots")),
	},
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.id);
		if (!project) {
			throw new ConvexError("Project not found");
		}
		requireOwnedProject(ctx.userId, project);

		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries({
				...fields,
				updatedAt: Date.now(),
			}).filter(([, value]) => value !== undefined)
		);

		await ctx.db.patch(id, patch);
	},
});

const del = authedMutation({
	args: {
		id: v.id("projects"),
	},
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.id);
		if (!project) {
			throw new ConvexError("Project not found");
		}
		requireOwnedProject(ctx.userId, project);

		const [spaces, snapshots] = await Promise.all([
			ctx.db
				.query("spaces")
				.withIndex("by_project", (q) => q.eq("projectId", args.id))
				.collect(),
			ctx.db
				.query("snapshots")
				.withIndex("by_project", (q) => q.eq("projectId", args.id))
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
	args: { id: v.id("projects") },
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.id);
		if (!project) {
			throw new ConvexError("Project not found");
		}
		return project;
	},
});

export const completeSnapshotBuild = internalMutation({
	args: {
		id: v.id("projects"),
	},
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.id);
		if (!project) {
			throw new ConvexError("Project not found");
		}

		await ctx.db.patch(args.id, { updatedAt: Date.now() });
	},
});

export const internalGetByGithubRepoId = internalQuery({
	args: { githubRepoId: v.number() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("projects")
			.withIndex("by_github_repo", (q) =>
				q.eq("githubRepoId", args.githubRepoId)
			)
			.collect();
	},
});

export const internalGetUserProject = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, args) =>
		await ctx.db
			.query("projects")
			.withIndex("by_user_and_type", (q) =>
				q.eq("userId", args.userId).eq("type", "user")
			)
			.unique(),
});
