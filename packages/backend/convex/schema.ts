import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
	repositories: defineTable({
		userId: v.string(),
		githubRepoId: v.number(),
		owner: v.string(),
		name: v.string(),
		defaultBranch: v.string(),
		installCommand: v.optional(v.string()),
		devCommand: v.optional(v.string()),
		envVars: v.optional(
			v.array(v.object({ key: v.string(), value: v.string() }))
		),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_github_repo_id", ["githubRepoId"]),

	sandboxes: defineTable({
		repositoryId: v.id("repositories"),
		daytonaSandboxId: v.optional(v.string()),
		branchName: v.string(),
		status: v.union(
			v.literal("provisioning"),
			v.literal("running"),
			v.literal("stopped"),
			v.literal("failed")
		),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index("by_repository", ["repositoryId"]),

	agentSessions: defineTable({
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
	}).index("by_sandbox", ["sandboxId"]),
});
