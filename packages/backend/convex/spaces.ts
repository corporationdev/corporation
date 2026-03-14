import { ConvexError, v } from "convex/values";
import { asyncMap } from "convex-helpers";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import { createBacking } from "./backings";
import { createEnvironment } from "./environments";
import { authedMutation, authedQuery } from "./functions";
import { requireProjectInActiveOrg } from "./lib/projectAccess";

export const internalGet = internalQuery({
	args: { id: v.id("spaces") },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.id);
	},
});

export const list = authedQuery({
	args: {},
	handler: async (ctx) => {
		const spaces = await ctx.db
			.query("spaces")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		const visible = (
			await asyncMap(spaces, async (space) => {
				try {
					requireProjectInActiveOrg(
						await ctx.db.get(space.projectId),
						ctx.activeOrganizationId,
						"Space"
					);
					return space;
				} catch {
					return null;
				}
			})
		).filter((s): s is Doc<"spaces"> => s !== null);

		return visible
			.filter((s) => !s.archived)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	},
});

export const listByProject = authedQuery({
	args: {},
	handler: async (ctx) => {
		const spaces = await ctx.db
			.query("spaces")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		const activeSpaces = spaces
			.filter((s) => !s.archived)
			.sort((a, b) => b.updatedAt - a.updatedAt);

		const projectIds = [...new Set(activeSpaces.map((s) => s.projectId))];
		const projects = (
			await asyncMap(projectIds, (id) => ctx.db.get(id))
		).filter((p): p is Doc<"projects"> => p !== null);

		return projects
			.filter((p) => {
				try {
					requireProjectInActiveOrg(p, ctx.activeOrganizationId, "Project");
					return true;
				} catch {
					return false;
				}
			})
			.map((project) => ({
				project,
				spaces: activeSpaces.filter((s) => s.projectId === project._id),
			}))
			.filter((group) => group.spaces.length > 0);
	},
});

export const get = authedQuery({
	args: { id: v.id("spaces") },
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space || space.userId !== ctx.userId) {
			throw new ConvexError("Space not found");
		}
		requireProjectInActiveOrg(
			await ctx.db.get(space.projectId),
			ctx.activeOrganizationId,
			"Space"
		);
		return space;
	},
});

export const getBySlug = authedQuery({
	args: { slug: v.string() },
	handler: async (ctx, args) => {
		const space = await ctx.db
			.query("spaces")
			.withIndex("by_slug", (q) => q.eq("slug", args.slug))
			.unique();
		if (!space || space.userId !== ctx.userId) {
			return null;
		}
		try {
			requireProjectInActiveOrg(
				await ctx.db.get(space.projectId),
				ctx.activeOrganizationId,
				"Space"
			);
		} catch {
			return null;
		}
		return space;
	},
});

export const create = authedMutation({
	args: {
		slug: v.string(),
		projectId: v.id("projects"),
		backing: v.union(
			v.object({
				type: v.literal("existing"),
				environmentId: v.id("environments"),
			}),
			v.object({
				type: v.literal("sandbox"),
			})
		),
	},
	handler: async (ctx, args) => {
		const project = requireProjectInActiveOrg(
			await ctx.db.get(args.projectId),
			ctx.activeOrganizationId,
			"Project"
		);

		const slug = args.slug.trim();
		if (!slug) {
			throw new ConvexError("Space slug is required");
		}

		const existing = await ctx.db
			.query("spaces")
			.withIndex("by_slug", (q) => q.eq("slug", slug))
			.unique();
		if (existing) {
			throw new ConvexError("Space slug already exists");
		}

		const now = Date.now();

		// 1. Resolve or create environment
		let environmentId: Id<"environments">;

		if (args.backing.type === "existing") {
			const env = await ctx.db.get(args.backing.environmentId);
			if (!env || env.userId !== ctx.userId) {
				throw new ConvexError("Environment not found");
			}
			environmentId = env._id;
		} else {
			if (!project.defaultSnapshotId) {
				throw new ConvexError("Project does not have a default snapshot");
			}
			const snapshot = await ctx.db.get(project.defaultSnapshotId);
			if (!snapshot || snapshot.status !== "ready") {
				throw new ConvexError("Project snapshot is not ready");
			}

			const connectionId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
			environmentId = await createEnvironment(ctx, {
				userId: ctx.userId,
				connectionId,
				name: "Sandbox",
				status: "disconnected",
			});
		}

		// 2. Create space
		const spaceId = await ctx.db.insert("spaces", {
			userId: ctx.userId,
			slug,
			projectId: args.projectId,
			name: "New Space",
			createdAt: now,
			updatedAt: now,
		});

		// 3. Create backing
		await createBacking(ctx, { spaceId, environmentId });

		// 4. Sandbox-specific: create sandbox record + schedule creating
		if (args.backing.type === "sandbox") {
			if (!project.defaultSnapshotId) {
				throw new ConvexError("Project needs default snapshot");
			}
			await ctx.db.insert("sandboxes", {
				spaceId,
				status: "creating",
				snapshotId: project.defaultSnapshotId,
				createdAt: now,
				updatedAt: now,
			});

			await ctx.scheduler.runAfter(
				0,
				internal.sandboxActions.provisionForSpace,
				{ spaceId }
			);
		}

		return spaceId;
	},
});

export const update = authedMutation({
	args: {
		id: v.id("spaces"),
		name: v.optional(v.string()),
		archived: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space || space.userId !== ctx.userId) {
			throw new ConvexError("Space not found");
		}

		const patch: Record<string, unknown> = { updatedAt: Date.now() };

		if (args.name !== undefined) {
			const name = args.name.trim();
			if (!name) {
				throw new ConvexError("Name cannot be empty");
			}
			patch.name = name;
		}

		if (args.archived !== undefined) {
			patch.archived = args.archived;
		}

		await ctx.db.patch(args.id, patch);
	},
});

const del = authedMutation({
	args: { id: v.id("spaces") },
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.id);
		if (!space || space.userId !== ctx.userId) {
			throw new ConvexError("Space not found");
		}

		await ctx.db.delete(args.id);
	},
});
export { del as delete };
