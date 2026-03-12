import { ConvexError } from "convex/values";
import { nanoid } from "nanoid";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { SANDBOX_WORKDIR } from "./lib/sandbox";
import { ensureSpaceRecord } from "./spaces";

const USER_SPACE_NAME = "Personal Workspace";

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

		return await ensureSpaceRecord(ctx, {
			slug: existingSpace?.slug ?? nanoid(),
			userId: ctx.userId,
			project,
			bootstrapSource: "base-template",
			name: USER_SPACE_NAME,
		});
	},
});
