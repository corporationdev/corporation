import { ConvexError, v } from "convex/values";
import { nanoid } from "nanoid";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { SANDBOX_WORKDIR } from "./lib/sandbox";
import { ensureSpaceRecord, resolveSnapshotIdForProject } from "./spaces";

const USER_SPACE_NAME = "Personal Workspace";
const ISO_MILLIS_SUFFIX = /\.\d{3}Z$/;

async function getBaseProject(
	ctx: QueryCtx,
	organizationId: string
): Promise<Doc<"projects"> | null> {
	return await ctx.db
		.query("projects")
		.withIndex("by_organization_and_kind", (q) =>
			q.eq("organizationId", organizationId).eq("kind", "base")
		)
		.unique();
}

async function getSpaceForProject(
	ctx: QueryCtx,
	userId: string,
	projectId: Doc<"projects">["_id"]
): Promise<Doc<"spaces"> | null> {
	const spaces = await ctx.db
		.query("spaces")
		.withIndex("by_user_and_project", (q) =>
			q.eq("userId", userId).eq("projectId", projectId)
		)
		.collect();

	const activeSpaces = spaces.filter((space) => !space.archived);
	activeSpaces.sort((a, b) => b.updatedAt - a.updatedAt);
	return activeSpaces[0] ?? null;
}

export const getWorkspaceState = authedQuery({
	args: {},
	handler: async (ctx) => {
		if (!ctx.activeOrganizationId) {
			return { project: null, space: null };
		}

		const project = await getBaseProject(ctx, ctx.activeOrganizationId);
		if (!project) {
			return { project: null, space: null };
		}

		const space = await getSpaceForProject(ctx, ctx.userId, project._id);

		return {
			project,
			space: space
				? {
						...space,
						workdir: SANDBOX_WORKDIR,
					}
				: null,
		};
	},
});

export const configure = authedMutation({
	args: {},
	handler: async (ctx) => {
		if (!ctx.activeOrganizationId) {
			throw new ConvexError("No active organization");
		}

		const project = await getBaseProject(ctx, ctx.activeOrganizationId);
		if (!project) {
			throw new ConvexError("Organization base project is not ready");
		}

		const existingSpace = await getSpaceForProject(
			ctx,
			ctx.userId,
			project._id
		);
		const snapshotId = await resolveSnapshotIdForProject(ctx, project);

		return await ensureSpaceRecord(ctx, {
			slug: existingSpace?.slug ?? nanoid(),
			userId: ctx.userId,
			project,
			snapshotId,
			name: USER_SPACE_NAME,
		});
	},
});

export const save = authedMutation({
	args: {
		agents: v.array(
			v.object({
				id: v.string(),
				configOptions: v.array(v.any()),
			})
		),
	},
	handler: async (ctx, args) => {
		if (!ctx.activeOrganizationId) {
			throw new ConvexError("No active organization");
		}

		const project = await getBaseProject(ctx, ctx.activeOrganizationId);
		if (!project) {
			throw new ConvexError("Organization base project not found");
		}

		const space = await getSpaceForProject(ctx, ctx.userId, project._id);
		if (!space) {
			throw new ConvexError("Personal workspace not found");
		}
		if (!space.sandboxId) {
			throw new ConvexError("Sandbox is not running");
		}

		await ctx.runMutation(internal.agentConfig.internalSaveProbeResults, {
			userId: ctx.userId,
			spaceId: space._id,
			agents: args.agents,
		});

		const now = Date.now();
		const snapshotId = await ctx.db.insert("snapshots", {
			projectId: project._id,
			label: `snapshot-${new Date(now).toISOString().replace(ISO_MILLIS_SUFFIX, "Z")}`,
			status: "building",
			startedAt: now,
		});

		await ctx.db.patch(project._id, { updatedAt: now });

		await ctx.scheduler.runAfter(0, internal.snapshotActions.saveSpaceState, {
			spaceId: space._id,
			snapshotId,
			setAsDefault: false,
		});
	},
});
