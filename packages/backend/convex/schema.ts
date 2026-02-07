import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
	agentSessions: defineTable({
		title: v.string(),
		userId: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
		archivedAt: v.union(v.number(), v.null()),
	})
		.index("by_user", ["userId"])
		.index("by_user_and_updated", ["userId", "updatedAt"]),
});
