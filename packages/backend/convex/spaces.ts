import { ConvexError, v } from "convex/values";
import { asyncMap } from "convex-helpers";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
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
		return spaces.filter((s) => !s.archived);
	},
});

export const listByRepository = authedQuery({
	args: {},
	handler: async (ctx) => {
		const [repositories, environments] = await Promise.all([
			ctx.db
				.query("repositories")
				.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
				.collect(),
			ctx.db
				.query("environments")
				.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
				.collect(),
		]);

		const environmentsByRepository = new Map<
			Id<"repositories">,
			Doc<"environments">[]
		>();
		for (const environment of environments) {
			const repoEnvironments =
				environmentsByRepository.get(environment.repositoryId) ?? [];
			repoEnvironments.push(environment);
			environmentsByRepository.set(environment.repositoryId, repoEnvironments);
		}

		const spacesByEnvironment = new Map<Id<"environments">, Doc<"spaces">[]>();
		const environmentSpaces = await asyncMap(
			environments,
			async (environment) => ({
				environmentId: environment._id,
				spaces: await ctx.db
					.query("spaces")
					.withIndex("by_environment", (q) =>
						q.eq("environmentId", environment._id)
					)
					.collect(),
			})
		);
		for (const { environmentId, spaces } of environmentSpaces) {
			spacesByEnvironment.set(environmentId, spaces);
		}

		const grouped = repositories.map((repository) => {
			const repoEnvironments = [
				...(environmentsByRepository.get(repository._id) ?? []),
			];
			repoEnvironments.sort((a, b) => a.createdAt - b.createdAt);
			const defaultEnvironment = repoEnvironments[0] ?? null;

			const spaces = repoEnvironments
				.flatMap((environment) => {
					return spacesByEnvironment.get(environment._id) ?? [];
				})
				.filter((space) => !space.archived);
			spaces.sort((a, b) => b.updatedAt - a.updatedAt);

			return {
				repository,
				defaultEnvironmentId: defaultEnvironment?._id ?? null,
				spaces,
			};
		});

		grouped.sort((a, b) => {
			const aName = `${a.repository.owner}/${a.repository.name}`;
			const bName = `${b.repository.owner}/${b.repository.name}`;
			return aName.localeCompare(bName);
		});
		return grouped;
	},
});

export const getBySlug = authedQuery({
	args: { slug: v.string() },
	handler: async (ctx, args) => {
		const space = await ctx.db
			.query("spaces")
			.withIndex("by_slug", (q) => q.eq("slug", args.slug))
			.unique();
		if (!space) {
			return null;
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
			workdir: `/root/${repository.owner}-${repository.name}`,
			environment: {
				...environment,
				repository,
				services,
			},
		};
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
			workdir: `/root/${repository.owner}-${repository.name}`,
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
		lastSyncedCommitSha: v.optional(v.string()),
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

		const repository = await ctx.db.get(environment.repositoryId);
		if (!repository) {
			throw new ConvexError("Repository not found");
		}

		const services = (
			await asyncMap(environment.serviceIds, (id) => ctx.db.get(id))
		).filter((s): s is Doc<"services"> => s !== null);

		return {
			...space,
			environment: { ...environment, repository, services },
		};
	},
});

export const getBySandboxId = internalQuery({
	args: { sandboxId: v.string() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("spaces")
			.withIndex("by_sandboxId", (q) => q.eq("sandboxId", args.sandboxId))
			.unique();
	},
});

export const stop = authedMutation({
	args: {
		id: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		await ctx.scheduler.runAfter(0, internal.sandboxActions.stopSandbox, {
			spaceId: args.id,
		});
	},
});

export const ensure = authedMutation({
	args: {
		slug: v.string(),
		environmentId: v.optional(v.id("environments")),
	},
	handler: async (ctx, args) => {
		const slug = args.slug.trim();

		// Look up by slug — may already exist from a prior call
		const existing = await ctx.db
			.query("spaces")
			.withIndex("by_slug", (q) => q.eq("slug", slug))
			.unique();
		if (existing) {
			await requireOwnedSpace(ctx, existing);
			if (existing.status !== "started") {
				await ctx.scheduler.runAfter(0, internal.sandboxActions.ensureSandbox, {
					spaceId: existing._id,
				});
			}
			return existing._id;
		}

		if (!args.environmentId) {
			throw new ConvexError("environmentId is required when creating a space");
		}

		const environment = await ctx.db.get(args.environmentId);
		if (!environment || environment.userId !== ctx.userId) {
			throw new ConvexError("Environment not found");
		}

		const now = Date.now();
		const spaceId = await ctx.db.insert("spaces", {
			slug,
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

export const archive = authedMutation({
	args: {
		id: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		await ctx.db.patch(args.id, {
			archived: true,
			updatedAt: Date.now(),
		});

		if (space.sandboxId) {
			await ctx.scheduler.runAfter(0, internal.sandboxActions.archiveSandbox, {
				sandboxId: space.sandboxId,
			});
		}
	},
});

export const syncCode = authedMutation({
	args: {
		id: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		if (space.status !== "started") {
			throw new ConvexError("Space must be running to sync code");
		}

		await ctx.scheduler.runAfter(0, internal.sandboxActions.syncRepository, {
			spaceId: args.id,
		});
	},
});

const del = authedMutation({
	args: {
		id: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space) {
			throw new ConvexError("Space not found");
		}
		await requireOwnedSpace(ctx, space);

		const { sandboxId } = space;
		await ctx.db.delete(args.id);

		if (sandboxId) {
			await ctx.scheduler.runAfter(0, internal.sandboxActions.deleteSandbox, {
				sandboxId,
			});
		}
	},
});
export { del as delete };
