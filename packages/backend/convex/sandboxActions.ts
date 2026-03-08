"use node";

import type { FunctionReturnType, GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import { CommandExitError, Sandbox } from "e2b";
import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { CODEX_AUTH_SECRET_NAME } from "./lib/codexAuth";
import { runRootCommand, SANDBOX_AGENT_PORT } from "./lib/sandbox";
import { ENV_SECRET_NAMES } from "./lib/validSecrets";

type Space = Awaited<FunctionReturnType<typeof internal.spaces.internalGet>>;

type ActionCtx = GenericActionCtx<DataModel>;

const SANDBOX_TIMEOUT_MS = 900_000;

const AGENT_HEALTH_URL = `http://localhost:${SANDBOX_AGENT_PORT}/v1/health`;

const AGENT_STARTUP_TIMEOUT_MS = 30_000;
const AGENT_POLL_INTERVAL_MS = 500;
const AGENT_LOG_FILE = "/tmp/sandbox-agent.log";

async function bootAgentAndGetUrl(sandbox: Sandbox): Promise<string> {
	// Start agent as a background process
	await sandbox.commands.run(
		`nohup bun /usr/local/bin/sandbox-runtime.js --host 0.0.0.0 --port ${SANDBOX_AGENT_PORT} > ${AGENT_LOG_FILE} 2>&1 &`
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
	aiEnvs: Record<string, string>
): Promise<Sandbox> {
	return await Sandbox.betaCreate(snapshotId, {
		envs: {
			...aiEnvs,
			CODEX_HOME: "/root/.codex",
		},
		network: { allowPublicTraffic: true },
		autoPause: true,
		timeoutMs: SANDBOX_TIMEOUT_MS,
	});
}

async function getUserAiEnvs(
	ctx: ActionCtx,
	userId: string
): Promise<Record<string, string>> {
	const encryptedKeys = await ctx.runQuery(internal.secrets.getByUser, {
		userId,
	});
	const decrypted = await ctx.runAction(
		internal.secretActions.decryptSecretValues,
		{
			userId,
			secrets: encryptedKeys
				.filter((secret) => ENV_SECRET_NAMES.has(secret.name))
				.map((secret) => ({
					name: secret.name,
					encryptedKey: secret.encryptedKey,
					iv: secret.iv,
				})),
		}
	);

	return Object.fromEntries(
		decrypted
			.filter(
				(entry): entry is { name: string; value: string } =>
					typeof entry.name === "string"
			)
			.map((entry) => [entry.name, entry.value])
	);
}

async function getUserCodexAuthJson(
	ctx: ActionCtx,
	userId: string
): Promise<string | null> {
	const secret = await ctx.runQuery(internal.secrets.getByUserAndName, {
		userId,
		name: CODEX_AUTH_SECRET_NAME,
	});

	if (!secret) {
		return null;
	}

	const [decrypted] = await ctx.runAction(
		internal.secretActions.decryptSecretValues,
		{
			userId,
			secrets: [
				{
					name: secret.name,
					encryptedKey: secret.encryptedKey,
					iv: secret.iv,
				},
			],
		}
	);
	return decrypted?.value ?? null;
}

async function syncCodexAuthToAgent(args: {
	sandbox: Sandbox;
	authJson: string | null;
}) {
	await runRootCommand(args.sandbox, "mkdir -p /root/.codex");
	if (args.authJson === null) {
		await runRootCommand(args.sandbox, "rm -f /root/.codex/auth.json");
		return;
	}

	JSON.parse(args.authJson);
	await args.sandbox.files.writeFiles([
		{
			path: "/root/.codex/auth.json",
			data: args.authJson,
		},
	]);
}

async function resolveSandbox(
	ctx: ActionCtx,
	space: Space,
	aiEnvs: Record<string, string>
): Promise<Sandbox> {
	if (space.sandboxId) {
		try {
			return await Sandbox.connect(space.sandboxId);
		} catch (error) {
			console.warn(
				"Failed to connect existing sandbox; provisioning new sandbox",
				{
					spaceId: space._id,
					sandboxId: space.sandboxId,
					error,
				}
			);
			// Fall through to provisioning from snapshot when reconnect fails.
		}
	}

	const externalSnapshotId =
		space.repository.activeSnapshot?.externalSnapshotId;

	if (!externalSnapshotId) {
		throw new Error("Repository snapshot is not ready yet");
	}

	await ctx.runMutation(internal.spaces.internalUpdate, {
		id: space._id,
		status: "creating" as const,
	});

	return await createSandbox(externalSnapshotId, aiEnvs);
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

			const aiEnvs = await getUserAiEnvs(ctx, space.repository.userId);
			const codexAuthJson = await getUserCodexAuthJson(
				ctx,
				space.repository.userId
			);
			const sandbox = await resolveSandbox(ctx, space, aiEnvs);
			const agentUrl = await ensureAgentReadyAndGetUrl(sandbox);
			await syncCodexAuthToAgent({
				sandbox,
				authJson: codexAuthJson,
			});

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

export const provisionForWarmSandbox = internalAction({
	args: {
		warmSandboxId: v.id("warmSandboxes"),
	},
	handler: async (ctx, args) => {
		let sandbox: Sandbox | null = null;

		try {
			const warmRecord = await ctx.runQuery(internal.warmSandbox.internalGet, {
				id: args.warmSandboxId,
			});

			const externalSnapshotId =
				warmRecord.repository.activeSnapshot?.externalSnapshotId;

			if (!externalSnapshotId) {
				throw new Error("Repository snapshot is not ready yet");
			}

			const aiEnvs = await getUserAiEnvs(ctx, warmRecord.repository.userId);
			const codexAuthJson = await getUserCodexAuthJson(
				ctx,
				warmRecord.repository.userId
			);
			sandbox = await createSandbox(externalSnapshotId, aiEnvs);

			const agentUrl = await ensureAgentReadyAndGetUrl(sandbox);
			await syncCodexAuthToAgent({
				sandbox,
				authJson: codexAuthJson,
			});

			const result = await ctx.runMutation(internal.warmSandbox.markReady, {
				id: args.warmSandboxId,
				sandboxId: sandbox.sandboxId,
				agentUrl,
			});

			if (!result.delivered) {
				await Sandbox.kill(sandbox.sandboxId);
			}
		} catch (error) {
			if (sandbox) {
				try {
					await Sandbox.kill(sandbox.sandboxId);
				} catch {
					// Best-effort cleanup
				}
			}

			try {
				await ctx.runMutation(internal.warmSandbox.cleanup, {
					id: args.warmSandboxId,
				});
			} catch {
				// Warm record may already be gone
			}

			console.error("Failed to provision warm sandbox", error);
		}
	},
});
