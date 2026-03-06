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
import {
	CODE_SERVER_PORT,
	getAiEnvs,
	getSandboxWorkdir,
	pushBranch,
	SANDBOX_AGENT_PORT,
} from "./lib/sandbox";

type Space = Awaited<FunctionReturnType<typeof internal.spaces.internalGet>>;
type WarmSandbox = Awaited<
	FunctionReturnType<typeof internal.warmSandboxes.internalGet>
>;

type ActionCtx = GenericActionCtx<DataModel>;

// Keep in sync with SANDBOX_TIMEOUT_MS in apps/server/src/space/sandbox-keepalive.ts
const SANDBOX_TIMEOUT_MS = 900_000;

const AGENT_HEALTH_URL = `http://localhost:${SANDBOX_AGENT_PORT}/v1/health`;
const CODE_SERVER_HEALTH_URL = `http://localhost:${CODE_SERVER_PORT}`;

async function assertHealthyAndGetUrl(
	sandbox: Sandbox,
	port: number,
	healthUrl: string,
	name: string
): Promise<string> {
	try {
		await sandbox.commands.run(`curl -sf --max-time 2 ${healthUrl}`);
	} catch (error) {
		if (error instanceof CommandExitError) {
			throw new Error(`${name} is not healthy`);
		}
		throw error;
	}
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

	await sandbox.commands.run(
		`git checkout ${safeBranchName} 2>/dev/null || git checkout -b ${safeBranchName} ${safeDefaultBranch}`,
		{
			cwd: workdir,
			user: "root",
		}
	);
}

async function createSandbox(snapshotId: string): Promise<{
	sandbox: Sandbox;
	sandboxExpiresAt: number;
}> {
	const aiEnvs = getAiEnvs();
	const sandbox = await Sandbox.betaCreate(snapshotId, {
		envs: aiEnvs,
		network: { allowPublicTraffic: true },
		autoPause: true,
		timeoutMs: SANDBOX_TIMEOUT_MS,
	});

	return {
		sandbox,
		sandboxExpiresAt: Date.now() + SANDBOX_TIMEOUT_MS,
	};
}

async function getSandboxUrls(sandbox: Sandbox): Promise<{
	agentUrl: string;
	editorUrl: string;
}> {
	const agentUrl = await assertHealthyAndGetUrl(
		sandbox,
		SANDBOX_AGENT_PORT,
		AGENT_HEALTH_URL,
		"sandbox-agent"
	);

	const editorUrl = await assertHealthyAndGetUrl(
		sandbox,
		CODE_SERVER_PORT,
		CODE_SERVER_HEALTH_URL,
		"code-server"
	);

	return { agentUrl, editorUrl };
}

async function resolveSpaceSandbox(space: Space): Promise<{
	sandbox: Sandbox;
	sandboxExpiresAt: number | undefined;
}> {
	const externalSnapshotId =
		space.environment.activeSnapshot?.externalSnapshotId;

	if (!externalSnapshotId) {
		throw new Error("Environment snapshot is not ready yet");
	}

	if (!space.sandboxId) {
		return await createSandbox(externalSnapshotId);
	}

	try {
		return {
			sandbox: await Sandbox.connect(space.sandboxId),
			sandboxExpiresAt: space.sandboxExpiresAt,
		};
	} catch {
		return await createSandbox(externalSnapshotId);
	}
}

async function resolveWarmSandbox(warmSandbox: WarmSandbox): Promise<{
	sandbox: Sandbox;
	sandboxExpiresAt: number;
}> {
	const externalSnapshotId = warmSandbox.snapshot.externalSnapshotId;
	if (!(warmSandbox.snapshot.status === "ready" && externalSnapshotId)) {
		throw new Error("Snapshot is not ready for warming");
	}

	if (!warmSandbox.sandboxId) {
		return await createSandbox(externalSnapshotId);
	}

	try {
		return {
			sandbox: await Sandbox.connect(warmSandbox.sandboxId),
			sandboxExpiresAt: warmSandbox.expiresAt,
		};
	} catch {
		return await createSandbox(externalSnapshotId);
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

			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "creating",
			});

			const { sandbox, sandboxExpiresAt } = await resolveSpaceSandbox(space);

			const { repository } = space.environment;
			const workdir = getSandboxWorkdir(repository);
			await ensureBranchCheckedOut(
				sandbox,
				workdir,
				space.branchName,
				repository.defaultBranch
			);

			const { agentUrl, editorUrl } = await getSandboxUrls(sandbox);

			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "running",
				sandboxId: sandbox.sandboxId,
				agentUrl,
				editorUrl,
				sandboxExpiresAt,
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

export const ensureWarmSandbox = internalAction({
	args: {
		warmSandboxId: v.id("warmSandboxes"),
	},
	handler: async (ctx, args) => {
		try {
			const warmSandbox = await ctx.runQuery(
				internal.warmSandboxes.internalGet,
				{
					id: args.warmSandboxId,
				}
			);

			if (
				warmSandbox.status === "claimed" ||
				warmSandbox.status === "expired"
			) {
				return;
			}

			await ctx.runMutation(internal.warmSandboxes.internalUpdate, {
				id: args.warmSandboxId,
				status: "warming",
				error: "",
			});

			const { sandbox, sandboxExpiresAt } =
				await resolveWarmSandbox(warmSandbox);
			const { agentUrl, editorUrl } = await getSandboxUrls(sandbox);

			await ctx.runMutation(internal.warmSandboxes.internalUpdate, {
				id: args.warmSandboxId,
				status: "ready",
				sandboxId: sandbox.sandboxId,
				agentUrl,
				editorUrl,
				expiresAt: sandboxExpiresAt,
				error: "",
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			await ctx.runMutation(internal.warmSandboxes.internalUpdate, {
				id: args.warmSandboxId,
				status: "error",
				error: message,
			});
			throw error;
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
			const workdir = getSandboxWorkdir(repository);
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
