"use node";

import { Nango } from "@nangohq/node";
import { v } from "convex/values";
import { Sandbox } from "e2b";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { quoteShellArg } from "./lib/git";
import { getGitHubToken } from "./lib/nango";
import {
	BASE_TEMPLATE,
	REPO_SYNC_TIMEOUT_MS,
	runRootCommand,
	SANDBOX_USER,
	SANDBOX_WORKDIR,
} from "./lib/sandbox";

const SNAPSHOT_ERROR_MAX_LENGTH = 2000;

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

export const buildInitialSnapshot = internalAction({
	args: {
		projectId: v.id("projects"),
		snapshotId: v.id("snapshots"),
		setAsDefault: v.boolean(),
	},
	handler: async (ctx, args) => {
		let sandbox: Sandbox | null = null;

		try {
			const project = await ctx.runQuery(internal.projects.internalGet, {
				id: args.projectId,
			});

			if (
				project.githubRepoId &&
				project.githubOwner &&
				project.githubName &&
				project.defaultBranch
			) {
				const nangoSecretKey = process.env.NANGO_SECRET_KEY;
				if (!nangoSecretKey) {
					throw new Error("Missing NANGO_SECRET_KEY env var");
				}

				const nango = new Nango({ secretKey: nangoSecretKey });
				const githubToken = await getGitHubToken(nango, project.userId);

				const workdir = SANDBOX_WORKDIR;
				const repoUrl = `https://x-access-token:${githubToken}@github.com/${project.githubOwner}/${project.githubName}.git`;
				const safeRepoUrl = quoteShellArg(repoUrl);
				const safeDefaultBranch = quoteShellArg(project.defaultBranch);
				const safeWorkdir = quoteShellArg(workdir);

				sandbox = await Sandbox.betaCreate(BASE_TEMPLATE, {
					network: { allowPublicTraffic: true },
					envs: project.secrets ?? {},
				});

				await runRootCommand(
					sandbox,
					`git clone ${safeRepoUrl} ${safeWorkdir} --branch ${safeDefaultBranch} --single-branch`,
					{ timeoutMs: REPO_SYNC_TIMEOUT_MS }
				);
				await runRootCommand(
					sandbox,
					`chown -R ${SANDBOX_USER}:${SANDBOX_USER} ${safeWorkdir}`
				);
			} else {
				sandbox = await Sandbox.betaCreate(BASE_TEMPLATE, {
					network: { allowPublicTraffic: true },
					envs: project.secrets ?? {},
				});
				const workdir = SANDBOX_WORKDIR;
				const safeWorkdir = quoteShellArg(workdir);
				await runRootCommand(
					sandbox,
					`mkdir -p ${safeWorkdir} && chown -R ${SANDBOX_USER}:${SANDBOX_USER} ${safeWorkdir}`
				);
			}

			const snapshot = await sandbox.createSnapshot();

			await ctx.runMutation(internal.snapshot.completeSnapshot, {
				snapshotId: args.snapshotId,
				projectId: args.projectId,
				status: "ready",
				externalSnapshotId: snapshot.snapshotId,
				setAsDefault: args.setAsDefault,
			});
		} catch (error) {
			await ctx.runMutation(internal.snapshot.completeSnapshot, {
				snapshotId: args.snapshotId,
				status: "error",
				error: formatSnapshotError(error),
			});
			throw error;
		} finally {
			if (sandbox) {
				try {
					await sandbox.kill();
				} catch {
					// Best-effort cleanup
				}
			}
			await ctx.runMutation(internal.projects.completeSnapshotBuild, {
				id: args.projectId,
			});
		}
	},
});

export const createFromSandbox = internalAction({
	args: {
		projectId: v.id("projects"),
		snapshotId: v.id("snapshots"),
		sandboxId: v.string(),
		setAsDefault: v.boolean(),
	},
	handler: async (ctx, args) => {
		try {
			const sandbox = await Sandbox.connect(args.sandboxId);
			const snapshot = await sandbox.createSnapshot();

			await ctx.runMutation(internal.snapshot.completeSnapshot, {
				snapshotId: args.snapshotId,
				projectId: args.projectId,
				status: "ready",
				externalSnapshotId: snapshot.snapshotId,
				setAsDefault: args.setAsDefault,
			});
		} catch (error) {
			await ctx.runMutation(internal.snapshot.completeSnapshot, {
				snapshotId: args.snapshotId,
				status: "error",
				error: formatSnapshotError(error),
			});
			throw error;
		} finally {
			await ctx.runMutation(internal.projects.completeSnapshotBuild, {
				id: args.projectId,
			});
		}
	},
});
