import { ConvexError, v } from "convex/values";
import { asyncMap } from "convex-helpers";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";

async function requireOwnedSandbox(
	ctx: QueryCtx & { userId: string },
	id: Id<"sandboxes">
): Promise<Doc<"sandboxes">> {
	const sandbox = await ctx.db.get(id);
	if (!sandbox) {
		throw new ConvexError("Sandbox not found");
	}

	const environment = await ctx.db.get(sandbox.environmentId);
	if (!environment) {
		throw new ConvexError("Sandbox not found");
	}

	const repository = await ctx.db.get(environment.repositoryId);
	if (!repository || repository.userId !== ctx.userId) {
		throw new ConvexError("Sandbox not found");
	}

	return sandbox;
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

		const sandboxes = (
			await asyncMap(environments, (env) =>
				ctx.db
					.query("sandboxes")
					.withIndex("by_environment", (q) => q.eq("environmentId", env._id))
					.collect()
			)
		).flat();

		sandboxes.sort((a, b) => b.updatedAt - a.updatedAt);
		return sandboxes;
	},
});

export const getById = authedQuery({
	args: { id: v.id("sandboxes") },
	handler: async (ctx, args) => {
		return await requireOwnedSandbox(ctx, args.id);
	},
});

export const create = authedMutation({
	args: {
		environmentId: v.id("environments"),
		branchName: v.string(),
	},
	handler: async (ctx, args) => {
		const environment = await ctx.db.get(args.environmentId);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}

		const repository = await ctx.db.get(environment.repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		const now = Date.now();
		return await ctx.db.insert("sandboxes", {
			environmentId: args.environmentId,
			branchName: args.branchName,
			status: "creating",
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const update = authedMutation({
	args: {
		id: v.id("sandboxes"),
		status: v.optional(
			v.union(
				v.literal("creating"),
				v.literal("starting"),
				v.literal("started"),
				v.literal("stopped"),
				v.literal("error")
			)
		),
		daytonaSandboxId: v.optional(v.string()),
		baseUrl: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requireOwnedSandbox(ctx, args.id);

		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries({ ...fields, updatedAt: Date.now() }).filter(
				([, v]) => v !== undefined
			)
		);

		await ctx.db.patch(id, patch);
	},
});
