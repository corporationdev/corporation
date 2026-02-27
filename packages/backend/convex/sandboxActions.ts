"use node";

import { Nango } from "@nangohq/node";
import type { FunctionReturnType, GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import { CommandExitError, Sandbox } from "e2b";
import { internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { normalizeBranchName, quoteShellArg } from "./lib/git";
import { getGitHubToken } from "./lib/nango";
import { pushBranch, setupSandbox } from "./lib/sandbox";

type Space = Awaited<FunctionReturnType<typeof internal.spaces.internalGet>>;

type ActionCtx = GenericActionCtx<DataModel>;

const SANDBOX_AGENT_PORT = 5799;
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServerReady(sandbox: Sandbox): Promise<void> {
	const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;

	while (Date.now() < deadline) {
		try {
			await sandbox.commands.run(
				`curl -sf http://localhost:${SANDBOX_AGENT_PORT}/v1/health`
			);
			return;
		} catch (error) {
			if (!(error instanceof CommandExitError)) {
				throw error;
			}
		}
		await sleep(SERVER_POLL_INTERVAL_MS);
	}

	throw new Error("sandbox-agent server failed to start within timeout");
}

async function bootSandboxAgent(sandbox: Sandbox): Promise<void> {
	await sandbox.commands.run(
		`nohup sandbox-agent server --no-token --host 0.0.0.0 --port ${SANDBOX_AGENT_PORT} >/tmp/sandbox-agent.log 2>&1 &`
	);
	await waitForServerReady(sandbox);
}

async function isSandboxAgentHealthy(sandbox: Sandbox): Promise<boolean> {
	try {
		await sandbox.commands.run(
			`curl -sf --max-time 1 http://localhost:${SANDBOX_AGENT_PORT}/v1/health`
		);
		return true;
	} catch (error) {
		if (error instanceof CommandExitError) {
			return false;
		}
		throw error;
	}
}

async function ensureSandboxAgentRunning(sandbox: Sandbox): Promise<void> {
	const healthy = await isSandboxAgentHealthy(sandbox);
	if (!healthy) {
		await bootSandboxAgent(sandbox);
	}
}

function getPreviewUrl(sandbox: Sandbox, port: number): string {
	return `https://${sandbox.getHost(port)}`;
}

async function ensureBranchCheckedOut(
	sandbox: Sandbox,
	workdir: string,
	branchName: string,
	defaultBranch: string
): Promise<void> {
	if (branchName === defaultBranch) {
		return;
	}

	const safeBranchName = quoteShellArg(normalizeBranchName(branchName));
	const safeDefaultBranch = quoteShellArg(defaultBranch);

	try {
		await sandbox.commands.run(`git checkout ${safeBranchName}`, {
			cwd: workdir,
			user: "root",
		});
	} catch (error) {
		if (!(error instanceof CommandExitError)) {
			throw error;
		}

		await sandbox.commands.run(
			`git checkout -b ${safeBranchName} ${safeDefaultBranch}`,
			{
				cwd: workdir,
				user: "root",
			}
		);
	}
}

async function provisionSandbox(
	ctx: ActionCtx,
	spaceId: Id<"spaces">,
	snapshotId: string
): Promise<{
	sandboxId: string;
	sandboxUrl: string;
}> {
	const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
	if (!anthropicApiKey) {
		throw new Error("Missing ANTHROPIC_API_KEY env var");
	}

	await ctx.runMutation(internal.spaces.internalUpdate, {
		id: spaceId,
		status: "creating" as const,
	});

	const sandbox = await Sandbox.betaCreate(snapshotId, {
		envs: { ANTHROPIC_API_KEY: anthropicApiKey },
		allowInternetAccess: true,
		network: { allowPublicTraffic: true },
		autoPause: true,
	});

	await bootSandboxAgent(sandbox);

	const sandboxUrl = getPreviewUrl(sandbox, SANDBOX_AGENT_PORT);
	return { sandboxId: sandbox.sandboxId, sandboxUrl };
}

async function resolveSandbox(
	ctx: ActionCtx,
	space: Space
): Promise<{
	sandboxId: string;
	sandboxUrl?: string;
}> {
	const { snapshotId } = space.environment;

	if (!snapshotId) {
		throw new Error("Environment snapshot is not ready yet");
	}

	if (!space.sandboxId) {
		return await provisionSandbox(ctx, space._id, snapshotId);
	}

	try {
		await ctx.runMutation(internal.spaces.internalUpdate, {
			id: space._id,
			status: "creating" as const,
		});

		const sandbox = await Sandbox.connect(space.sandboxId);
		await ensureSandboxAgentRunning(sandbox);

		return {
			sandboxId: sandbox.sandboxId,
			sandboxUrl: getPreviewUrl(sandbox, SANDBOX_AGENT_PORT),
		};
	} catch {
		return await provisionSandbox(ctx, space._id, snapshotId);
	}
}

export const stopSandbox = internalAction({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		try {
			const space = await ctx.runQuery(internal.spaces.internalGet, {
				id: args.spaceId,
			});

			if (!space.sandboxId) {
				throw new Error("Space has no sandbox to stop");
			}

			await Sandbox.betaPause(space.sandboxId);

			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "paused",
			});
		} catch (error) {
			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "error",
			});

			throw error;
		}
	},
});

export const archiveSandbox = internalAction({
	args: {
		sandboxId: v.string(),
	},
	handler: async (_ctx, args) => {
		try {
			await Sandbox.betaPause(args.sandboxId);
		} catch (error) {
			console.error("Failed to pause sandbox in E2B", error);
		}
	},
});

export const deleteSandbox = internalAction({
	args: {
		sandboxId: v.string(),
	},
	handler: async (_ctx, args) => {
		try {
			await Sandbox.kill(args.sandboxId);
		} catch (error) {
			console.error("Failed to delete sandbox in E2B", error);
		}
	},
});

export const ensureSandbox = internalAction({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		try {
			const space = await ctx.runQuery(internal.spaces.internalGet, {
				id: args.spaceId,
			});

			const { sandboxId, sandboxUrl } = await resolveSandbox(ctx, space);

			const sandbox = await Sandbox.connect(sandboxId);
			const { repository } = space.environment;
			const workdir = `/root/${repository.owner}-${repository.name}`;
			await ensureBranchCheckedOut(
				sandbox,
				workdir,
				space.branchName,
				repository.defaultBranch
			);

			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "running",
				sandboxId,
				sandboxUrl,
			});
		} catch (error) {
			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "error",
			});

			throw error;
		}
	},
});

export const syncRepository = internalAction({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const nangoSecretKey = process.env.NANGO_SECRET_KEY;
		if (!nangoSecretKey) {
			throw new Error("Missing NANGO_SECRET_KEY env var");
		}

		const space = await ctx.runQuery(internal.spaces.internalGet, {
			id: args.spaceId,
		});

		if (!space.sandboxId) {
			throw new Error("Space has no sandbox to sync");
		}

		const nango = new Nango({ secretKey: nangoSecretKey });
		const githubToken = await getGitHubToken(nango, space.environment.userId);

		const sandbox = await Sandbox.connect(space.sandboxId);

		const lastSyncedCommitSha = await setupSandbox(
			sandbox,
			space.environment,
			githubToken,
			"pull"
		);

		if (lastSyncedCommitSha) {
			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				lastSyncedCommitSha,
			});
		}
	},
});

export const renameBranch = internalAction({
	args: {
		spaceId: v.id("spaces"),
		oldBranchName: v.string(),
		newBranchName: v.string(),
	},
	handler: async (ctx, args) => {
		try {
			const space = await ctx.runQuery(internal.spaces.internalGet, {
				id: args.spaceId,
			});

			// Ignore jobs that no longer match the current branch state.
			if (space.branchName !== args.oldBranchName) {
				return;
			}

			if (!space.sandboxId) {
				throw new Error("Space has no sandbox");
			}

			const sandbox = await Sandbox.connect(space.sandboxId);
			const { repository } = space.environment;
			const workdir = `/root/${repository.owner}-${repository.name}`;
			const safeOldBranchName = quoteShellArg(args.oldBranchName);
			const normalizedNewBranchName = normalizeBranchName(args.newBranchName);
			const safeNewBranchName = quoteShellArg(normalizedNewBranchName);

			await sandbox.commands.run(
				`git branch -m ${safeOldBranchName} ${safeNewBranchName}`,
				{ cwd: workdir, user: "root" }
			);

			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				branchName: normalizedNewBranchName,
				error: "",
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				error: message,
			});
			throw error;
		}
	},
});

async function getGitHubUser(
	token: string
): Promise<{ name: string; email: string }> {
	const res = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
		},
	});
	if (!res.ok) {
		throw new Error(`Failed to fetch GitHub user: ${res.status}`);
	}
	const data = (await res.json()) as {
		login: string;
		name: string | null;
		email: string | null;
	};
	return {
		name: data.name ?? data.login,
		email: data.email ?? `${data.login}@users.noreply.github.com`,
	};
}

async function resolveSpaceForGitOp(
	ctx: ActionCtx,
	spaceId: Id<"spaces">
): Promise<{
	space: Space;
	githubToken: string;
	author: { name: string; email: string };
	sandbox: Sandbox;
}> {
	const nangoSecretKey = process.env.NANGO_SECRET_KEY;
	if (!nangoSecretKey) {
		throw new Error("Missing NANGO_SECRET_KEY env var");
	}

	const space = await ctx.runQuery(internal.spaces.internalGet, {
		id: spaceId,
	});

	if (!space.sandboxId) {
		throw new Error("Space has no sandbox");
	}

	const nango = new Nango({ secretKey: nangoSecretKey });
	const githubToken = await getGitHubToken(nango, space.environment.userId);
	const author = await getGitHubUser(githubToken);
	const sandbox = await Sandbox.connect(space.sandboxId);

	return { space, githubToken, author, sandbox };
}

export const pushAndCreatePR = internalAction({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		await ctx.runMutation(internal.spaces.internalUpdate, {
			id: args.spaceId,
			error: "",
		});

		try {
			const { space, githubToken, author, sandbox } =
				await resolveSpaceForGitOp(ctx, args.spaceId);

			const { repository } = space.environment;

			const hasCommits = await pushBranch(
				sandbox,
				space.environment,
				githubToken,
				space.branchName,
				author
			);

			if (!hasCommits) {
				throw new Error("No local changes to push");
			}

			const res = await fetch(
				`https://api.github.com/repos/${repository.owner}/${repository.name}/pulls`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${githubToken}`,
						Accept: "application/vnd.github+json",
					},
					body: JSON.stringify({
						title: space.branchName,
						head: space.branchName,
						base: repository.defaultBranch,
					}),
				}
			);

			if (!res.ok) {
				const body = await res.text();
				throw new Error(`Failed to create PR: ${res.status} ${body}`);
			}

			const pr = (await res.json()) as { html_url: string };

			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				prUrl: pr.html_url,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				error: message,
			});
			throw error;
		}
	},
});

export const pushCode = internalAction({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		await ctx.runMutation(internal.spaces.internalUpdate, {
			id: args.spaceId,
			error: "",
		});

		try {
			const { space, githubToken, author, sandbox } =
				await resolveSpaceForGitOp(ctx, args.spaceId);

			const hasCommits = await pushBranch(
				sandbox,
				space.environment,
				githubToken,
				space.branchName,
				author
			);

			if (!hasCommits) {
				throw new Error("No local changes to push");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				error: message,
			});
			throw error;
		}
	},
});
