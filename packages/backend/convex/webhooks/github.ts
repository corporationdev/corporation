import { z } from "zod";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";

const prPayloadSchema = z.object({
	action: z.string(),
	pull_request: z.object({
		merged: z.boolean(),
		base: z.object({
			ref: z.string(),
		}),
	}),
	repository: z.object({
		id: z.number(),
	}),
});

export async function handleGitHubWebhook(
	ctx: ActionCtx,
	payload: unknown
): Promise<void> {
	const parsed = prPayloadSchema.safeParse(payload);
	if (!parsed.success) {
		return;
	}

	const { action, pull_request, repository } = parsed.data;

	if (action !== "closed" || !pull_request.merged) {
		return;
	}

	const repos = await ctx.runQuery(
		internal.repositories.internalGetByGithubRepoId,
		{ githubRepoId: repository.id }
	);

	for (const repo of repos) {
		if (pull_request.base.ref !== repo.defaultBranch) {
			continue;
		}

		const environments = await ctx.runQuery(
			internal.environments.internalListByRepository,
			{ repositoryId: repo._id }
		);

		for (const env of environments) {
			await ctx.runMutation(internal.environments.internalRebuildSnapshot, {
				id: env._id,
			});
		}
	}
}
