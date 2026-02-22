import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { snapshotStatusValidator } from "./schema";

async function requireOwnedEnvironment(
	ctx: QueryCtx & { userId: string },
	environment: Doc<"environments">
): Promise<Doc<"environments">> {
	const repository = await ctx.db.get(environment.repositoryId);
	if (!repository || repository.userId !== ctx.userId) {
		throw new ConvexError("Environment not found");
	}

	return environment;
}

export const listByRepository = authedQuery({
	args: {
		repositoryId: v.id("repositories"),
	},
	handler: async (ctx, args) => {
		const repository = await ctx.db.get(args.repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Repository not found");
		}

		return await ctx.db
			.query("environments")
			.withIndex("by_repository", (q) =>
				q.eq("repositoryId", args.repositoryId)
			)
			.collect();
	},
});

export const update = authedMutation({
	args: {
		id: v.id("environments"),
		name: v.optional(v.string()),
		serviceIds: v.optional(v.array(v.id("services"))),
	},
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}
		await requireOwnedEnvironment(ctx, environment);

		if (args.serviceIds) {
			for (const serviceId of args.serviceIds) {
				const service = await ctx.db.get(serviceId);
				if (!service || service.repositoryId !== environment.repositoryId) {
					throw new ConvexError("Invalid service ID");
				}
			}
		}

		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries({ ...fields, updatedAt: Date.now() }).filter(
				([, v]) => v !== undefined
			)
		);

		await ctx.db.patch(id, patch);
	},
});

export async function createEnvironmentHelper(
	ctx: MutationCtx & { userId: string },
	args: {
		repositoryId: Id<"repositories">;
		name: string;
		serviceIds: Id<"services">[];
	}
): Promise<Id<"environments">> {
	const now = Date.now();
	const envId = await ctx.db.insert("environments", {
		userId: ctx.userId,
		repositoryId: args.repositoryId,
		name: args.name,
		snapshotStatus: "building",
		serviceIds: args.serviceIds,
		createdAt: now,
		updatedAt: now,
	});

	await ctx.scheduler.runAfter(0, internal.snapshotActions.buildSnapshot, {
		environmentId: envId,
	});

	return envId;
}

export const create = authedMutation({
	args: {
		repositoryId: v.id("repositories"),
		name: v.string(),
		serviceIds: v.array(v.id("services")),
	},
	handler: async (ctx, args) => {
		const repository = await ctx.db.get(args.repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Repository not found");
		}

		for (const serviceId of args.serviceIds) {
			const service = await ctx.db.get(serviceId);
			if (!service || service.repositoryId !== args.repositoryId) {
				throw new ConvexError("Invalid service ID");
			}
		}

		return await createEnvironmentHelper(ctx, args);
	},
});

export const internalUpdate = internalMutation({
	args: {
		id: v.id("environments"),
		snapshotName: v.optional(v.string()),
		snapshotStatus: v.optional(snapshotStatusValidator),
	},
	handler: async (ctx, args) => {
		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries({ ...fields, updatedAt: Date.now() }).filter(
				([, val]) => val !== undefined
			)
		);
		await ctx.db.patch(id, patch);
	},
});

export const internalGet = internalQuery({
	args: { id: v.id("environments") },
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.id);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}

		const repository = await ctx.db.get(environment.repositoryId);
		if (!repository) {
			throw new ConvexError("Repository not found");
		}

		return { ...environment, repository };
	},
});
