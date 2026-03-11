"use node";

import type { FunctionReturnType, GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import { CommandExitError, Sandbox } from "e2b";
import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import {
	BASE_TEMPLATE,
	bootServer,
	runWorkspaceCommand,
	SANDBOX_AGENT_PORT,
	SANDBOX_AGENT_SESSION_NAME,
	SANDBOX_WORKDIR,
} from "./lib/sandbox";

type Space = Awaited<FunctionReturnType<typeof internal.spaces.internalGet>>;

type ActionCtx = GenericActionCtx<DataModel>;

const SANDBOX_TIMEOUT_MS = 900_000;

const AGENT_HEALTH_URL = `http://localhost:${SANDBOX_AGENT_PORT}/health`;

const AGENT_LOG_FILE = "/tmp/sandbox-agent.log";
const AGENT_STDERR_LOG_FILE = "/tmp/sandbox-agent.stderr.log";

function quoteShellEnv(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function bootAgentAndGetUrl(
	sandbox: Sandbox,
	spaceOwnerId: string
): Promise<string> {
	const convexSiteUrl = process.env.CORPORATION_CONVEX_SITE_URL;
	const serverUrl = process.env.CORPORATION_SERVER_URL;
	if (!(convexSiteUrl && serverUrl)) {
		throw new Error(
			"Missing CORPORATION_CONVEX_SITE_URL or CORPORATION_SERVER_URL env var"
		);
	}

	await runWorkspaceCommand(
		sandbox,
		`tmux kill-session -t ${SANDBOX_AGENT_SESSION_NAME} || true`,
		{ cwd: SANDBOX_WORKDIR }
	);
	await runWorkspaceCommand(
		sandbox,
		`fuser -k ${SANDBOX_AGENT_PORT}/tcp || true`,
		{
			cwd: SANDBOX_WORKDIR,
		}
	);
	await runWorkspaceCommand(
		sandbox,
		`: > ${AGENT_LOG_FILE}; : > ${AGENT_STDERR_LOG_FILE}`,
		{ cwd: SANDBOX_WORKDIR }
	);

	try {
		await bootServer(sandbox, {
			sessionName: SANDBOX_AGENT_SESSION_NAME,
			command: `CORPORATION_SERVER_URL=${quoteShellEnv(serverUrl)} CORPORATION_CONVEX_SITE_URL=${quoteShellEnv(convexSiteUrl)} CORPORATION_SANDBOX_OWNER_ID=${quoteShellEnv(spaceOwnerId)} bun /usr/local/bin/sandbox-runtime.js --host 0.0.0.0 --port ${SANDBOX_AGENT_PORT} >> ${AGENT_LOG_FILE} 2>> ${AGENT_STDERR_LOG_FILE}`,
			healthUrl: AGENT_HEALTH_URL,
			workdir: SANDBOX_WORKDIR,
		});
		return `https://${sandbox.getHost(SANDBOX_AGENT_PORT)}`;
	} catch (error) {
		console.error("sandbox-agent failed to boot", error);
		throw error;
	}
}

async function ensureAgentReadyAndGetUrl(
	sandbox: Sandbox,
	spaceOwnerId: string
): Promise<string> {
	try {
		await sandbox.commands.run(`curl -sf --max-time 2 ${AGENT_HEALTH_URL}`);
	} catch (error) {
		if (error instanceof CommandExitError) {
			return await bootAgentAndGetUrl(sandbox, spaceOwnerId);
		}
		throw error;
	}
	return `https://${sandbox.getHost(SANDBOX_AGENT_PORT)}`;
}

async function createSandbox(
	snapshotId: string,
	projectEnvs: Record<string, string>,
	spaceOwnerId: string
): Promise<Sandbox> {
	const convexSiteUrl = process.env.CORPORATION_CONVEX_SITE_URL;
	const serverUrl = process.env.CORPORATION_SERVER_URL;
	if (!(convexSiteUrl && serverUrl)) {
		throw new Error(
			"Missing CORPORATION_CONVEX_SITE_URL or CORPORATION_SERVER_URL env var"
		);
	}

	return await Sandbox.betaCreate(snapshotId, {
		envs: {
			...projectEnvs,
			CORPORATION_CONVEX_SITE_URL: convexSiteUrl,
			CORPORATION_SANDBOX_OWNER_ID: spaceOwnerId,
			CORPORATION_SERVER_URL: serverUrl,
		},
		network: { allowPublicTraffic: true },
		autoPause: true,
		timeoutMs: SANDBOX_TIMEOUT_MS,
	});
}

async function resolveSandbox(
	ctx: ActionCtx,
	space: Space,
	spaceOwnerId: string,
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
			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: space._id,
				status: "creating",
				sandboxId: null,
				agentUrl: null,
				error: null,
			});
		}
	}

	const sourceSnapshotId =
		space.bootstrapSource === "base-template"
			? BASE_TEMPLATE
			: await (async () => {
					if (!space.snapshotId) {
						throw new Error("Space snapshot is not set");
					}
					const snapshot = await ctx.runQuery(internal.snapshot.internalGet, {
						id: space.snapshotId,
					});
					if (snapshot.status !== "ready" || !snapshot.externalSnapshotId) {
						throw new Error("Space snapshot is not ready");
					}
					return snapshot.externalSnapshotId;
				})();

	await ctx.runMutation(internal.spaces.internalUpdate, {
		id: space._id,
		status: "creating" as const,
	});

	return await createSandbox(sourceSnapshotId, projectEnvs, spaceOwnerId);
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

export const pauseForSpace = internalAction({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.runQuery(internal.spaces.internalGet, {
			id: args.spaceId,
		});

		if (!space.sandboxId) {
			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "killed",
			});
			return;
		}

		try {
			await Sandbox.betaPause(space.sandboxId);
		} catch (error) {
			console.error("Failed to pause sandbox in E2B", {
				spaceId: args.spaceId,
				sandboxId: space.sandboxId,
				error,
			});
			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "running",
			});
			throw error;
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
			if (!space.userId) {
				throw new Error("Space owner is not set");
			}
			const spaceOwnerId = space.userId;
			const projectEnvs = await ctx.runAction(
				internal.secretActions.resolveProjectSecrets,
				{
					projectId: space.project._id,
				}
			);

			const sandbox = await resolveSandbox(
				ctx,
				space,
				spaceOwnerId,
				projectEnvs
			);
			const agentUrl = await ensureAgentReadyAndGetUrl(sandbox, spaceOwnerId);

			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "running",
				sandboxId: sandbox.sandboxId,
				agentUrl,
				error: null,
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
