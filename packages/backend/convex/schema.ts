import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema(
	{
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
			.index("by_user_and_github_repo", ["userId", "githubRepoId"]),

		environments: defineTable({
			repositoryId: v.id("repositories"),
			name: v.string(),
			installCommand: v.optional(v.string()),
			devCommand: v.optional(v.string()),
			envVars: v.optional(
				v.array(v.object({ key: v.string(), value: v.string() }))
			),
			createdAt: v.number(),
			updatedAt: v.number(),
		}).index("by_repository", ["repositoryId"]),

		sandboxes: defineTable({
			environmentId: v.id("environments"),
			daytonaSandboxId: v.optional(v.string()),
			baseUrl: v.optional(v.string()),
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
		}).index("by_environment", ["environmentId"]),

		agentSessions: defineTable({
			slug: v.string(),
			title: v.string(),
			sandboxId: v.id("sandboxes"),
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
			.index("by_sandbox", ["sandboxId"])
			.index("by_slug", ["slug"]),
	},
	// TODO: remove schemaValidation: false before launch
	{ schemaValidation: false }
);
