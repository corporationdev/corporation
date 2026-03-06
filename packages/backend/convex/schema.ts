import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const snapshotStatusValidator = v.union(
	v.literal("building"),
	v.literal("ready"),
	v.literal("error")
);

export const snapshotTypeValidator = v.union(
	v.literal("setup"),
	v.literal("update")
);

export const spaceStatusValidator = v.union(
	v.literal("creating"),
	v.literal("running"),
	v.literal("paused"),
	v.literal("killed"),
	v.literal("error")
);

export const warmSandboxStatusValidator = v.union(
	v.literal("warming"),
	v.literal("ready"),
	v.literal("claimed"),
	v.literal("expired"),
	v.literal("error")
);

export const warmSandboxTriggerReasonValidator = v.union(
	v.literal("new_space_button"),
	v.literal("repository_typing")
);

export default defineSchema(
	{
		environments: defineTable({
			userId: v.string(),
			repositoryId: v.id("repositories"),
			name: v.string(),
			setupCommand: v.string(),
			updateCommand: v.string(),
			devCommand: v.string(),
			devPort: v.number(),
			envByPath: v.optional(
				v.record(v.string(), v.record(v.string(), v.string()))
			),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_user", ["userId"])
			.index("by_repository", ["repositoryId"]),

		repositories: defineTable({
			userId: v.string(),
			githubRepoId: v.number(),
			owner: v.string(),
			name: v.string(),
			defaultBranch: v.string(),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_user", ["userId"])
			.index("by_user_and_github_repo", ["userId", "githubRepoId"])
			.index("by_github_repo", ["githubRepoId"]),

		spaces: defineTable({
			slug: v.string(),
			environmentId: v.id("environments"),
			sandboxId: v.optional(v.string()),
			agentUrl: v.optional(v.string()),
			editorUrl: v.optional(v.string()),
			branchName: v.string(),
			status: spaceStatusValidator,
			lastSyncedCommitSha: v.optional(v.string()),
			prUrl: v.optional(v.string()),
			error: v.optional(v.string()),
			archived: v.optional(v.boolean()),
			sandboxExpiresAt: v.optional(v.number()),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_environment", ["environmentId"])
			.index("by_slug", ["slug"])
			.index("by_sandboxId", ["sandboxId"]),

		warmSandboxes: defineTable({
			environmentId: v.id("environments"),
			snapshotId: v.id("snapshots"),
			status: warmSandboxStatusValidator,
			triggerReason: warmSandboxTriggerReasonValidator,
			sandboxId: v.optional(v.string()),
			agentUrl: v.optional(v.string()),
			editorUrl: v.optional(v.string()),
			claimedBySpaceId: v.optional(v.id("spaces")),
			expiresAt: v.number(),
			error: v.optional(v.string()),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_environment", ["environmentId"])
			.index("by_environment_and_status", ["environmentId", "status"])
			.index("by_environment_snapshot_status", [
				"environmentId",
				"snapshotId",
				"status",
			])
			.index("by_sandboxId", ["sandboxId"])
			.index("by_expiresAt", ["expiresAt"]),

		snapshots: defineTable({
			environmentId: v.id("environments"),
			type: snapshotTypeValidator,
			status: snapshotStatusValidator,
			logs: v.string(),
			logsTruncated: v.optional(v.boolean()),
			error: v.optional(v.string()),
			externalSnapshotId: v.optional(v.string()),
			snapshotCommitSha: v.optional(v.string()),
			startedAt: v.number(),
			completedAt: v.optional(v.number()),
		})
			.index("by_environment", ["environmentId"])
			.index("by_environment_and_startedAt", ["environmentId", "startedAt"])
			.index("by_environment_status_startedAt", [
				"environmentId",
				"status",
				"startedAt",
			]),
	},
	// TODO: remove schemaValidation: false before launch
	{ schemaValidation: false }
);
