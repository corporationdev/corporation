import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const snapshotStatusValidator = v.union(
	v.literal("building"),
	v.literal("ready"),
	v.literal("error")
);

export const snapshotTypeValidator = v.union(
	v.literal("build"),
	v.literal("rebuild"),
	v.literal("override")
);

export const spaceStatusValidator = v.union(
	v.literal("creating"),
	v.literal("running"),
	v.literal("paused"),
	v.literal("killed"),
	v.literal("error")
);

export default defineSchema(
	{
		environments: defineTable({
			userId: v.string(),
			repositoryId: v.id("repositories"),
			name: v.string(),
			setupCommand: v.string(),
			devCommand: v.string(),
			envByPath: v.optional(
				v.record(v.string(), v.record(v.string(), v.string()))
			),
			activeSnapshotId: v.optional(v.id("snapshots")),
			rebuildIntervalMs: v.optional(v.number()),
			scheduledRebuildId: v.optional(v.id("_scheduled_functions")),
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
			sandboxUrl: v.optional(v.string()),
			branchName: v.string(),
			status: spaceStatusValidator,
			lastSyncedCommitSha: v.optional(v.string()),
			prUrl: v.optional(v.string()),
			error: v.optional(v.string()),
			archived: v.optional(v.boolean()),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_environment", ["environmentId"])
			.index("by_slug", ["slug"])
			.index("by_sandboxId", ["sandboxId"]),

		snapshots: defineTable({
			environmentId: v.id("environments"),
			type: snapshotTypeValidator,
			status: snapshotStatusValidator,
			logs: v.string(),
			logsTruncated: v.optional(v.boolean()),
			error: v.optional(v.string()),
			snapshotId: v.optional(v.string()),
			snapshotCommitSha: v.optional(v.string()),
			startedAt: v.number(),
			completedAt: v.optional(v.number()),
		})
			.index("by_environment", ["environmentId"])
			.index("by_environment_and_startedAt", ["environmentId", "startedAt"]),
	},
	// TODO: remove schemaValidation: false before launch
	{ schemaValidation: false }
);
