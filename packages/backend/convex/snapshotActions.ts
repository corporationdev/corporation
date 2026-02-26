"use node";

import { Nango } from "@nangohq/node";
import { v } from "convex/values";
import { CommandExitError, Sandbox } from "e2b";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { getGitHubToken } from "./lib/nango";
import { setupSandbox } from "./lib/sandbox";

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
		const nangoSecretKey = process.env.NANGO_SECRET_KEY;
		const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

		if (!(nangoSecretKey && anthropicApiKey)) {
			throw new Error("Missing NANGO_SECRET_KEY or ANTHROPIC_API_KEY env vars");
		}

		let buildSandbox: Sandbox | undefined;
		try {
			const envWithRepo = await ctx.runQuery(
				internal.environments.internalGet,
				{
					id: args.environmentId,
				}
			);

			const nango = new Nango({ secretKey: nangoSecretKey });
			const githubToken = await getGitHubToken(nango, envWithRepo.userId);

			buildSandbox = await Sandbox.betaCreate(BASE_TEMPLATE, {
				envs: { ANTHROPIC_API_KEY: anthropicApiKey },
				network: { allowPublicTraffic: true },
			});

			const snapshotCommitSha = await setupSandbox(
				buildSandbox,
				envWithRepo,
				githubToken,
				"clone"
			);

			await runRootCommand(
				buildSandbox,
				"sandbox-agent install-agent opencode --reinstall",
				{ ANTHROPIC_API_KEY: anthropicApiKey }
			);

			const snapshot = await buildSandbox.createSnapshot();

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
		}
	},
});

export const rebuildSnapshot = internalAction({
	args: {
		environmentId: v.id("environments"),
		snapshotId: v.string(),
	},
	handler: async (ctx, args) => {
		const nangoSecretKey = process.env.NANGO_SECRET_KEY;
		if (!nangoSecretKey) {
			throw new Error("Missing NANGO_SECRET_KEY env var");
		}

		const envWithRepo = await ctx.runQuery(internal.environments.internalGet, {
			id: args.environmentId,
		});

		let buildSandbox: Sandbox | undefined;
		try {
			const nango = new Nango({ secretKey: nangoSecretKey });
			const githubToken = await getGitHubToken(nango, envWithRepo.userId);

			buildSandbox = await Sandbox.betaCreate(args.snapshotId, {
				network: { allowPublicTraffic: true },
			});

			const snapshotCommitSha = await setupSandbox(
				buildSandbox,
				envWithRepo,
				githubToken,
				"pull"
			);

			const snapshot = await buildSandbox.createSnapshot();

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
		try {
			const sandbox = await Sandbox.connect(args.sandboxId);

			const snapshot = await sandbox.createSnapshot();

			await ctx.runMutation(internal.environments.completeSnapshotBuild, {
				id: args.environmentId,
				snapshotId: snapshot.snapshotId,
				snapshotCommitSha: args.snapshotCommitSha,
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
		}
	},
});
