"use node";

import { anthropic } from "@ai-sdk/anthropic";
import { generateText, Output } from "ai";
import type { GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";

type ActionCtx = GenericActionCtx<DataModel>;
const TRAILING_WORKSPACE_PATTERN = /(?:\s*[-–—]?\s*)workspace\s*$/i;

function normalizeSpaceName(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.replace(TRAILING_WORKSPACE_PATTERN, "")
		.trim()
		.slice(0, 80);
}

async function generateSpaceName(firstMessage: string): Promise<string> {
	const prompt = [
		"Generate a concise natural-language name for a workspace based on the user's first request.",
		"Rules:",
		"- Use normal casing and spaces (no slug formatting).",
		"- The name should read like natural text describing the task.",
		'- Do not end the name with the word "workspace".',
		"- Keep it concise (about 2 to 7 words).",
		"- Return only the name in plain text.",
		`User request: ${firstMessage}`,
	].join("\n");

	const { output } = await generateText({
		model: anthropic("claude-haiku-4-5"),
		output: Output.object({
			schema: z.object({
				name: z.string(),
			}),
		}),
		temperature: 0,
		prompt,
	});

	return (
		normalizeSpaceName(output?.name ?? "") || normalizeSpaceName(firstMessage)
	);
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
