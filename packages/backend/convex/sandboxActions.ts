"use node";

import { Nango } from "@nangohq/node";
import type { FunctionReturnType, GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import { CommandExitError, Sandbox } from "e2b";
import { internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { getGitHubToken } from "./lib/nango";

type Space = Awaited<FunctionReturnType<typeof internal.spaces.internalGet>>;

type ActionCtx = GenericActionCtx<DataModel>;

const SANDBOX_AGENT_PORT = 5799;
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;
const REPO_SYNC_TIMEOUT_MS = 15 * 60 * 1000;
const NEEDS_QUOTING_RE = /[\s"'#]/;
const LOCALHOST_PORT_RE = /http:\/\/localhost:(\d+)/g;
const TRAILING_SLASH_RE = /\/$/;

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

function formatEnvContent(
	envVars: Array<{ key: string; value: string }>
): string {
	return envVars
		.map(({ key, value }) => {
			if (NEEDS_QUOTING_RE.test(value)) {
				return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
			}
			return `${key}=${value}`;
		})
		.join("\n");
}

function resolvePreviewUrls(
	sandbox: Sandbox,
	envVars: Array<{ key: string; value: string }>
): Array<{ key: string; value: string }> {
	const ports = new Set<number>();
	for (const { value } of envVars) {
		for (const match of value.matchAll(LOCALHOST_PORT_RE)) {
			ports.add(Number.parseInt(match[1], 10));
		}
	}

	if (ports.size === 0) {
		return envVars;
	}

	const portToUrl = new Map<number, string>();
	for (const port of ports) {
		const url = getPreviewUrl(sandbox, port);
		portToUrl.set(port, url.replace(TRAILING_SLASH_RE, ""));
	}

	return envVars.map(({ key, value }) => ({
		key,
		value: value.replace(LOCALHOST_PORT_RE, (_match, portStr) => {
			const port = Number.parseInt(portStr, 10);
			return portToUrl.get(port) ?? _match;
		}),
	}));
}

async function writeEnvFiles(
	sandbox: Sandbox,
	environment: Space["environment"],
	workdir: string
): Promise<void> {
	const files: Array<{ path: string; data: string }> = [];

	const repoEnvVars = environment.repository.envVars;
	if (repoEnvVars && repoEnvVars.length > 0) {
		const resolved = resolvePreviewUrls(sandbox, repoEnvVars);
		files.push({
			path: `${workdir}/.env`,
			data: formatEnvContent(resolved),
		});
	}

	for (const service of environment.services) {
		if (service.envVars && service.envVars.length > 0) {
			const resolved = resolvePreviewUrls(sandbox, service.envVars);
			const dir = service.path || ".";
			files.push({
				path: `${workdir}/${dir}/.env`,
				data: formatEnvContent(resolved),
			});
		}
	}

	if (files.length === 0) {
		return;
	}

	await sandbox.files.writeFiles(files);
}

async function syncRepositoryOnSandbox(
	sandbox: Sandbox,
	environment: Space["environment"],
	githubToken: string
): Promise<string | undefined> {
	const { repository } = environment;
	const workdir = `/root/${repository.owner}-${repository.name}`;

	await writeEnvFiles(sandbox, environment, workdir);

	await sandbox.commands.run(
		`git remote set-url origin https://x-access-token:${githubToken}@github.com/${repository.owner}/${repository.name}.git && git pull origin ${repository.defaultBranch}`,
		{ cwd: workdir, user: "root", timeoutMs: REPO_SYNC_TIMEOUT_MS }
	);

	await sandbox.commands.run(repository.setupCommand, {
		cwd: workdir,
		user: "root",
		timeoutMs: REPO_SYNC_TIMEOUT_MS,
	});

	const shaResult = await sandbox.commands.run("git rev-parse HEAD", {
		cwd: workdir,
		user: "root",
	});
	return shaResult.stdout.trim();
}

async function provisionSandbox(
	ctx: ActionCtx,
	e2bApiKey: string,
	spaceId: Id<"spaces">,
	snapshotId: string,
	environment: Space["environment"]
): Promise<{
	sandboxId: string;
	sandboxUrl: string;
	lastSyncedCommitSha?: string;
}> {
	const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
	if (!anthropicApiKey) {
		throw new Error("Missing ANTHROPIC_API_KEY env var");
	}
	const sandboxEnvs = { ANTHROPIC_API_KEY: anthropicApiKey };

	await ctx.runMutation(internal.spaces.internalUpdate, {
		id: spaceId,
		status: "creating" as const,
	});

	const sandbox = await Sandbox.create(snapshotId, {
		apiKey: e2bApiKey,
		envs: sandboxEnvs,
		allowInternetAccess: true,
		network: { allowPublicTraffic: true },
	});

	await bootSandboxAgent(sandbox);

	const nangoSecretKey = process.env.NANGO_SECRET_KEY;
	if (!nangoSecretKey) {
		throw new Error("Missing NANGO_SECRET_KEY env var");
	}
	const nango = new Nango({ secretKey: nangoSecretKey });
	const githubToken = await getGitHubToken(nango, environment.userId);
	const lastSyncedCommitSha = await syncRepositoryOnSandbox(
		sandbox,
		environment,
		githubToken
	);

	const sandboxUrl = getPreviewUrl(sandbox, SANDBOX_AGENT_PORT);
	return { sandboxId: sandbox.sandboxId, sandboxUrl, lastSyncedCommitSha };
}

async function resolveSandbox(
	ctx: ActionCtx,
	e2bApiKey: string,
	space: Space
): Promise<{
	sandboxId: string;
	sandboxUrl?: string;
	lastSyncedCommitSha?: string;
}> {
	const { snapshotId } = space.environment;

	if (!snapshotId) {
		throw new Error("Environment snapshot is not ready yet");
	}

	if (!space.sandboxId) {
		return await provisionSandbox(
			ctx,
			e2bApiKey,
			space._id,
			snapshotId,
			space.environment
		);
	}

	try {
		await ctx.runMutation(internal.spaces.internalUpdate, {
			id: space._id,
			status: "creating" as const,
		});

		const sandbox = await Sandbox.connect(space.sandboxId, {
			apiKey: e2bApiKey,
		});
		await ensureSandboxAgentRunning(sandbox);

		return {
			sandboxId: sandbox.sandboxId,
			sandboxUrl: getPreviewUrl(sandbox, SANDBOX_AGENT_PORT),
		};
	} catch {
		return await provisionSandbox(
			ctx,
			e2bApiKey,
			space._id,
			snapshotId,
			space.environment
		);
	}
}

export const stopSandbox = internalAction({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const e2bApiKey = process.env.E2B_API_KEY;
		if (!e2bApiKey) {
			throw new Error("Missing E2B_API_KEY env var");
		}

		try {
			const space = await ctx.runQuery(internal.spaces.internalGet, {
				id: args.spaceId,
			});

			if (!space.sandboxId) {
				throw new Error("Space has no sandbox to stop");
			}

			await Sandbox.betaPause(space.sandboxId, { apiKey: e2bApiKey });

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
		const e2bApiKey = process.env.E2B_API_KEY;
		if (!e2bApiKey) {
			throw new Error("Missing E2B_API_KEY env var");
		}

		try {
			await Sandbox.betaPause(args.sandboxId, { apiKey: e2bApiKey });
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
		const e2bApiKey = process.env.E2B_API_KEY;
		if (!e2bApiKey) {
			throw new Error("Missing E2B_API_KEY env var");
		}

		try {
			await Sandbox.kill(args.sandboxId, { apiKey: e2bApiKey });
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
		const e2bApiKey = process.env.E2B_API_KEY;
		if (!e2bApiKey) {
			throw new Error("Missing E2B_API_KEY env var");
		}

		try {
			const space = await ctx.runQuery(internal.spaces.internalGet, {
				id: args.spaceId,
			});

			const { sandboxId, sandboxUrl, lastSyncedCommitSha } =
				await resolveSandbox(ctx, e2bApiKey, space);

			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "running",
				sandboxId,
				sandboxUrl,
				lastSyncedCommitSha,
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
		const e2bApiKey = process.env.E2B_API_KEY;
		const nangoSecretKey = process.env.NANGO_SECRET_KEY;
		if (!(e2bApiKey && nangoSecretKey)) {
			throw new Error("Missing E2B_API_KEY or NANGO_SECRET_KEY env vars");
		}

		const space = await ctx.runQuery(internal.spaces.internalGet, {
			id: args.spaceId,
		});

		if (!space.sandboxId) {
			throw new Error("Space has no sandbox to sync");
		}

		const nango = new Nango({ secretKey: nangoSecretKey });
		const githubToken = await getGitHubToken(nango, space.environment.userId);

		const sandbox = await Sandbox.connect(space.sandboxId, {
			apiKey: e2bApiKey,
		});

		const lastSyncedCommitSha = await syncRepositoryOnSandbox(
			sandbox,
			space.environment,
			githubToken
		);

		if (lastSyncedCommitSha) {
			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				lastSyncedCommitSha,
			});
		}
	},
});
