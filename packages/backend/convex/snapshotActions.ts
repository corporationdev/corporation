"use node";

import type { BuildRequest } from "@corporation/shared/api/environments";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

async function triggerServerBuild(
	environmentId: string,
	body: BuildRequest
): Promise<void> {
	const serverUrl = process.env.SERVER_URL;
	const internalApiKey = process.env.INTERNAL_API_KEY;

	if (!(serverUrl && internalApiKey)) {
		throw new Error("Missing SERVER_URL or INTERNAL_API_KEY env vars");
	}

	const res = await fetch(
		`${serverUrl}/api/environments/${environmentId}/build`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${internalApiKey}`,
			},
			body: JSON.stringify(body),
		}
	);

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Build trigger failed (${res.status}): ${text}`);
	}
}

export const buildSnapshot = internalAction({
	args: {
		environmentId: v.id("environments"),
	},
	handler: async (ctx, args) => {
		const envWithRepo = await ctx.runQuery(internal.environments.internalGet, {
			id: args.environmentId,
		});

		try {
			await triggerServerBuild(args.environmentId, {
				type: "build",
				userId: envWithRepo.userId,
				config: {
					repository: {
						owner: envWithRepo.repository.owner,
						name: envWithRepo.repository.name,
						defaultBranch: envWithRepo.repository.defaultBranch,
					},
					setupCommand: envWithRepo.setupCommand,
					envByPath: envWithRepo.envByPath,
				},
			});
		} catch (error) {
			await ctx.runMutation(internal.environments.internalUpdate, {
				id: args.environmentId,
				snapshotStatus: "error",
			});
			throw error;
		}
	},
});

export const rebuildSnapshot = internalAction({
	args: {
		environmentId: v.id("environments"),
		snapshotId: v.string(),
	},
	handler: async (ctx, args) => {
		const envWithRepo = await ctx.runQuery(internal.environments.internalGet, {
			id: args.environmentId,
		});

		try {
			await triggerServerBuild(args.environmentId, {
				type: "rebuild",
				userId: envWithRepo.userId,
				config: {
					repository: {
						owner: envWithRepo.repository.owner,
						name: envWithRepo.repository.name,
						defaultBranch: envWithRepo.repository.defaultBranch,
					},
					setupCommand: envWithRepo.setupCommand,
					envByPath: envWithRepo.envByPath,
				},
				snapshotId: args.snapshotId,
			});
		} catch (error) {
			await ctx.runMutation(internal.environments.internalUpdate, {
				id: args.environmentId,
				snapshotStatus: "error",
			});
			throw error;
		}
	},
});

export const overrideSnapshot = internalAction({
	args: {
		environmentId: v.id("environments"),
		sandboxId: v.string(),
		snapshotCommitSha: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const envWithRepo = await ctx.runQuery(internal.environments.internalGet, {
			id: args.environmentId,
		});

		try {
			await triggerServerBuild(args.environmentId, {
				type: "override",
				userId: envWithRepo.userId,
				config: {
					repository: {
						owner: envWithRepo.repository.owner,
						name: envWithRepo.repository.name,
						defaultBranch: envWithRepo.repository.defaultBranch,
					},
					setupCommand: envWithRepo.setupCommand,
					envByPath: envWithRepo.envByPath,
				},
				sandboxId: args.sandboxId,
				snapshotCommitSha: args.snapshotCommitSha,
			});
		} catch (error) {
			await ctx.runMutation(internal.environments.internalUpdate, {
				id: args.environmentId,
				snapshotStatus: "error",
			});
			throw error;
		}
	},
});
