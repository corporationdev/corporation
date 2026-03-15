import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { tables } from "./schema.generated";

const schema = defineSchema({
	...tables,
	deviceCode: defineTable({
		deviceCode: v.string(),
		userCode: v.string(),
		userId: v.optional(v.union(v.null(), v.string())),
		expiresAt: v.number(),
		status: v.string(),
		lastPolledAt: v.optional(v.union(v.null(), v.number())),
		pollingInterval: v.optional(v.union(v.null(), v.number())),
		clientId: v.optional(v.union(v.null(), v.string())),
		scope: v.optional(v.union(v.null(), v.string())),
	})
		.index("deviceCode", ["deviceCode"])
		.index("userCode", ["userCode"]),
	apikey: defineTable({
		configId: v.string(),
		name: v.optional(v.union(v.null(), v.string())),
		start: v.optional(v.union(v.null(), v.string())),
		referenceId: v.string(),
		prefix: v.optional(v.union(v.null(), v.string())),
		key: v.string(),
		refillInterval: v.optional(v.union(v.null(), v.number())),
		refillAmount: v.optional(v.union(v.null(), v.number())),
		lastRefillAt: v.optional(v.union(v.null(), v.number())),
		enabled: v.optional(v.union(v.null(), v.boolean())),
		rateLimitEnabled: v.optional(v.union(v.null(), v.boolean())),
		rateLimitTimeWindow: v.optional(v.union(v.null(), v.number())),
		rateLimitMax: v.optional(v.union(v.null(), v.number())),
		requestCount: v.optional(v.union(v.null(), v.number())),
		remaining: v.optional(v.union(v.null(), v.number())),
		lastRequest: v.optional(v.union(v.null(), v.number())),
		expiresAt: v.optional(v.union(v.null(), v.number())),
		createdAt: v.number(),
		updatedAt: v.number(),
		permissions: v.optional(v.union(v.null(), v.string())),
		metadata: v.optional(v.union(v.null(), v.string())),
	})
		.index("referenceId", ["referenceId"])
		.index("key", ["key"]),
});
export default schema;
