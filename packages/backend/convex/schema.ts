import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema(
	{
		spaces: defineTable({
			userId: v.string(),
			environmentId: v.id("environments"),
			sandboxId: v.optional(v.string()),
			sandboxUrl: v.optional(v.string()),
			branchName: v.string(),
			status: v.union(
				v.literal("creating"),
				v.literal("starting"),
				v.literal("started"),
				v.literal("stopped"),
				v.literal("error")
			),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_user", ["userId"])
			.index("by_environment", ["environmentId"]),

		environments: defineTable({
			userId: v.string(),
			repositoryId: v.id("repositories"),
			name: v.string(),
			snapshotName: v.string(),
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
			installCommand: v.string(),
			createdAt: v.number(),
			updatedAt: v.number(),
		})
			.index("by_user", ["userId"])
			.index("by_user_and_github_repo", ["userId", "githubRepoId"]),

		services: defineTable({
			repositoryId: v.id("repositories"),
			name: v.string(),
			devCommand: v.string(),
			cwd: v.string(),
			envVars: v.optional(
				v.array(v.object({ key: v.string(), value: v.string() }))
			),
			createdAt: v.number(),
			updatedAt: v.number(),
		}).index("by_repository", ["repositoryId"]),

		agentSessions: defineTable({
			slug: v.string(),
			title: v.string(),
			spaceId: v.id("spaces"),
			status: v.union(
				v.literal("running"),
				v.literal("waiting"),
				v.literal("stopped"),
				v.literal("error")
			),
			createdAt: v.number(),
			updatedAt: v.number(),
			archivedAt: v.union(v.number(), v.null()),
		})
			.index("by_space", ["spaceId"])
			.index("by_slug", ["slug"]),
	},
	// TODO: remove schemaValidation: false before launch
	{ schemaValidation: false }
);
