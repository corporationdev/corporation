import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { createEnvironmentHelper } from "./environments";
import { authedMutation, authedQuery } from "./functions";

function requireOwnedRepository(
	userId: string,
	repo: Doc<"repositories">
): Doc<"repositories"> {
	if (repo.userId !== userId) {
		throw new ConvexError("Repository not found");
	}
	return repo;
}

export const list = authedQuery({
	args: {},
	handler: async (ctx) => {
		const repos = await ctx.db
			.query("repositories")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		return Promise.all(
			repos.map(async (repo) => {
				const defaultEnv = await ctx.db
					.query("environments")
					.withIndex("by_repository", (q) => q.eq("repositoryId", repo._id))
					.first();

				return {
					...repo,
					defaultEnvironmentStatus: defaultEnv?.snapshotStatus ?? null,
				};
			})
		);
	},
});

export const get = authedQuery({
	args: { id: v.id("repositories") },
	handler: async (ctx, args) => {
		const repo = await ctx.db.get(args.id);
		if (!repo) {
			throw new ConvexError("Repository not found");
		}
		requireOwnedRepository(ctx.userId, repo);

		const environments = await ctx.db
			.query("environments")
			.withIndex("by_repository", (q) => q.eq("repositoryId", args.id))
			.collect();

		const services = await ctx.db
			.query("services")
			.withIndex("by_repository", (q) => q.eq("repositoryId", args.id))
			.collect();

		return { ...repo, environments, services };
	},
});

export const create = authedMutation({
	args: {
		githubRepoId: v.number(),
		owner: v.string(),
		name: v.string(),
		defaultBranch: v.string(),
		setupCommand: v.string(),
		devCommand: v.string(),
		envVars: v.optional(
			v.array(v.object({ key: v.string(), value: v.string() }))
		),
		services: v.array(
			v.object({
				path: v.string(),
				envVars: v.optional(
					v.array(v.object({ key: v.string(), value: v.string() }))
				),
			})
		),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("repositories")
			.withIndex("by_user_and_github_repo", (q) =>
				q.eq("userId", ctx.userId).eq("githubRepoId", args.githubRepoId)
			)
			.first();

		if (existing) {
			throw new ConvexError("Repository already connected");
		}

		const now = Date.now();

		const repositoryId = await ctx.db.insert("repositories", {
			userId: ctx.userId,
			githubRepoId: args.githubRepoId,
			owner: args.owner,
			name: args.name,
			defaultBranch: args.defaultBranch,
			setupCommand: args.setupCommand,
			devCommand: args.devCommand,
			envVars: args.envVars,
			createdAt: now,
			updatedAt: now,
		});

		const serviceIds: Id<"services">[] = [];
		for (const service of args.services) {
			const serviceId = await ctx.db.insert("services", {
				repositoryId,
				path: service.path,
				envVars: service.envVars,
				createdAt: now,
				updatedAt: now,
			});
			serviceIds.push(serviceId);
		}

		await createEnvironmentHelper(ctx, {
			repositoryId,
			name: "Default",
			serviceIds,
		});

		return repositoryId;
	},
});

export const update = authedMutation({
	args: {
		id: v.id("repositories"),
		setupCommand: v.optional(v.string()),
		devCommand: v.optional(v.string()),
		envVars: v.optional(
			v.array(v.object({ key: v.string(), value: v.string() }))
		),
		services: v.optional(
			v.array(
				v.object({
					path: v.string(),
					envVars: v.optional(
						v.array(v.object({ key: v.string(), value: v.string() }))
					),
				})
			)
		),
		environment: v.optional(
			v.object({
				name: v.optional(v.string()),
			})
		),
	},
	handler: async (ctx, args) => {
		const repo = await ctx.db.get(args.id);
		if (!repo) {
			throw new ConvexError("Repository not found");
		}
		requireOwnedRepository(ctx.userId, repo);

		const now = Date.now();

		// Update repository fields
		const repoPatch: Record<string, unknown> = { updatedAt: now };
		if (args.setupCommand !== undefined) {
			repoPatch.setupCommand = args.setupCommand;
		}
		if (args.devCommand !== undefined) {
			repoPatch.devCommand = args.devCommand;
		}
		if (args.envVars !== undefined) {
			repoPatch.envVars = args.envVars;
		}
		await ctx.db.patch(args.id, repoPatch);

		// Replace services if provided
		let newServiceIds: Id<"services">[] | undefined;
		if (args.services) {
			const existingServices = await ctx.db
				.query("services")
				.withIndex("by_repository", (q) => q.eq("repositoryId", args.id))
				.collect();

			for (const service of existingServices) {
				await ctx.db.delete(service._id);
			}

			newServiceIds = [];
			for (const service of args.services) {
				const serviceId = await ctx.db.insert("services", {
					repositoryId: args.id,
					path: service.path,
					envVars: service.envVars,
					createdAt: now,
					updatedAt: now,
				});
				newServiceIds.push(serviceId);
			}
		}

		// Update environments if services changed or environment fields provided
		if (newServiceIds || args.environment) {
			const environments = await ctx.db
				.query("environments")
				.withIndex("by_repository", (q) => q.eq("repositoryId", args.id))
				.collect();

			for (const env of environments) {
				const envPatch: Record<string, unknown> = { updatedAt: now };
				if (newServiceIds) {
					envPatch.serviceIds = newServiceIds;
				}
				if (args.environment?.name !== undefined) {
					envPatch.name = args.environment.name;
				}
				await ctx.db.patch(env._id, envPatch);
			}
		}
	},
});

const del = authedMutation({
	args: {
		id: v.id("repositories"),
	},
	handler: async (ctx, args) => {
		const repo = await ctx.db.get(args.id);
		if (!repo) {
			throw new ConvexError("Repository not found");
		}
		requireOwnedRepository(ctx.userId, repo);

		const environments = await ctx.db
			.query("environments")
			.withIndex("by_repository", (q) => q.eq("repositoryId", args.id))
			.collect();

		for (const env of environments) {
			await ctx.db.delete(env._id);
		}

		const services = await ctx.db
			.query("services")
			.withIndex("by_repository", (q) => q.eq("repositoryId", args.id))
			.collect();

		for (const service of services) {
			await ctx.db.delete(service._id);
		}

		await ctx.db.delete(args.id);
	},
});
export { del as delete };
