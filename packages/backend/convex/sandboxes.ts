import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { sandboxStatusValidator } from "./schema";

export const getBySpace = internalQuery({
	args: { spaceId: v.id("spaces") },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("sandboxes")
			.withIndex("by_space", (q) => q.eq("spaceId", args.spaceId))
			.unique();
	},
});

export const update = internalMutation({
	args: {
		id: v.id("sandboxes"),
		status: v.optional(sandboxStatusValidator),
		externalSandboxId: v.optional(v.string()),
		error: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const { id, ...fields } = args;
		const patch: Record<string, unknown> = { updatedAt: Date.now() };

		if (fields.status !== undefined) {
			patch.status = fields.status;
		}
		if (fields.externalSandboxId !== undefined) {
			patch.externalSandboxId = fields.externalSandboxId;
		}
		if (fields.error !== undefined) {
			patch.error = fields.error;
		}

		await ctx.db.patch(id, patch);
	},
});
