import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedMutation } from "./functions";

async function requireOwnedService(
	ctx: QueryCtx & { userId: string },
	service: Doc<"services">
): Promise<Doc<"services">> {
	const repository = await ctx.db.get(service.repositoryId);
	if (!repository || repository.userId !== ctx.userId) {
		throw new ConvexError("Service not found");
	}

	return service;
}

export const update = authedMutation({
	args: {
		id: v.id("services"),
		name: v.optional(v.string()),
		devCommand: v.optional(v.string()),
		cwd: v.optional(v.string()),
		envVars: v.optional(
			v.array(v.object({ key: v.string(), value: v.string() }))
		),
	},
	handler: async (ctx, args) => {
		const service = await ctx.db.get(args.id);
		if (!service) {
			throw new ConvexError("Service not found");
		}
		await requireOwnedService(ctx, service);

		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries({ ...fields, updatedAt: Date.now() }).filter(
				([, v]) => v !== undefined
			)
		);

		await ctx.db.patch(id, patch);
	},
});

const del = authedMutation({
	args: {
		id: v.id("services"),
	},
	handler: async (ctx, args) => {
		const service = await ctx.db.get(args.id);
		if (!service) {
			throw new ConvexError("Service not found");
		}
		await requireOwnedService(ctx, service);

		const environments = await ctx.db
			.query("environments")
			.withIndex("by_repository", (q) =>
				q.eq("repositoryId", service.repositoryId)
			)
			.collect();

		for (const env of environments) {
			const filtered = env.serviceIds.filter((id) => id !== args.id);
			await ctx.db.patch(env._id, {
				serviceIds: filtered,
				updatedAt: Date.now(),
			});
		}

		await ctx.db.delete(args.id);
	},
});
export { del as delete };
