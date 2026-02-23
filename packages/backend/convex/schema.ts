import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const snapshotStatusValidator = v.union(
	v.literal("building"),
	v.literal("ready"),
	v.literal("error")
);

export const spaceStatusValidator = v.union(
	v.literal("creating"),
	v.literal("starting"),
	v.literal("started"),
	v.literal("stopped"),
	v.literal("error")
);

export default defineSchema(
	{
		environments: defineTable({
			userId: v.string(),
			repositoryId: v.id("repositories"),
			name: v.string(),
			snapshotName: v.optional(v.string()),
			snapshotStatus: snapshotStatusValidator,
			serviceIds: v.array(v.id("services")),
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
			setupCommand: v.string(),
			devCommand: v.string(),
			envVars: v.optional(
				v.array(v.object({ key: v.string(), value: v.string() }))
			),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_user", ["userId"])
			.index("by_user_and_github_repo", ["userId", "githubRepoId"]),

		services: defineTable({
			repositoryId: v.id("repositories"),
			path: v.string(),
			envVars: v.optional(
				v.array(v.object({ key: v.string(), value: v.string() }))
			),
			createdAt: v.number(),
			updatedAt: v.number(),
		}).index("by_repository", ["repositoryId"]),

		spaces: defineTable({
			slug: v.string(),
			environmentId: v.id("environments"),
			sandboxId: v.optional(v.string()),
			sandboxUrl: v.optional(v.string()),
			branchName: v.string(),
			status: spaceStatusValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_environment", ["environmentId"])
			.index("by_slug", ["slug"]),
	},
	// TODO: remove schemaValidation: false before launch
	{ schemaValidation: false }
);
