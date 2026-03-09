"use node";

import type { FunctionReturnType, GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import { CommandExitError, Sandbox } from "e2b";
import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import {
	runWorkspaceCommand,
	SANDBOX_AGENT_PORT,
	SANDBOX_WORKDIR,
} from "./lib/sandbox";

type Space = Awaited<FunctionReturnType<typeof internal.spaces.internalGet>>;

type ActionCtx = GenericActionCtx<DataModel>;

const SANDBOX_TIMEOUT_MS = 900_000;

const AGENT_HEALTH_URL = `http://localhost:${SANDBOX_AGENT_PORT}/v1/health`;

const AGENT_STARTUP_TIMEOUT_MS = 30_000;
const AGENT_POLL_INTERVAL_MS = 500;
const AGENT_LOG_FILE = "/tmp/sandbox-agent.log";

async function bootAgentAndGetUrl(sandbox: Sandbox): Promise<string> {
	// Start agent as a background process
	await runWorkspaceCommand(
		sandbox,
		`nohup bun /usr/local/bin/sandbox-runtime.js --host 0.0.0.0 --port ${SANDBOX_AGENT_PORT} > ${AGENT_LOG_FILE} 2>&1 &`,
		{ cwd: SANDBOX_WORKDIR }
	);

	// Poll until healthy
	const deadline = Date.now() + AGENT_STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			await sandbox.commands.run(`curl -sf --max-time 2 ${AGENT_HEALTH_URL}`);
			return `https://${sandbox.getHost(SANDBOX_AGENT_PORT)}`;
		} catch {
			// Not ready yet
		}
		await new Promise((resolve) => setTimeout(resolve, AGENT_POLL_INTERVAL_MS));
	}

	// Timed out — capture logs for debugging
	try {
		const logs = await sandbox.commands.run(`cat ${AGENT_LOG_FILE}`);
		console.error("sandbox-agent boot logs:", logs.stdout);
	} catch {
		// Best effort
	}
	throw new Error("sandbox-agent did not become ready in time");
}

async function ensureAgentReadyAndGetUrl(sandbox: Sandbox): Promise<string> {
	try {
		await sandbox.commands.run(`curl -sf --max-time 2 ${AGENT_HEALTH_URL}`);
	} catch (error) {
		if (error instanceof CommandExitError) {
			return await bootAgentAndGetUrl(sandbox);
		}
		throw error;
	}
	return `https://${sandbox.getHost(SANDBOX_AGENT_PORT)}`;
}

async function createSandbox(
	snapshotId: string,
	projectEnvs: Record<string, string>
): Promise<Sandbox> {
	return await Sandbox.betaCreate(snapshotId, {
		envs: projectEnvs,
		network: { allowPublicTraffic: true },
		autoPause: true,
		timeoutMs: SANDBOX_TIMEOUT_MS,
	});
}

async function resolveSandbox(
	ctx: ActionCtx,
	space: Space,
	projectEnvs: Record<string, string>
): Promise<Sandbox> {
	if (space.sandboxId) {
		try {
			return await Sandbox.connect(space.sandboxId);
		} catch (error) {
			console.warn("Failed to connect existing sandbox", {
				spaceId: space._id,
				sandboxId: space.sandboxId,
				error,
			});
			throw error;
		}
	}

	if (!space.snapshotId) {
		throw new Error("Space snapshot is not set");
	}
	const snapshot = await ctx.runQuery(internal.snapshot.internalGet, {
		id: space.snapshotId,
	});
	if (snapshot.status !== "ready" || !snapshot.externalSnapshotId) {
		throw new Error("Space snapshot is not ready");
	}

	await ctx.runMutation(internal.spaces.internalUpdate, {
		id: space._id,
		status: "creating" as const,
	});

	return await createSandbox(snapshot.externalSnapshotId, projectEnvs);
}

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

export const provisionForSpace = internalAction({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		try {
			const space = await ctx.runQuery(internal.spaces.internalGet, {
				id: args.spaceId,
			});

			const sandbox = await resolveSandbox(
				ctx,
				space,
				space.project.secrets ?? {}
			);
			const agentUrl = await ensureAgentReadyAndGetUrl(sandbox);

			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "running",
				sandboxId: sandbox.sandboxId,
				agentUrl,
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
