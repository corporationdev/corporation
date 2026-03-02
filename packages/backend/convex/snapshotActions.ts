"use node";

import { Nango } from "@nangohq/node";
import { v } from "convex/values";
import { Sandbox } from "e2b";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";
import { getGitHubToken } from "./lib/nango";
import { runRootCommand, setupSandbox } from "./lib/sandbox";

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
		type: "build" | "rebuild" | "override";
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
		await ctx.runMutation(internal.environments.scheduleNextRebuild, {
			id: args.environmentId,
		});
	}
}

export const buildSnapshot = internalAction({
	args: {
		request: v.union(
			v.object({
				type: v.literal("build"),
				environmentId: v.id("environments"),
				snapshotId: v.id("snapshots"),
			}),
			v.object({
				type: v.literal("rebuild"),
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
				const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
				if (!(nangoSecretKey && anthropicApiKey)) {
					throw new Error(
						"Missing NANGO_SECRET_KEY or ANTHROPIC_API_KEY env var"
					);
				}

				const environment = await ctx.runQuery(
					internal.environments.internalGet,
					{
						id: request.environmentId,
					}
				);
				const nango = new Nango({ secretKey: nangoSecretKey });
				const githubToken = await getGitHubToken(nango, environment.userId);

				const shouldUseRebuildBase = request.type === "rebuild";
				const template = shouldUseRebuildBase
					? request.oldExternalSnapshotId
					: BASE_TEMPLATE;

				const sandbox = await Sandbox.betaCreate(template, {
					envs: { ANTHROPIC_API_KEY: anthropicApiKey },
					network: { allowPublicTraffic: true },
				});

				try {
					const snapshotCommitSha = await setupSandbox(
						sandbox,
						environment,
						githubToken,
						shouldUseRebuildBase ? "pull" : "clone",
						(chunk) => {
							reporter.appendLog(chunk);
						}
					);

					if (!shouldUseRebuildBase) {
						await runRootCommand(
							sandbox,
							"sandbox-agent install-agent opencode --reinstall",
							{
								envs: anthropicApiKey
									? { ANTHROPIC_API_KEY: anthropicApiKey }
									: undefined,
								onStdout: (data: string) => reporter.appendLog(data),
								onStderr: (data: string) => reporter.appendLog(data),
							}
						);
					}

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

export const overrideSnapshot = internalAction({
	args: {
		environmentId: v.id("environments"),
		snapshotId: v.id("snapshots"),
		sandboxId: v.string(),
		snapshotCommitSha: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await runTrackedSnapshot(ctx, {
			snapshotId: args.snapshotId,
			environmentId: args.environmentId,
			type: "override",
			execute: async (reporter) => {
				reporter.appendLog("Connecting to running sandbox...\n");
				const sandbox = await Sandbox.connect(args.sandboxId);
				reporter.appendLog("Creating snapshot from running sandbox...\n");
				const snapshot = await sandbox.createSnapshot();
				reporter.appendLog(`Snapshot created: ${snapshot.snapshotId}\n`);

				return {
					externalSnapshotId: snapshot.snapshotId,
					snapshotCommitSha: args.snapshotCommitSha,
				};
			},
		});
	},
});
