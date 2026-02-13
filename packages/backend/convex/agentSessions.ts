import { ConvexError, v } from "convex/values";
import { asyncMap } from "convex-helpers";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";

async function requireOwnedSession(
	ctx: QueryCtx & { userId: string },
	id: Id<"agentSessions">
): Promise<Doc<"agentSessions">> {
	const session = await ctx.db.get(id);
	if (!session) {
		throw new ConvexError("Agent session not found");
	}

	const sandbox = await ctx.db.get(session.sandboxId);
	if (!sandbox) {
		throw new ConvexError("Agent session not found");
	}

	const environment = await ctx.db.get(sandbox.environmentId);
	if (!environment) {
		throw new ConvexError("Agent session not found");
	}

	const repository = await ctx.db.get(environment.repositoryId);
	if (!repository || repository.userId !== ctx.userId) {
		throw new ConvexError("Agent session not found");
	}

	return session;
}

export const getById = authedQuery({
	args: { id: v.id("agentSessions") },
	handler: async (ctx, args) => {
		return await requireOwnedSession(ctx, args.id);
	},
});

export const getBySlug = authedQuery({
	args: { slug: v.string() },
	handler: async (ctx, args) => {
		const session = await ctx.db
			.query("agentSessions")
			.withIndex("by_slug", (q) => q.eq("slug", args.slug))
			.unique();
		if (!session) {
			return null;
		}
		await requireOwnedSession(ctx, session._id);
		return session;
	},
});

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

		const sessions = (
			await asyncMap(sandboxes, (sandbox) =>
				ctx.db
					.query("agentSessions")
					.withIndex("by_sandbox", (q) => q.eq("sandboxId", sandbox._id))
					.collect()
			)
		).flat();

		sessions.sort((a, b) => b.updatedAt - a.updatedAt);
		return sessions;
	},
});

export const listBySandbox = authedQuery({
	args: {
		sandboxId: v.id("sandboxes"),
	},
	handler: async (ctx, args) => {
		const sandbox = await ctx.db.get(args.sandboxId);
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

		return await ctx.db
			.query("agentSessions")
			.withIndex("by_sandbox", (q) => q.eq("sandboxId", args.sandboxId))
			.collect();
	},
});

export const create = authedMutation({
	args: {
		slug: v.string(),
		title: v.string(),
		sandboxId: v.id("sandboxes"),
	},
	handler: async (ctx, args) => {
		const sandbox = await ctx.db.get(args.sandboxId);
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

		const now = Date.now();

		return await ctx.db.insert("agentSessions", {
			slug: args.slug,
			title: args.title,
			sandboxId: args.sandboxId,
			status: "waiting",
			createdAt: now,
			updatedAt: now,
			archivedAt: null,
		});
	},
});

export const update = authedMutation({
	args: {
		id: v.id("agentSessions"),
		title: v.optional(v.string()),
		archivedAt: v.optional(v.union(v.number(), v.null())),
	},
	handler: async (ctx, args) => {
		await requireOwnedSession(ctx, args.id);

		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries({ ...fields, updatedAt: Date.now() }).filter(
				([, v]) => v !== undefined
			)
		);

		await ctx.db.patch(id, patch);
	},
});

export const touch = authedMutation({
	args: {
		id: v.id("agentSessions"),
	},
	handler: async (ctx, args) => {
		await requireOwnedSession(ctx, args.id);

		await ctx.db.patch(args.id, {
			updatedAt: Date.now(),
			archivedAt: null,
		});
	},
});

export const remove = authedMutation({
	args: {
		id: v.id("agentSessions"),
	},
	handler: async (ctx, args) => {
		await requireOwnedSession(ctx, args.id);

		await ctx.db.delete(args.id);
	},
});
