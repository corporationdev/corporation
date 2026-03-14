import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

export const internalGet = internalQuery({
	args: { id: v.id("snapshots") },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.id);
	},
});
