import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const snapshotStatusValidator = v.union(
	v.literal("building"),
	v.literal("ready"),
	v.literal("error")
);

export const sandboxStatusValidator = v.union(
	v.literal("creating"),
	v.literal("running"),
	v.literal("paused"),
	v.literal("killed"),
	v.literal("error")
);

export const environmentTypeValidator = v.union(
	v.literal("persistent"),
	v.literal("sandbox")
);

export const environmentStatusValidator = v.union(
	v.literal("connected"),
	v.literal("disconnected"),
	v.literal("error")
);

export default defineSchema(
	{
		projects: defineTable({
			userId: v.string(),
			organizationId: v.string(),
			name: v.string(),
			githubRepoId: v.optional(v.number()),
			githubOwner: v.optional(v.string()),
			githubName: v.optional(v.string()),
			defaultBranch: v.optional(v.string()),
			defaultSnapshotId: v.optional(v.id("snapshots")),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_user", ["userId"])
			.index("by_organization", ["organizationId"])
			.index("by_organization_and_github_repo", [
				"organizationId",
				"githubRepoId",
			])
			.index("by_github_repo", ["githubRepoId"]),

		spaces: defineTable({
			userId: v.string(),
			slug: v.string(),
			projectId: v.id("projects"),
			activeBackingId: v.optional(v.id("backings")),
			name: v.string(),
			archived: v.optional(v.boolean()),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_project", ["projectId"])
			.index("by_user", ["userId"])
			.index("by_user_and_project", ["userId", "projectId"])
			.index("by_slug", ["slug"]),

		sandboxes: defineTable({
			spaceId: v.id("spaces"),
			externalSandboxId: v.optional(v.string()),
			status: sandboxStatusValidator,
			snapshotId: v.optional(v.id("snapshots")),
			error: v.optional(v.string()),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_space", ["spaceId"])
			.index("by_externalSandboxId", ["externalSandboxId"]),

		snapshots: defineTable({
			projectId: v.id("projects"),
			label: v.string(),
			status: snapshotStatusValidator,
			error: v.optional(v.string()),
			externalSnapshotId: v.optional(v.string()),
			startedAt: v.number(),
			completedAt: v.optional(v.number()),
		})
			.index("by_project", ["projectId"])
			.index("by_project_and_startedAt", ["projectId", "startedAt"])
			.index("by_project_status_startedAt", [
				"projectId",
				"status",
				"startedAt",
			]),
		agentConfig: defineTable({
			userId: v.string(),
			agentId: v.string(),
			configOptions: v.array(v.any()),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_user", ["userId"])
			.index("by_user_and_agent", ["userId", "agentId"]),
		agentCredentials: defineTable({
			userId: v.string(),
			agentId: v.string(),
			encryptedBundle: v.string(),
			iv: v.string(),
			schemaVersion: v.number(),
			lastSyncedAt: v.optional(v.number()),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_user", ["userId"])
			.index("by_user_and_agent", ["userId", "agentId"]),

		backings: defineTable({
			spaceId: v.id("spaces"),
			environmentId: v.id("environments"),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_space", ["spaceId"])
			.index("by_environment", ["environmentId"]),

		environments: defineTable({
			userId: v.string(),
			connectionId: v.string(),
			name: v.string(),
			status: environmentStatusValidator,
			type: v.optional(environmentTypeValidator),
			metadata: v.optional(v.record(v.string(), v.any())),
			error: v.optional(v.string()),
			lastConnectedAt: v.optional(v.number()),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_user", ["userId"])
			.index("by_user_and_connectionId", ["userId", "connectionId"])
			.index("by_user_and_status", ["userId", "status"]),

		projectEnvironments: defineTable({
			projectId: v.id("projects"),
			environmentId: v.id("environments"),
			path: v.string(),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_project", ["projectId"])
			.index("by_environment", ["environmentId"])
			.index("by_project_and_environment", ["projectId", "environmentId"]),

		secrets: defineTable({
			userId: v.string(),
			projectId: v.id("projects"),
			name: v.string(),
			encryptedValue: v.string(),
			iv: v.string(),
			hint: v.string(),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_user", ["userId"])
			.index("by_project", ["projectId"])
			.index("by_project_and_name", ["projectId", "name"]),
	},
	// TODO: remove schemaValidation: false before launch
	{ schemaValidation: false }
);
