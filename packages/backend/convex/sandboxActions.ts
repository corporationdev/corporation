"use node";

import type { Sandbox } from "@daytonaio/sdk";
import { Daytona } from "@daytonaio/sdk";
import { Nango } from "@nangohq/node";
import type { FunctionReturnType, GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { getGitHubToken } from "./lib/nango";

type Space = Awaited<FunctionReturnType<typeof internal.spaces.internalGet>>;

type ActionCtx = GenericActionCtx<DataModel>;

const SANDBOX_AGENT_PORT = 5799;
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;
const PREVIEW_URL_EXPIRY_SECONDS = 86_400;
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
			const result = await sandbox.process.executeCommand(
				`curl -sf http://localhost:${SANDBOX_AGENT_PORT}/v1/health`
			);
			if (result.exitCode === 0) {
				return;
			}
		} catch {
			// Server not ready yet
		}
		await sleep(SERVER_POLL_INTERVAL_MS);
	}

	throw new Error("sandbox-agent server failed to start within timeout");
}

async function bootSandboxAgent(sandbox: Sandbox): Promise<void> {
	await sandbox.process.executeCommand(
		`nohup sandbox-agent server --no-token --host 0.0.0.0 --port ${SANDBOX_AGENT_PORT} >/tmp/sandbox-agent.log 2>&1 &`
	);
	await waitForServerReady(sandbox);
}

async function isSandboxAgentHealthy(sandbox: Sandbox): Promise<boolean> {
	try {
		const result = await sandbox.process.executeCommand(
			`curl -sf --max-time 1 http://localhost:${SANDBOX_AGENT_PORT}/v1/health`
		);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

async function ensureSandboxAgentRunning(sandbox: Sandbox): Promise<void> {
	const healthy = await isSandboxAgentHealthy(sandbox);
	if (!healthy) {
		await bootSandboxAgent(sandbox);
	}
}

async function getPreviewUrl(sandbox: Sandbox): Promise<string> {
	const result = await sandbox.getSignedPreviewUrl(
		SANDBOX_AGENT_PORT,
		PREVIEW_URL_EXPIRY_SECONDS
	);
	return result.url;
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

async function resolvePreviewUrls(
	sandbox: Sandbox,
	envVars: Array<{ key: string; value: string }>
): Promise<Array<{ key: string; value: string }>> {
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
		const result = await sandbox.getSignedPreviewUrl(
			port,
			PREVIEW_URL_EXPIRY_SECONDS
		);
		portToUrl.set(port, result.url.replace(TRAILING_SLASH_RE, ""));
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
	environment: Space["environment"]
): Promise<void> {
	const files: Array<{ source: Buffer; destination: string }> = [];

	// Root .env from repository-level env vars
	const repoEnvVars = environment.repository.envVars;
	if (repoEnvVars && repoEnvVars.length > 0) {
		const resolved = await resolvePreviewUrls(sandbox, repoEnvVars);
		files.push({
			source: Buffer.from(formatEnvContent(resolved)),
			destination: "./.env",
		});
	}

	// Service-level .env files at their respective paths
	for (const service of environment.services) {
		if (service.envVars && service.envVars.length > 0) {
			const resolved = await resolvePreviewUrls(sandbox, service.envVars);
			const dir = service.path || ".";
			files.push({
				source: Buffer.from(formatEnvContent(resolved)),
				destination: `${dir}/.env`,
			});
		}
	}

	if (files.length === 0) {
		return;
	}

	await sandbox.fs.uploadFiles(files);
}

async function syncRepositoryOnSandbox(
	sandbox: Sandbox,
	environment: Space["environment"],
	githubToken: string
): Promise<string | undefined> {
	await writeEnvFiles(sandbox, environment);

	const { repository } = environment;
	const workdir = `/root/${repository.owner}-${repository.name}`;
	await sandbox.process.executeCommand(
		`cd ${workdir} && git remote set-url origin https://x-access-token:${githubToken}@github.com/${repository.owner}/${repository.name}.git && git pull origin ${repository.defaultBranch}`
	);
	await sandbox.process.executeCommand(
		`cd ${workdir} && ${repository.setupCommand}`
	);

	// Read the HEAD commit SHA after pull
	const shaResult = await sandbox.process.executeCommand(
		`cd ${workdir} && git rev-parse HEAD`
	);
	return shaResult.exitCode === 0 ? shaResult.result.trim() : undefined;
}

async function provisionSandbox(
	ctx: ActionCtx,
	daytona: Daytona,
	spaceId: Id<"spaces">,
	snapshotName: string,
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
	await ctx.runMutation(internal.spaces.internalUpdate, {
		id: spaceId,
		status: "creating" as const,
	});
	const sandbox = await daytona.create({
		snapshot: snapshotName,
		envVars: { ANTHROPIC_API_KEY: anthropicApiKey },
	});
	await bootSandboxAgent(sandbox);

	// Sync code to latest after creating from snapshot
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

	const sandboxUrl = await getPreviewUrl(sandbox);
	return { sandboxId: sandbox.id, sandboxUrl, lastSyncedCommitSha };
}

async function resolveSandbox(
	ctx: ActionCtx,
	daytona: Daytona,
	space: Space
): Promise<{
	sandboxId: string;
	sandboxUrl?: string;
	lastSyncedCommitSha?: string;
}> {
	const { snapshotName } = space.environment;

	if (!snapshotName) {
		throw new Error("Environment snapshot is not ready yet");
	}

	if (!space.sandboxId) {
		return await provisionSandbox(
			ctx,
			daytona,
			space._id,
			snapshotName,
			space.environment
		);
	}

	let sandbox: Sandbox;
	try {
		sandbox = await daytona.get(space.sandboxId);
	} catch {
		return await provisionSandbox(
			ctx,
			daytona,
			space._id,
			snapshotName,
			space.environment
		);
	}

	const { state } = sandbox;

	if (state === "started") {
		await ensureSandboxAgentRunning(sandbox);
		return { sandboxId: sandbox.id };
	}

	if (state === "stopped" || state === "archived") {
		await ctx.runMutation(internal.spaces.internalUpdate, {
			id: space._id,
			status: "starting" as const,
		});
		await sandbox.start();
		await bootSandboxAgent(sandbox);
		return { sandboxId: sandbox.id };
	}

	return await provisionSandbox(
		ctx,
		daytona,
		space._id,
		snapshotName,
		space.environment
	);
}

export const stopSandbox = internalAction({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const daytonaApiKey = process.env.DAYTONA_API_KEY;
		if (!daytonaApiKey) {
			throw new Error("Missing DAYTONA_API_KEY env var");
		}

		const daytona = new Daytona({ apiKey: daytonaApiKey });

		try {
			const space = await ctx.runQuery(internal.spaces.internalGet, {
				id: args.spaceId,
			});

			if (!space.sandboxId) {
				throw new Error("Space has no sandbox to stop");
			}

			const sandbox = await daytona.get(space.sandboxId);
			if (sandbox.state === "started") {
				await sandbox.stop();
			}

			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "stopped",
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
		const daytonaApiKey = process.env.DAYTONA_API_KEY;
		if (!daytonaApiKey) {
			throw new Error("Missing DAYTONA_API_KEY env var");
		}

		const daytona = new Daytona({ apiKey: daytonaApiKey });

		try {
			const sandbox = await daytona.get(args.sandboxId);
			if (sandbox.state === "started") {
				await sandbox.stop();
			}
			if (sandbox.state !== "archived") {
				await sandbox.archive();
			}
		} catch (error) {
			console.error("Failed to archive sandbox in Daytona", error);
		}
	},
});

export const deleteSandbox = internalAction({
	args: {
		sandboxId: v.string(),
	},
	handler: async (_ctx, args) => {
		const daytonaApiKey = process.env.DAYTONA_API_KEY;
		if (!daytonaApiKey) {
			throw new Error("Missing DAYTONA_API_KEY env var");
		}

		const daytona = new Daytona({ apiKey: daytonaApiKey });

		try {
			const sandbox = await daytona.get(args.sandboxId);
			await sandbox.delete();
		} catch (error) {
			console.error("Failed to delete sandbox in Daytona", error);
		}
	},
});

export const ensureSandbox = internalAction({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const daytonaApiKey = process.env.DAYTONA_API_KEY;
		if (!daytonaApiKey) {
			throw new Error("Missing DAYTONA_API_KEY env var");
		}

		const daytona = new Daytona({ apiKey: daytonaApiKey });

		try {
			const space = await ctx.runQuery(internal.spaces.internalGet, {
				id: args.spaceId,
			});

			const { sandboxId, sandboxUrl, lastSyncedCommitSha } =
				await resolveSandbox(ctx, daytona, space);

			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "started",
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
		const daytonaApiKey = process.env.DAYTONA_API_KEY;
		const nangoSecretKey = process.env.NANGO_SECRET_KEY;
		if (!(daytonaApiKey && nangoSecretKey)) {
			throw new Error("Missing DAYTONA_API_KEY or NANGO_SECRET_KEY env vars");
		}

		const space = await ctx.runQuery(internal.spaces.internalGet, {
			id: args.spaceId,
		});

		if (!space.sandboxId) {
			throw new Error("Space has no sandbox to sync");
		}

		const nango = new Nango({ secretKey: nangoSecretKey });
		const githubToken = await getGitHubToken(nango, space.environment.userId);

		const daytona = new Daytona({ apiKey: daytonaApiKey });
		const sandbox = await daytona.get(space.sandboxId);

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
