"use node";

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import type { GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { isGeneratedBranchName } from "./lib/branchName";
import { sanitizeBranchName } from "./lib/git";

type ActionCtx = GenericActionCtx<DataModel>;

async function generateBranchName(
	firstMessage: string,
	defaultBranch: string
): Promise<string> {
	const prompt = [
		"Generate a concise git branch name for the user's first request.",
		"Rules:",
		"- Lowercase letters, numbers, and hyphens only.",
		"- Use 2 to 5 words separated by hyphens.",
		"- Do not add prefixes like feat/, fix/, chore/, or task/.",
		`- Do not return ${defaultBranch}, main, or master.`,
		"- Return only the branch name.",
		`User request: ${firstMessage}`,
	].join("\n");

	const { object } = await generateObject({
		model: anthropic("claude-haiku-4-5"),
		schema: z.object({
			branchName: z.string(),
		}),
		temperature: 0,
		prompt,
	});

	const candidate = sanitizeBranchName(object.branchName);
	if (candidate === defaultBranch) {
		return sanitizeBranchName(`${candidate}-changes`);
	}
	return candidate;
}

export const generateAndApplyBranchName = internalAction({
	args: {
		spaceId: v.id("spaces"),
		oldBranchName: v.string(),
		firstMessage: v.string(),
	},
	handler: async (ctx: ActionCtx, args) => {
		const space = await ctx.runQuery(internal.spaces.internalGet, {
			id: args.spaceId,
		});

		if (space.branchName !== args.oldBranchName) {
			return;
		}

		if (!isGeneratedBranchName(space.branchName)) {
			return;
		}

		const firstMessage = args.firstMessage.trim();
		if (!firstMessage) {
			return;
		}

		const newBranchName = await generateBranchName(
			firstMessage,
			space.environment.repository.defaultBranch
		);
		if (newBranchName === space.branchName) {
			return;
		}

		await ctx.runMutation(internal.spaces.internalUpdateBranchName, {
			id: args.spaceId,
			expectedBranchName: args.oldBranchName,
			branchName: newBranchName,
		});
	},
});
