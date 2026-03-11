import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { BASE_TEMPLATE } from "./lib/sandbox";

const ORG_BASE_PROJECT_NAME = "Workspace Base";

export const internalGetBaseProject = internalQuery({
	args: { organizationId: v.string() },
	handler: async (ctx, args) =>
		await ctx.db
			.query("projects")
			.withIndex("by_organization_and_kind", (q) =>
				q.eq("organizationId", args.organizationId).eq("kind", "base")
			)
			.unique(),
});

export const ensureOrgBaseProject = internalMutation({
	args: {
		organizationId: v.string(),
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("projects")
			.withIndex("by_organization_and_kind", (q) =>
				q.eq("organizationId", args.organizationId).eq("kind", "base")
			)
			.unique();
		if (existing) {
			return existing._id;
		}

		const now = Date.now();
		const projectId = await ctx.db.insert("projects", {
			userId: args.userId,
			organizationId: args.organizationId,
			kind: "base",
			name: ORG_BASE_PROJECT_NAME,
			createdAt: now,
			updatedAt: now,
		});

		const snapshotId = await ctx.db.insert("snapshots", {
			projectId,
			label: "Base Template",
			status: "ready",
			externalSnapshotId: BASE_TEMPLATE,
			startedAt: now,
			completedAt: now,
		});

		await ctx.db.patch(projectId, {
			defaultSnapshotId: snapshotId,
			updatedAt: now,
		});

		const created = await ctx.db.get(projectId);
		if (!created) {
			throw new ConvexError("Project not found");
		}

		return projectId;
	},
});
