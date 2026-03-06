"use node";

import type { FunctionReturnType, GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import { CommandExitError, Sandbox } from "e2b";
import { internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { getAiEnvs, SANDBOX_AGENT_PORT } from "./lib/sandbox";

type Space = Awaited<FunctionReturnType<typeof internal.spaces.internalGet>>;

type ActionCtx = GenericActionCtx<DataModel>;

const SANDBOX_TIMEOUT_MS = 900_000;

const AGENT_HEALTH_URL = `http://localhost:${SANDBOX_AGENT_PORT}/v1/health`;

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

async function provisionSandbox(
	ctx: ActionCtx,
	spaceId: Id<"spaces">,
	snapshotId: string
): Promise<Sandbox> {
	const aiEnvs = getAiEnvs();

	await ctx.runMutation(internal.spaces.internalUpdate, {
		id: spaceId,
		status: "creating" as const,
	});

	const sandbox = await Sandbox.betaCreate(snapshotId, {
		envs: aiEnvs,
		network: { allowPublicTraffic: true },
		autoPause: true,
		timeoutMs: SANDBOX_TIMEOUT_MS,
	});

	return sandbox;
}

async function resolveSandbox(ctx: ActionCtx, space: Space): Promise<Sandbox> {
	if (space.sandboxId) {
		try {
			return await Sandbox.connect(space.sandboxId);
		} catch (error) {
			console.warn("Failed to connect existing sandbox; provisioning new sandbox", {
				spaceId: space._id,
				sandboxId: space.sandboxId,
				error,
			});
			// Fall through to provisioning from snapshot when reconnect fails.
		}
	}

	const externalSnapshotId =
		space.repository.activeSnapshot?.externalSnapshotId;

	if (!externalSnapshotId) {
		throw new Error("Repository snapshot is not ready yet");
	}

	return await provisionSandbox(ctx, space._id, externalSnapshotId);
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

export const ensureSandbox = internalAction({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		try {
			const space = await ctx.runQuery(internal.spaces.internalGet, {
				id: args.spaceId,
			});

			const sandbox = await resolveSandbox(ctx, space);

			const agentUrl = await assertHealthyAndGetUrl(
				sandbox,
				SANDBOX_AGENT_PORT,
				AGENT_HEALTH_URL,
				"sandbox-agent"
			);

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
