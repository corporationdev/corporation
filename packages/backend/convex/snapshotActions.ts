"use node";

import { Nango } from "@nangohq/node";
import { v } from "convex/values";
import { CommandExitError, Sandbox } from "e2b";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { getGitHubToken } from "./lib/nango";

const BASE_TEMPLATE = "corporation-base";

function truncateOutput(output: string, maxLength = 2000): string {
	if (output.length <= maxLength) {
		return output;
	}
	return `${output.slice(0, maxLength)}...`;
}

async function runRootCommand(
	sandbox: Sandbox,
	command: string,
	envs?: Record<string, string>
): Promise<void> {
	try {
		await sandbox.commands.run(command, {
			user: "root",
			timeoutMs: 30 * 60 * 1000,
			envs,
		});
	} catch (error) {
		if (error instanceof CommandExitError) {
			throw new Error(
				[
					`Snapshot bootstrap command failed: ${command}`,
					`Exit code: ${error.exitCode}`,
					`stderr: ${truncateOutput(error.stderr)}`,
					`stdout: ${truncateOutput(error.stdout)}`,
				].join("\n")
			);
		}
		throw error;
	}
}

export const buildSnapshot = internalAction({
	args: {
		environmentId: v.id("environments"),
	},
	handler: async (ctx, args) => {
		const e2bApiKey = process.env.E2B_API_KEY;
		const nangoSecretKey = process.env.NANGO_SECRET_KEY;
		if (!(e2bApiKey && nangoSecretKey)) {
			throw new Error("Missing E2B_API_KEY or NANGO_SECRET_KEY env vars");
		}
		const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
		if (!anthropicApiKey) {
			throw new Error(
				"Missing ANTHROPIC_API_KEY env var for sandbox-agent agent verification"
			);
		}
		let buildSandbox: Sandbox | undefined;
		try {
			const envWithRepo = await ctx.runQuery(
				internal.environments.internalGet,
				{
					id: args.environmentId,
				}
			);

			const { repository } = envWithRepo;
			const nango = new Nango({ secretKey: nangoSecretKey });
			const githubToken = await getGitHubToken(nango, envWithRepo.userId);

			const branchRes = await fetch(
				`https://api.github.com/repos/${repository.owner}/${repository.name}/branches/${repository.defaultBranch}`,
				{
					headers: {
						Authorization: `Bearer ${githubToken}`,
						Accept: "application/vnd.github+json",
					},
				}
			);
			const snapshotCommitSha = branchRes.ok
				? ((await branchRes.json()) as { commit: { sha: string } }).commit.sha
				: undefined;

			const repoDir = `/root/${repository.owner}-${repository.name}`;
			buildSandbox = await Sandbox.create(BASE_TEMPLATE, {
				apiKey: e2bApiKey,
				timeoutMs: 60 * 60 * 1000,
				envs: { ANTHROPIC_API_KEY: anthropicApiKey },
				network: { allowPublicTraffic: true },
			});

			await runRootCommand(
				buildSandbox,
				`git clone https://x-access-token:${githubToken}@github.com/${repository.owner}/${repository.name}.git ${repoDir} --branch ${repository.defaultBranch} --single-branch`
			);
			await runRootCommand(
				buildSandbox,
				`cd ${repoDir} && ${repository.setupCommand}`
			);
			await runRootCommand(
				buildSandbox,
				"sandbox-agent install-agent opencode --reinstall",
				{ ANTHROPIC_API_KEY: anthropicApiKey }
			);

			const snapshot = await buildSandbox.createSnapshot({ apiKey: e2bApiKey });

			await ctx.runMutation(internal.environments.completeSnapshotBuild, {
				id: args.environmentId,
				snapshotId: snapshot.snapshotId,
				snapshotCommitSha,
			});
		} catch (error) {
			await ctx.runMutation(internal.environments.internalUpdate, {
				id: args.environmentId,
				snapshotStatus: "error",
			});

			await ctx.runMutation(internal.environments.scheduleNextRebuild, {
				id: args.environmentId,
			});

			throw error;
		} finally {
			if (buildSandbox) {
				try {
					await buildSandbox.kill();
				} catch {
					// Best effort cleanup
				}
			}
		}
	},
});

export const deleteSnapshot = internalAction({
	args: {
		snapshotId: v.string(),
	},
	handler: async (_ctx, args) => {
		const e2bApiKey = process.env.E2B_API_KEY;
		if (!e2bApiKey) {
			throw new Error("Missing E2B_API_KEY env var");
		}

		try {
			await Sandbox.deleteSnapshot(args.snapshotId, { apiKey: e2bApiKey });
		} catch (error) {
			console.error(`Failed to delete snapshot ${args.snapshotId}:`, error);
		}
	},
});
