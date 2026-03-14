import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";

export async function createProjectEnvironment(
	ctx: MutationCtx,
	args: {
		projectId: Id<"projects">;
		environmentId: Id<"environments">;
		path: string;
	}
) {
	const now = Date.now();
	return await ctx.db.insert("projectEnvironments", {
		projectId: args.projectId,
		environmentId: args.environmentId,
		path: args.path,
		createdAt: now,
		updatedAt: now,
	});
}

export const listByProject = authedQuery({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		const entries = await ctx.db
			.query("projectEnvironments")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.collect();

		return entries;
	},
});

export const listByEnvironment = authedQuery({
	args: { environmentId: v.id("environments") },
	handler: async (ctx, args) => {
		const env = await ctx.db.get(args.environmentId);
		if (!env || env.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		return await ctx.db
			.query("projectEnvironments")
			.withIndex("by_environment", (q) =>
				q.eq("environmentId", args.environmentId)
			)
			.collect();
	},
});

export const getByProjectAndEnvironment = authedQuery({
	args: {
		projectId: v.id("projects"),
		environmentId: v.id("environments"),
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query("projectEnvironments")
			.withIndex("by_project_and_environment", (q) =>
				q
					.eq("projectId", args.projectId)
					.eq("environmentId", args.environmentId)
			)
			.unique();
	},
});

export const internalGetByProjectAndEnvironment = internalQuery({
	args: {
		projectId: v.id("projects"),
		environmentId: v.id("environments"),
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query("projectEnvironments")
			.withIndex("by_project_and_environment", (q) =>
				q
					.eq("projectId", args.projectId)
					.eq("environmentId", args.environmentId)
			)
			.unique();
	},
});

export const set = authedMutation({
	args: {
		projectId: v.id("projects"),
		environmentId: v.id("environments"),
		path: v.string(),
	},
	handler: async (ctx, args) => {
		const env = await ctx.db.get(args.environmentId);
		if (!env || env.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		const path = args.path.trim();
		if (!path) {
			throw new ConvexError("Path cannot be empty");
		}

		const existing = await ctx.db
			.query("projectEnvironments")
			.withIndex("by_project_and_environment", (q) =>
				q
					.eq("projectId", args.projectId)
					.eq("environmentId", args.environmentId)
			)
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				path,
				updatedAt: Date.now(),
			});
			return existing._id;
		}

		return await createProjectEnvironment(ctx, {
			projectId: args.projectId,
			environmentId: args.environmentId,
			path,
		});
	},
});

const del = authedMutation({
	args: { id: v.id("projectEnvironments") },
	handler: async (ctx, args) => {
		const entry = await ctx.db.get(args.id);
		if (!entry) {
			throw new ConvexError("Not found");
		}

		const env = await ctx.db.get(entry.environmentId);
		if (!env || env.userId !== ctx.userId) {
			throw new ConvexError("Not found");
		}

		await ctx.db.delete(args.id);
	},
});
export { del as delete };
