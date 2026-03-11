import {
	validateSecretName,
	validateSecretValue,
} from "@corporation/shared/secrets";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./functions";
import { requireProjectInActiveOrg } from "./lib/projectAccess";

function requireActiveOrganization(
	activeOrganizationId: string | null
): string {
	if (!activeOrganizationId) {
		throw new ConvexError("No active organization");
	}

	return activeOrganizationId;
}

function requireOrgProjectAccess(
	activeOrganizationId: string | null,
	project: Doc<"projects">,
	options?: { allowBase?: boolean }
): Doc<"projects"> {
	return requireProjectInActiveOrg(
		project,
		activeOrganizationId,
		"Project",
		options
	);
}

async function getOrgBaseProject(
	ctx: MutationCtx,
	organizationId: string
): Promise<Doc<"projects"> | null> {
	return await ctx.db
		.query("projects")
		.withIndex("by_organization_and_kind", (q) =>
			q.eq("organizationId", organizationId).eq("kind", "base")
		)
		.unique();
}

function validateSecretRecord(secrets: Record<string, string>): void {
	for (const [rawName, value] of Object.entries(secrets)) {
		const name = rawName.trim();
		if (!name) {
			continue;
		}
		const nameError = validateSecretName(name);
		if (nameError) {
			throw new ConvexError(nameError);
		}
		const valueError = validateSecretValue(value);
		if (valueError) {
			throw new ConvexError(valueError);
		}
	}
}

export const list = authedQuery({
	args: {},
	handler: async (ctx) => {
		const organizationId = ctx.activeOrganizationId;
		if (!organizationId) {
			return [];
		}

		return (
			await ctx.db
				.query("projects")
				.withIndex("by_organization", (q) =>
					q.eq("organizationId", organizationId)
				)
				.collect()
		).filter((project) => project.kind === "standard");
	},
});

export const get = authedQuery({
	args: { id: v.id("projects") },
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.id);
		if (!project) {
			throw new ConvexError("Project not found");
		}
		const scopedProject = requireOrgProjectAccess(
			ctx.activeOrganizationId,
			project
		);

		const snapshots = await ctx.db
			.query("snapshots")
			.withIndex("by_project_and_startedAt", (q) =>
				q.eq("projectId", scopedProject._id)
			)
			.order("desc")
			.collect();
		const secrets = (
			await ctx.db
				.query("secrets")
				.withIndex("by_project", (q) => q.eq("projectId", project._id))
				.collect()
		)
			.map((secret) => ({
				name: secret.name,
				hint: secret.hint,
				updatedAt: secret.updatedAt,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));

		return { ...scopedProject, secrets, snapshots };
	},
});

export const create = authedMutation({
	args: {
		name: v.string(),
		githubRepoId: v.optional(v.number()),
		githubOwner: v.optional(v.string()),
		githubName: v.optional(v.string()),
		defaultBranch: v.optional(v.string()),
		secrets: v.optional(v.record(v.string(), v.string())),
	},
	handler: async (ctx, args) => {
		const organizationId = requireActiveOrganization(ctx.activeOrganizationId);
		validateSecretRecord(args.secrets ?? {});

		if (args.githubRepoId) {
			const existing = await ctx.db
				.query("projects")
				.withIndex("by_organization_and_github_repo", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("githubRepoId", args.githubRepoId)
				)
				.first();

			if (existing && existing.kind === "standard") {
				throw new ConvexError("Repository already connected to a project");
			}
		}

		const baseProject = await getOrgBaseProject(ctx, organizationId);
		if (!baseProject?.defaultSnapshotId) {
			throw new ConvexError("Organization base project is not ready yet");
		}

		const baseSnapshot = await ctx.db.get(baseProject.defaultSnapshotId);
		if (
			!baseSnapshot ||
			baseSnapshot.status !== "ready" ||
			!baseSnapshot.externalSnapshotId
		) {
			throw new ConvexError("Organization base snapshot is not ready yet");
		}

		const now = Date.now();

		const projectId = await ctx.db.insert("projects", {
			userId: ctx.userId,
			organizationId,
			kind: "standard",
			name: args.name,
			githubRepoId: args.githubRepoId,
			githubOwner: args.githubOwner,
			githubName: args.githubName,
			defaultBranch: args.defaultBranch,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.scheduler.runAfter(
			0,
			internal.secretActions.syncProjectSecretsAndScheduleInitialSnapshot,
			{
				projectId,
				secrets: args.secrets ?? {},
			}
		);

		return projectId;
	},
});

export const update = authedMutation({
	args: {
		id: v.id("projects"),
		name: v.optional(v.string()),
		githubRepoId: v.optional(v.number()),
		githubOwner: v.optional(v.string()),
		githubName: v.optional(v.string()),
		defaultBranch: v.optional(v.string()),
		defaultSnapshotId: v.optional(v.id("snapshots")),
	},
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.id);
		if (!project) {
			throw new ConvexError("Project not found");
		}
		requireOrgProjectAccess(ctx.activeOrganizationId, project);

		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries({
				...fields,
				updatedAt: Date.now(),
			}).filter(([, value]) => value !== undefined)
		);

		await ctx.db.patch(id, patch);
	},
});

export const updateSecrets = authedMutation({
	args: {
		id: v.id("projects"),
		upserts: v.record(v.string(), v.string()),
		removeNames: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.id);
		if (!project) {
			throw new ConvexError("Project not found");
		}
		requireOrgProjectAccess(ctx.activeOrganizationId, project);
		validateSecretRecord(args.upserts);

		await ctx.db.patch(args.id, {
			updatedAt: Date.now(),
		});
		await ctx.scheduler.runAfter(
			0,
			internal.secretActions.syncProjectSecretsAndScheduleRebuild,
			{
				projectId: args.id,
				upserts: args.upserts,
				removeNames: args.removeNames,
			}
		);
	},
});

const del = authedMutation({
	args: {
		id: v.id("projects"),
	},
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.id);
		if (!project) {
			throw new ConvexError("Project not found");
		}
		requireOrgProjectAccess(ctx.activeOrganizationId, project);

		const [spaces, snapshots, secrets] = await Promise.all([
			ctx.db
				.query("spaces")
				.withIndex("by_project", (q) => q.eq("projectId", args.id))
				.collect(),
			ctx.db
				.query("snapshots")
				.withIndex("by_project", (q) => q.eq("projectId", args.id))
				.collect(),
			ctx.db
				.query("secrets")
				.withIndex("by_project", (q) => q.eq("projectId", args.id))
				.collect(),
		]);

		for (const space of spaces) {
			if (space.sandboxId) {
				await ctx.scheduler.runAfter(0, internal.sandboxActions.deleteSandbox, {
					sandboxId: space.sandboxId,
				});
			}
			await ctx.db.delete(space._id);
		}

		for (const snapshot of snapshots) {
			await ctx.db.delete(snapshot._id);
		}
		for (const secret of secrets) {
			await ctx.db.delete(secret._id);
		}

		await ctx.db.delete(args.id);
	},
});
export { del as delete };

export const internalGet = internalQuery({
	args: { id: v.id("projects") },
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.id);
		if (!project) {
			throw new ConvexError("Project not found");
		}
		return project;
	},
});

export const completeSnapshotBuild = internalMutation({
	args: {
		id: v.id("projects"),
	},
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.id);
		if (!project) {
			throw new ConvexError("Project not found");
		}

		await ctx.db.patch(args.id, { updatedAt: Date.now() });
	},
});

export const internalGetByGithubRepoId = internalQuery({
	args: { githubRepoId: v.number() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("projects")
			.withIndex("by_github_repo", (q) =>
				q.eq("githubRepoId", args.githubRepoId)
			)
			.collect();
	},
});

export const internalGetOrgBaseProject = internalQuery({
	args: { organizationId: v.string() },
	handler: async (ctx, args) =>
		await ctx.db
			.query("projects")
			.withIndex("by_organization_and_kind", (q) =>
				q.eq("organizationId", args.organizationId).eq("kind", "base")
			)
			.unique(),
});
