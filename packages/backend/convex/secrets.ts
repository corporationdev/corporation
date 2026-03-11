import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const listByProject = internalQuery({
	args: {
		projectId: v.id("projects"),
	},
	handler: async (ctx, args) =>
		await ctx.db
			.query("secrets")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.collect(),
});

export const upsertInternal = internalMutation({
	args: {
		projectId: v.id("projects"),
		userId: v.string(),
		name: v.string(),
		encryptedValue: v.string(),
		iv: v.string(),
		hint: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("secrets")
			.withIndex("by_project_and_name", (q) =>
				q.eq("projectId", args.projectId).eq("name", args.name)
			)
			.unique();

		const now = Date.now();

		if (existing) {
			await ctx.db.patch(existing._id, {
				encryptedValue: args.encryptedValue,
				iv: args.iv,
				hint: args.hint,
				updatedAt: now,
			});
			return existing._id;
		}

		return await ctx.db.insert("secrets", {
			projectId: args.projectId,
			userId: args.userId,
			name: args.name,
			encryptedValue: args.encryptedValue,
			iv: args.iv,
			hint: args.hint,
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const removeByProjectAndNameInternal = internalMutation({
	args: {
		projectId: v.id("projects"),
		name: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("secrets")
			.withIndex("by_project_and_name", (q) =>
				q.eq("projectId", args.projectId).eq("name", args.name)
			)
			.unique();

		if (!existing) {
			return;
		}

		await ctx.db.delete(existing._id);
	},
});
