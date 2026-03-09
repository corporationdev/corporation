import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { BASE_TEMPLATE, getSandboxWorkdir } from "./lib/sandbox";
import { ensureSpaceRecord } from "./spaces";

const USER_PROJECT_NAME = "Home";
const USER_SPACE_NAME = "Personal Workspace";

function getUserSpaceSlug(userId: string): string {
	return `user-space-${userId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

async function getUserProject(
	ctx: QueryCtx,
	userId: string
): Promise<Doc<"projects"> | null> {
	const projects = await ctx.db
		.query("projects")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.collect();

	return projects.find((project) => project.type === "user") ?? null;
}

async function getSpaceForProject(
	ctx: QueryCtx,
	projectId: Doc<"projects">["_id"]
): Promise<Doc<"spaces"> | null> {
	const spaces = await ctx.db
		.query("spaces")
		.withIndex("by_project", (q) => q.eq("projectId", projectId))
		.collect();

	const activeSpaces = spaces.filter((space) => !space.archived);
	activeSpaces.sort((a, b) => b.updatedAt - a.updatedAt);
	return activeSpaces[0] ?? null;
}

async function ensureUserProject(
	ctx: MutationCtx,
	userId: string
): Promise<Doc<"projects">> {
	const existing = await getUserProject(ctx, userId);
	if (existing) {
		return existing;
	}

	const now = Date.now();
	const projectId = await ctx.db.insert("projects", {
		userId,
		type: "user",
		name: USER_PROJECT_NAME,
		createdAt: now,
		updatedAt: now,
	});

	const project = await ctx.db.get(projectId);
	if (!project) {
		throw new ConvexError("Project not found");
	}

	return project;
}

async function ensureBaseSnapshot(
	ctx: MutationCtx,
	project: Doc<"projects">
): Promise<Doc<"projects">> {
	if (project.defaultSnapshotId) {
		return project;
	}

	const now = Date.now();
	const snapshotId = await ctx.db.insert("snapshots", {
		projectId: project._id,
		label: "Base Template",
		status: "ready",
		externalSnapshotId: BASE_TEMPLATE,
		startedAt: now,
		completedAt: now,
	});

	await ctx.db.patch(project._id, {
		defaultSnapshotId: snapshotId,
		updatedAt: now,
	});

	const updated = await ctx.db.get(project._id);
	if (!updated) {
		throw new ConvexError("Project not found");
	}
	return updated;
}

export const getWorkspaceState = authedQuery({
	args: {},
	handler: async (ctx) => {
		const project = await getUserProject(ctx, ctx.userId);
		if (!project) {
			return { project: null, space: null };
		}

		const space = await getSpaceForProject(ctx, project._id);

		return {
			project,
			space: space
				? {
						...space,
						workdir: getSandboxWorkdir(project),
					}
				: null,
		};
	},
});

export const configure = authedMutation({
	args: {},
	handler: async (ctx) => {
		const project = await ensureUserProject(ctx, ctx.userId);
		const withSnapshot = await ensureBaseSnapshot(ctx, project);

		const snapshotId = withSnapshot.defaultSnapshotId;
		if (!snapshotId) {
			throw new ConvexError("Snapshot was not created");
		}

		return await ensureSpaceRecord(ctx, {
			slug: getUserSpaceSlug(ctx.userId),
			project: withSnapshot,
			snapshotId,
			name: USER_SPACE_NAME,
		});
	},
});
