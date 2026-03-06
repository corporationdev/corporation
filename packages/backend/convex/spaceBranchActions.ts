"use node";

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import type { GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";

type ActionCtx = GenericActionCtx<DataModel>;

async function generateSpaceName(firstMessage: string): Promise<string> {
	const prompt = [
		"Generate a concise name for a workspace based on the user's first request.",
		"Rules:",
		"- Lowercase letters, numbers, and hyphens only.",
		"- Use 2 to 5 words separated by hyphens.",
		"- Return only the name.",
		`User request: ${firstMessage}`,
	].join("\n");

	const { object } = await generateObject({
		model: anthropic("claude-haiku-4-5"),
		schema: z.object({
			name: z.string(),
		}),
		temperature: 0,
		prompt,
	});

	return object.name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 80);
}

export const generateAndApplyName = internalAction({
	args: {
		spaceId: v.id("spaces"),
		oldName: v.string(),
		firstMessage: v.string(),
	},
	handler: async (ctx: ActionCtx, args) => {
		const space = await ctx.runQuery(internal.spaces.internalGet, {
			id: args.spaceId,
		});

		if (space.name !== args.oldName) {
			return;
		}

		if (space.name !== "New Space") {
			return;
		}

		const firstMessage = args.firstMessage.trim();
		if (!firstMessage) {
			return;
		}

		const newName = await generateSpaceName(firstMessage);
		if (newName === space.name) {
			return;
		}

		await ctx.runMutation(internal.spaces.internalUpdateName, {
			id: args.spaceId,
			expectedName: args.oldName,
			name: newName,
		});
	},
});
