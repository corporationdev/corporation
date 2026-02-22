import { ConvexError, v } from "convex/values";
import { asyncMap } from "convex-helpers";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { spaceStatusValidator } from "./schema";

async function requireOwnedSpace(
	ctx: QueryCtx & { userId: string },
	space: Doc<"spaces">
): Promise<{
	space: Doc<"spaces">;
	environment: Doc<"environments">;
}> {
	const environment = await ctx.db.get(space.environmentId);
	if (!environment || environment.userId !== ctx.userId) {
		throw new ConvexError("Space not found");
	}

	return { space, environment };
}

export const list = authedQuery({
	args: {},
	handler: async (ctx) => {
		const repos = await ctx.db
			.query("repositories")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		const environments = (
			await asyncMap(repos, (repo) =>
				ctx.db
					.query("environments")
					.withIndex("by_repository", (q) => q.eq("repositoryId", repo._id))
					.collect()
			)
		).flat();

		const spaces = (
			await asyncMap(environments, (env) =>
				ctx.db
					.query("spaces")
					.withIndex("by_environment", (q) => q.eq("environmentId", env._id))
					.collect()
			)
		).flat();

		spaces.sort((a, b) => b.updatedAt - a.updatedAt);
		return spaces;
	},
});

export const get = authedQuery({
	args: { id: v.id("spaces") },
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		const { environment } = await requireOwnedSpace(ctx, space);

		const repository = await ctx.db.get(environment.repositoryId);
		if (!repository) {
			throw new ConvexError("Repository not found");
		}

		const services = (
			await asyncMap(environment.serviceIds, (id) => ctx.db.get(id))
		).filter((s): s is Doc<"services"> => s !== null);

		return {
			...space,
			environment: {
				...environment,
				repository,
				services,
			},
		};
	},
});

export const update = authedMutation({
	args: {
		id: v.id("spaces"),
		status: v.optional(spaceStatusValidator),
		sandboxId: v.optional(v.string()),
		sandboxUrl: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries({ ...fields, updatedAt: Date.now() }).filter(
				([, v]) => v !== undefined
			)
		);

		await ctx.db.patch(id, patch);
	},
});

export const internalUpdate = internalMutation({
	args: {
		id: v.id("spaces"),
		status: v.optional(spaceStatusValidator),
		sandboxId: v.optional(v.string()),
		sandboxUrl: v.optional(v.string()),
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
	args: { id: v.id("spaces") },
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}

		const environment = await ctx.db.get(space.environmentId);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}

		const services = (
			await asyncMap(environment.serviceIds, (id) => ctx.db.get(id))
		).filter((s): s is Doc<"services"> => s !== null);

		return {
			...space,
			environment: { ...environment, services },
		};
	},
});

export const ensure = authedMutation({
	args: {
		environmentId: v.optional(v.id("environments")),
		spaceId: v.optional(v.id("spaces")),
	},
	handler: async (ctx, args) => {
		if (args.spaceId) {
			const space = await ctx.db.get(args.spaceId);
			if (!space) {
				throw new ConvexError("Space not found");
			}
			await requireOwnedSpace(ctx, space);

			if (space.status === "started") {
				return args.spaceId;
			}

			await ctx.scheduler.runAfter(0, internal.sandboxActions.ensureSandbox, {
				spaceId: args.spaceId,
			});

			return args.spaceId;
		}

		if (!args.environmentId) {
			throw new ConvexError("environmentId is required when spaceId is absent");
		}

		const environment = await ctx.db.get(args.environmentId);
		if (!environment || environment.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		const now = Date.now();
		const spaceId = await ctx.db.insert("spaces", {
			environmentId: args.environmentId,
			branchName: "main",
			status: "creating",
			createdAt: now,
			updatedAt: now,
		});

		await ctx.scheduler.runAfter(0, internal.sandboxActions.ensureSandbox, {
			spaceId,
		});

		return spaceId;
	},
});
