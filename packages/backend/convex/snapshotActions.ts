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
	getSandboxWorkdir,
	REPO_SYNC_TIMEOUT_MS,
	runRootCommand,
} from "./lib/sandbox";

const BASE_TEMPLATE = "corporation-base";
const SNAPSHOT_ERROR_MAX_LENGTH = 2000;
const LOG_FLUSH_INTERVAL_MS = 2500;

type SnapshotReporter = {
	appendLog: (chunk: string) => void;
	close: () => Promise<void>;
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
		repositoryId: Id<"repositories">;
		execute: (reporter: SnapshotReporter) => Promise<string>;
	}
): Promise<void> {
	const snapshotId = await ctx.runMutation(internal.snapshot.startSnapshot, {
		snapshotId: args.snapshotId,
		repositoryId: args.repositoryId,
		type: args.type,
	});

	const reporter = createSnapshotReporter(ctx, snapshotId);

	try {
		const externalSnapshotId = await args.execute(reporter);

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
			repositoryId: args.repositoryId,
			status: "ready",
			externalSnapshotId,
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
		await ctx.runMutation(internal.repositories.completeSnapshotBuild, {
			id: args.repositoryId,
		});
	}
}

export const buildSnapshot = internalAction({
	args: {
		request: v.union(
			v.object({
				type: v.literal("setup"),
				repositoryId: v.id("repositories"),
				snapshotId: v.id("snapshots"),
			}),
			v.object({
				type: v.literal("update"),
				repositoryId: v.id("repositories"),
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
			repositoryId: request.repositoryId,
			execute: async (reporter) => {
				const nangoSecretKey = process.env.NANGO_SECRET_KEY;
				if (!nangoSecretKey) {
					throw new Error("Missing NANGO_SECRET_KEY env var");
				}

				const repository = await ctx.runQuery(
					internal.repositories.internalGet,
					{
						id: request.repositoryId,
					}
				);

				const nango = new Nango({ secretKey: nangoSecretKey });
				const githubToken = await getGitHubToken(nango, repository.userId);

				const workdir = getSandboxWorkdir(repository);
				const repoUrl = `https://x-access-token:${githubToken}@github.com/${repository.owner}/${repository.name}.git`;
				const safeRepoUrl = quoteShellArg(repoUrl);
				const safeDefaultBranch = quoteShellArg(repository.defaultBranch);
				const appendLog = (chunk: string) => reporter.appendLog(chunk);

				// Create sandbox and sync repo (diverges by type)
				const sandboxEnvs = repository.secrets ?? {};
				let sandbox: Sandbox;
				if (request.type === "setup") {
					sandbox = await Sandbox.betaCreate(BASE_TEMPLATE, {
						network: { allowPublicTraffic: true },
						envs: sandboxEnvs,
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
						network: { allowPublicTraffic: true },
						envs: sandboxEnvs,
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

				// Create snapshot and cleanup
				try {
					reporter.appendLog("Creating snapshot...\n");
					const snapshot = await sandbox.createSnapshot();
					reporter.appendLog(`Snapshot created: ${snapshot.snapshotId}\n`);

					return snapshot.snapshotId;
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
