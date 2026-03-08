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

export default defineSchema(
	{
		repositories: defineTable({
			userId: v.string(),
			githubRepoId: v.number(),
			owner: v.string(),
			name: v.string(),
			defaultBranch: v.string(),
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
			.index("by_user_and_github_repo", ["userId", "githubRepoId"])
			.index("by_github_repo", ["githubRepoId"]),

		spaces: defineTable({
			slug: v.string(),
			repositoryId: v.id("repositories"),
			sandboxId: v.optional(v.string()),
			agentUrl: v.optional(v.string()),
			name: v.string(),
			status: spaceStatusValidator,
			error: v.optional(v.string()),
			archived: v.optional(v.boolean()),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_repository", ["repositoryId"])
			.index("by_slug", ["slug"])
			.index("by_sandboxId", ["sandboxId"]),

		snapshots: defineTable({
			repositoryId: v.id("repositories"),
			type: snapshotTypeValidator,
			status: snapshotStatusValidator,
			logs: v.string(),
			logsTruncated: v.optional(v.boolean()),
			error: v.optional(v.string()),
			externalSnapshotId: v.optional(v.string()),
			startedAt: v.number(),
			completedAt: v.optional(v.number()),
		})
			.index("by_repository", ["repositoryId"])
			.index("by_repository_and_startedAt", ["repositoryId", "startedAt"])
			.index("by_repository_status_startedAt", [
				"repositoryId",
				"status",
				"startedAt",
			]),
		warmSandboxes: defineTable({
			userId: v.string(),
			repositoryId: v.id("repositories"),
			sandboxId: v.optional(v.string()),
			agentUrl: v.optional(v.string()),
			spaceId: v.optional(v.id("spaces")),
			status: v.union(v.literal("provisioning"), v.literal("ready")),
			createdAt: v.number(),
		})
			.index("by_user", ["userId"])
			.index("by_user_and_repository", ["userId", "repositoryId"]),
		secrets: defineTable({
			userId: v.string(),
			name: v.string(),
			encryptedKey: v.string(),
			iv: v.string(),
			hint: v.string(),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_user", ["userId"])
			.index("by_user_and_name", ["userId", "name"]),
	},
	// TODO: remove schemaValidation: false before launch
	{ schemaValidation: false }
);
