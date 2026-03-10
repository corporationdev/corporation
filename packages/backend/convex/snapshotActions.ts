"use node";

import { Nango } from "@nangohq/node";
import type { FunctionReturnType } from "convex/server";
import { v } from "convex/values";
import { Sandbox } from "e2b";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { quoteShellArg } from "./lib/git";
import { getGitHubToken } from "./lib/nango";
import {
	REPO_SYNC_TIMEOUT_MS,
	runWorkspaceCommand,
	SANDBOX_WORKDIR,
} from "./lib/sandbox";

const SNAPSHOT_ERROR_MAX_LENGTH = 2000;
const REDACTED_SECRET = "[REDACTED]";
type Space = Awaited<FunctionReturnType<typeof internal.spaces.internalGet>>;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactSensitiveValue(message: string, value?: string | null): string {
	if (!value) {
		return message;
	}
	return message.replace(new RegExp(escapeRegExp(value), "g"), REDACTED_SECRET);
}

function formatSnapshotError(
	error: unknown,
	secretsToRedact: Array<string | null | undefined> = []
): string {
	const rawMessage =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "Unknown snapshot build error";
	const message = secretsToRedact.reduce<string>(
		(currentMessage, secret) => redactSensitiveValue(currentMessage, secret),
		rawMessage.replace(
			/https:\/\/x-access-token:[^@\s]+@github\.com/g,
			`https://x-access-token:${REDACTED_SECRET}@github.com`
		)
	);
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
		let githubToken: string | null = null;

		try {
			const project = await ctx.runQuery(internal.projects.internalGet, {
				id: args.projectId,
			});
			const userProject = await ctx.runQuery(
				internal.projects.internalGetUserProject,
				{ userId: project.userId }
			);
			if (!userProject?.defaultSnapshotId) {
				throw new Error(
					"You must create your personal workspace before creating a project"
				);
			}
			const sourceSnapshot = await ctx.runQuery(internal.snapshot.internalGet, {
				id: userProject.defaultSnapshotId,
			});
			if (
				sourceSnapshot.status !== "ready" ||
				!sourceSnapshot.externalSnapshotId
			) {
				throw new Error("Your personal workspace snapshot is not ready yet");
			}

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
				githubToken = await getGitHubToken(nango, project.userId);

				const workdir = SANDBOX_WORKDIR;
				const repoUrl = `https://github.com/${project.githubOwner}/${project.githubName}.git`;
				const safeRepoUrl = quoteShellArg(repoUrl);
				const safeDefaultBranch = quoteShellArg(project.defaultBranch);
				const safeWorkdir = quoteShellArg(workdir);

				sandbox = await Sandbox.betaCreate(sourceSnapshot.externalSnapshotId, {
					network: { allowPublicTraffic: true },
					envs: project.secrets ?? {},
				});

				await runWorkspaceCommand(
					sandbox,
					`askpass_script=$(mktemp) && trap 'rm -f "$askpass_script"' EXIT && cat <<'EOF' > "$askpass_script"
#!/bin/sh
case "$1" in
	*Username*) printf '%s\\n' 'x-access-token' ;;
	*Password*) printf '%s\\n' "$GITHUB_TOKEN" ;;
	*) printf '\\n' ;;
esac
EOF
chmod 700 "$askpass_script" && mkdir -p ${safeWorkdir} && find ${safeWorkdir} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && GIT_ASKPASS="$askpass_script" GIT_TERMINAL_PROMPT=0 git clone ${safeRepoUrl} ${safeWorkdir} --branch ${safeDefaultBranch} --single-branch`,
					{
						cwd: "/",
						timeoutMs: REPO_SYNC_TIMEOUT_MS,
						envs: {
							GITHUB_TOKEN: githubToken,
						},
					}
				);
			} else {
				sandbox = await Sandbox.betaCreate(sourceSnapshot.externalSnapshotId, {
					network: { allowPublicTraffic: true },
					envs: project.secrets ?? {},
				});
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
				error: formatSnapshotError(error, [githubToken]),
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

export const rebuildWithEnvs = internalAction({
	args: {
		projectId: v.id("projects"),
		snapshotId: v.id("snapshots"),
		sourceExternalSnapshotId: v.string(),
		envs: v.record(v.string(), v.string()),
	},
	handler: async (ctx, args) => {
		let sandbox: Sandbox | null = null;

		try {
			sandbox = await Sandbox.betaCreate(args.sourceExternalSnapshotId, {
				network: { allowPublicTraffic: true },
				envs: args.envs,
			});

			const snapshot = await sandbox.createSnapshot();

			await ctx.runMutation(internal.snapshot.completeSnapshot, {
				snapshotId: args.snapshotId,
				projectId: args.projectId,
				status: "ready",
				externalSnapshotId: snapshot.snapshotId,
				setAsDefault: true,
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

export const saveSpaceState = internalAction({
	args: {
		spaceId: v.id("spaces"),
		snapshotId: v.id("snapshots"),
		setAsDefault: v.boolean(),
	},
	handler: async (ctx, args) => {
		const space: Space = await ctx.runQuery(internal.spaces.internalGet, {
			id: args.spaceId,
		});

		if (!space.sandboxId) {
			throw new Error("Sandbox is not running");
		}

		const snapshotId = args.snapshotId;
		let snapshotSaved = false;

		try {
			const sandbox = await Sandbox.connect(space.sandboxId);
			const snapshot = await sandbox.createSnapshot();

			await ctx.runMutation(internal.snapshot.completeSnapshot, {
				snapshotId,
				projectId: space.projectId,
				status: "ready",
				externalSnapshotId: snapshot.snapshotId,
				setAsDefault: args.setAsDefault,
			});
			snapshotSaved = true;
			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: space._id,
				snapshotId,
			});

			try {
				await Sandbox.betaPause(space.sandboxId);
			} catch (error) {
				await ctx.runMutation(internal.spaces.internalUpdate, {
					id: space._id,
					status: "running",
				});
				throw new Error(
					`Snapshot saved but failed to pause sandbox: ${formatSnapshotError(error)}`
				);
			}
			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: space._id,
				status: "paused",
			});

			await ctx.runMutation(internal.projects.completeSnapshotBuild, {
				id: space.projectId,
			});
		} catch (error) {
			if (!snapshotSaved) {
				await ctx.runMutation(internal.snapshot.completeSnapshot, {
					snapshotId,
					status: "error",
					error: formatSnapshotError(error),
				});
			}
			await ctx.runMutation(internal.projects.completeSnapshotBuild, {
				id: space.projectId,
			});
			throw error;
		}
	},
});
