"use node";

import { Nango } from "@nangohq/node";
import { v } from "convex/values";
import { Sandbox } from "e2b";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";
import { quoteShellArg } from "./lib/git";
import { getGitHubToken } from "./lib/nango";
import {
	bootServer,
	CODE_SERVER_PORT,
	CODE_SERVER_SESSION_NAME,
	DEV_SERVER_SESSION_NAME,
	getAiEnvs,
	getSandboxWorkdir,
	REPO_SYNC_TIMEOUT_MS,
	runRootCommand,
	SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS,
	SANDBOX_AGENT_PORT,
	SANDBOX_AGENT_SESSION_NAME,
	writeEnvFiles,
} from "./lib/sandbox";

const BASE_TEMPLATE = "corporation-base";
const SNAPSHOT_ERROR_MAX_LENGTH = 2000;
const LOG_FLUSH_INTERVAL_MS = 2500;

type SnapshotReporter = {
	appendLog: (chunk: string) => void;
	close: () => Promise<void>;
};

type SnapshotResult = {
	externalSnapshotId: string;
	snapshotCommitSha?: string;
};

function formatSnapshotError(error: unknown): string {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "Unknown snapshot build error";
	if (message.length <= SNAPSHOT_ERROR_MAX_LENGTH) {
		return message;
	}
	return `${message.slice(0, SNAPSHOT_ERROR_MAX_LENGTH)}...`;
}

function createSnapshotReporter(
	ctx: ActionCtx,
	snapshotId: Id<"snapshots">
): SnapshotReporter {
	let logBuffer = "";
	let queue = Promise.resolve();

	const enqueueProgress = (args: { logChunk?: string }) => {
		queue = queue.then(async () => {
			await ctx.runMutation(internal.snapshot.reportSnapshotProgress, {
				id: snapshotId,
				...args,
			});
		});
		return queue;
	};

	const flushLogs = async () => {
		if (logBuffer.length === 0) {
			return;
		}
		const chunk = logBuffer;
		logBuffer = "";
		await enqueueProgress({ logChunk: chunk });
	};

	const interval = setInterval(() => {
		flushLogs().catch((error: unknown) => {
			console.error("Failed to flush snapshot logs", error);
		});
	}, LOG_FLUSH_INTERVAL_MS);

	return {
		appendLog: (chunk: string) => {
			logBuffer += chunk;
		},
		close: async () => {
			clearInterval(interval);
			await flushLogs();
			await queue;
		},
	};
}

async function runTrackedSnapshot(
	ctx: ActionCtx,
	args: {
		snapshotId: Id<"snapshots">;
		type: "setup" | "update";
		environmentId: Id<"environments">;
		execute: (reporter: SnapshotReporter) => Promise<SnapshotResult>;
	}
): Promise<void> {
	const snapshotId = await ctx.runMutation(internal.snapshot.startSnapshot, {
		snapshotId: args.snapshotId,
		environmentId: args.environmentId,
		type: args.type,
	});

	const reporter = createSnapshotReporter(ctx, snapshotId);

	try {
		const result = await args.execute(reporter);

		try {
			await reporter.close();
		} catch (closeError) {
			await ctx.runMutation(internal.snapshot.completeSnapshot, {
				snapshotId,
				status: "error",
				error: formatSnapshotError(closeError),
			});
			return;
		}

		await ctx.runMutation(internal.snapshot.completeSnapshot, {
			snapshotId,
			environmentId: args.environmentId,
			status: "ready",
			...result,
		});
	} catch (error) {
		try {
			await reporter.close();
		} catch (closeError) {
			console.error("Failed to close snapshot reporter", closeError);
		}

		await ctx.runMutation(internal.snapshot.completeSnapshot, {
			snapshotId,
			status: "error",
			error: formatSnapshotError(error),
		});
		throw error;
	} finally {
		await ctx.runMutation(internal.environments.completeSnapshotBuild, {
			id: args.environmentId,
		});
	}
}

export const buildSnapshot = internalAction({
	args: {
		request: v.union(
			v.object({
				type: v.literal("setup"),
				environmentId: v.id("environments"),
				snapshotId: v.id("snapshots"),
			}),
			v.object({
				type: v.literal("update"),
				environmentId: v.id("environments"),
				snapshotId: v.id("snapshots"),
				oldExternalSnapshotId: v.string(),
			})
		),
	},
	handler: async (ctx, args) => {
		const request = args.request;
		await runTrackedSnapshot(ctx, {
			snapshotId: request.snapshotId,
			type: request.type,
			environmentId: request.environmentId,
			execute: async (reporter) => {
				const nangoSecretKey = process.env.NANGO_SECRET_KEY;
				if (!nangoSecretKey) {
					throw new Error("Missing NANGO_SECRET_KEY env var");
				}
				const aiEnvs = getAiEnvs();

				const environment = await ctx.runQuery(
					internal.environments.internalGet,
					{
						id: request.environmentId,
					}
				);
				const nango = new Nango({ secretKey: nangoSecretKey });
				const githubToken = await getGitHubToken(nango, environment.userId);

				const { repository } = environment;
				const workdir = getSandboxWorkdir(repository);
				const repoUrl = `https://x-access-token:${githubToken}@github.com/${repository.owner}/${repository.name}.git`;
				const safeRepoUrl = quoteShellArg(repoUrl);
				const safeDefaultBranch = quoteShellArg(repository.defaultBranch);
				const appendLog = (chunk: string) => reporter.appendLog(chunk);

				// Create sandbox and sync repo (diverges by type)
				let sandbox: Sandbox;
				if (request.type === "setup") {
					sandbox = await Sandbox.betaCreate(BASE_TEMPLATE, {
						envs: aiEnvs,
						network: { allowPublicTraffic: true },
					});

					const safeWorkdir = quoteShellArg(workdir);
					await runRootCommand(
						sandbox,
						`git clone ${safeRepoUrl} ${safeWorkdir} --branch ${safeDefaultBranch} --single-branch`,
						{
							timeoutMs: REPO_SYNC_TIMEOUT_MS,
							onStdout: appendLog,
							onStderr: appendLog,
						}
					);
				} else {
					sandbox = await Sandbox.betaCreate(request.oldExternalSnapshotId, {
						envs: aiEnvs,
						network: { allowPublicTraffic: true },
					});

					await runRootCommand(
						sandbox,
						`git remote set-url origin ${safeRepoUrl} && git pull origin ${safeDefaultBranch}`,
						{
							cwd: workdir,
							timeoutMs: REPO_SYNC_TIMEOUT_MS,
							onStdout: appendLog,
							onStderr: appendLog,
						}
					);
				}

				// Shared: write env files, run command, get commit SHA
				await writeEnvFiles(sandbox, environment, workdir);
				appendLog("Environment files written.\n");

				const installCommand =
					request.type === "update"
						? environment.updateCommand
						: environment.setupCommand;
				await runRootCommand(sandbox, installCommand, {
					cwd: workdir,
					timeoutMs: REPO_SYNC_TIMEOUT_MS,
					onStdout: appendLog,
					onStderr: appendLog,
				});

				const shaResult = await runRootCommand(sandbox, "git rev-parse HEAD", {
					cwd: workdir,
				});
				const snapshotCommitSha = shaResult.stdout.trim();

				// Setup-only: boot all servers
				if (request.type === "setup") {
					await Promise.all([
						bootServer(sandbox, {
							sessionName: DEV_SERVER_SESSION_NAME,
							command: environment.devCommand,
							healthUrl: `http://localhost:${environment.devPort}/`,
							workdir,
							appendLog,
						}),
						bootServer(sandbox, {
							sessionName: SANDBOX_AGENT_SESSION_NAME,
							command: `env SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS=${SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS} sandbox-agent server --no-token --host 0.0.0.0 --port ${SANDBOX_AGENT_PORT}`,
							healthUrl: `http://localhost:${SANDBOX_AGENT_PORT}/v1/health`,
						}),
						bootServer(sandbox, {
							sessionName: CODE_SERVER_SESSION_NAME,
							command: `code-server --bind-addr 0.0.0.0:${CODE_SERVER_PORT} --auth none ${workdir}`,
							healthUrl: `http://localhost:${CODE_SERVER_PORT}`,
						}),
					]);
				}

				// Shared: create snapshot and cleanup
				try {
					reporter.appendLog("Creating snapshot...\n");
					const snapshot = await sandbox.createSnapshot();
					reporter.appendLog(`Snapshot created: ${snapshot.snapshotId}\n`);

					return {
						externalSnapshotId: snapshot.snapshotId,
						snapshotCommitSha,
					};
				} finally {
					try {
						await sandbox.kill();
					} catch {
						// Best-effort cleanup
					}
				}
			},
		});
	},
});
