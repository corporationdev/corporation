import { ConvexError, v } from "convex/values";
import { asyncMap } from "convex-helpers";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";

async function requireOwnedSession(
	ctx: QueryCtx & { userId: string },
	session: Doc<"agentSessions">
): Promise<{
	session: Doc<"agentSessions">;
	space: Doc<"spaces">;
	environment: Doc<"environments">;
	repository: Doc<"repositories">;
}> {
	const space = await ctx.db.get(session.spaceId);
	if (!space) {
		throw new ConvexError("Agent session not found");
	}

	const environment = await ctx.db.get(space.environmentId);
	if (!environment) {
		throw new ConvexError("Agent session not found");
	}

	const repository = await ctx.db.get(environment.repositoryId);
	if (!repository || repository.userId !== ctx.userId) {
		throw new ConvexError("Agent session not found");
	}

	return { session, space, environment, repository };
}

export const getById = authedQuery({
	args: { id: v.id("agentSessions") },
	handler: async (ctx, args) => {
		const session = await ctx.db.get(args.id);
		if (!session) {
			throw new ConvexError("Agent session not found");
		}
		const { space, environment, repository } = await requireOwnedSession(
			ctx,
			session
		);
		return {
			...session,
			space: {
				...space,
				environment: {
					...environment,
					repository,
				},
			},
		};
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
		const { space, environment, repository } = await requireOwnedSession(
			ctx,
			session
		);
		return {
			...session,
			space: {
				...space,
				environment: {
					...environment,
					repository,
				},
			},
		};
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

		const spaces = (
			await asyncMap(environments, (env) =>
				ctx.db
					.query("spaces")
					.withIndex("by_environment", (q) => q.eq("environmentId", env._id))
					.collect()
			)
		).flat();

		const sessions = (
			await asyncMap(spaces, (space) =>
				ctx.db
					.query("agentSessions")
					.withIndex("by_space", (q) => q.eq("spaceId", space._id))
					.collect()
			)
		).flat();

		sessions.sort((a, b) => b.updatedAt - a.updatedAt);
		return sessions;
	},
});

export const create = authedMutation({
	args: {
		slug: v.string(),
		title: v.string(),
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.spaceId);
		if (!space) {
			throw new ConvexError("Space not found");
		}

		const environment = await ctx.db.get(space.environmentId);
		if (!environment) {
			throw new ConvexError("Space not found");
		}

		const repository = await ctx.db.get(environment.repositoryId);
		if (!repository || repository.userId !== ctx.userId) {
			throw new ConvexError("Space not found");
		}

		const existing = await ctx.db
			.query("agentSessions")
			.withIndex("by_slug", (q) => q.eq("slug", args.slug))
			.unique();
		if (existing) {
			throw new ConvexError("Session with this slug already exists");
		}

		const now = Date.now();

		return await ctx.db.insert("agentSessions", {
			slug: args.slug,
			title: args.title,
			spaceId: args.spaceId,
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
		const session = await ctx.db.get(args.id);
		if (!session) {
			throw new ConvexError("Agent session not found");
		}
		await requireOwnedSession(ctx, session);

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
		id: v.id("agentSessions"),
	},
	handler: async (ctx, args) => {
		const session = await ctx.db.get(args.id);
		if (!session) {
			throw new ConvexError("Agent session not found");
		}
		await requireOwnedSession(ctx, session);

		await ctx.db.delete(args.id);
	},
});
export { del as delete };
