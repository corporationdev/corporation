"use node";

import type { FunctionReturnType, GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import { CommandExitError, Sandbox } from "e2b";
import { internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { normalizeBranchName, quoteShellArg } from "./lib/git";
import {
	getAiEnvs,
	getSandboxWorkdir,
	SANDBOX_AGENT_PORT,
} from "./lib/sandbox";

type Space = Awaited<FunctionReturnType<typeof internal.spaces.internalGet>>;

type ActionCtx = GenericActionCtx<DataModel>;

// Keep in sync with SANDBOX_TIMEOUT_MS in apps/server/src/space/sandbox-keepalive.ts
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

	await ctx.runMutation(internal.spaces.internalUpdate, {
		id: spaceId,
		sandboxExpiresAt: Date.now() + SANDBOX_TIMEOUT_MS,
	});

	return sandbox;
}

async function resolveSandbox(ctx: ActionCtx, space: Space): Promise<Sandbox> {
	const externalSnapshotId =
		space.repository.activeSnapshot?.externalSnapshotId;

	if (!externalSnapshotId) {
		throw new Error("Repository snapshot is not ready yet");
	}

	if (!space.sandboxId) {
		return await provisionSandbox(ctx, space._id, externalSnapshotId);
	}

	try {
		await ctx.runMutation(internal.spaces.internalUpdate, {
			id: space._id,
			status: "creating" as const,
		});

		return await Sandbox.connect(space.sandboxId);
	} catch {
		return await provisionSandbox(ctx, space._id, externalSnapshotId);
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

			const sandbox = await resolveSandbox(ctx, space);

			const repository = space.repository;
			const workdir = getSandboxWorkdir(repository);
			await ensureBranchCheckedOut(
				sandbox,
				workdir,
				space.branchName,
				repository.defaultBranch
			);

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
			const repository = space.repository;
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
