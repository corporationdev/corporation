import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { authedQuery } from "./functions";

export const list = authedQuery({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db
			.query("agentConfig")
			.withIndex("by_user", (q) => q.eq("userId", ctx.userId))
			.collect();

		rows.sort((a, b) => b.updatedAt - a.updatedAt);

		return rows.map((row) => ({
			agentId: row.agentId,
			configOptions: row.configOptions,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		}));
	},
});

export const internalSaveProbeResults = internalMutation({
	args: {
		userId: v.string(),
		spaceId: v.id("spaces"),
		agents: v.array(
			v.object({
				id: v.string(),
				configOptions: v.array(v.any()),
			})
		),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.spaceId);
		if (!space) {
			throw new ConvexError("Space not found");
		}

		if (space.userId !== args.userId) {
			throw new ConvexError("Space not found");
		}

		const now = Date.now();
		const existingRows = await ctx.db
			.query("agentConfig")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.collect();
		const existingByAgentId = new Map<string, Doc<"agentConfig">>();
		for (const row of existingRows) {
			existingByAgentId.set(row.agentId, row);
		}

		const dedupedAgents = Array.from(
			new Map(args.agents.map((agent) => [agent.id, agent])).values()
		);
		const incomingIds = new Set(dedupedAgents.map((agent) => agent.id));

		for (const [agentId, row] of existingByAgentId) {
			if (!incomingIds.has(agentId)) {
				await ctx.db.delete(row._id);
			}
		}

		for (const agent of dedupedAgents) {
			const existing = existingByAgentId.get(agent.id);

			if (existing) {
				await ctx.db.patch(existing._id, {
					configOptions: agent.configOptions,
					updatedAt: now,
				});
			} else {
				await ctx.db.insert("agentConfig", {
					userId: args.userId,
					agentId: agent.id,
					configOptions: agent.configOptions,
					createdAt: now,
					updatedAt: now,
				});
			}
		}
	},
});
