"use node";

import { ConvexError, v } from "convex/values";
import { Sandbox } from "e2b";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { runWorkspaceCommand, SANDBOX_WORKDIR } from "./lib/sandbox";

const SANDBOX_TIMEOUT_MS = 900_000;

export const provisionForSpace = internalAction({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const space = await ctx.runQuery(internal.spaces.internalGet, {
			id: args.spaceId,
		});
		if (!space) {
			throw new ConvexError("Space not found");
		}

		const backing = space.activeBackingId
			? await ctx.runQuery(internal.backings.internalGet, {
					id: space.activeBackingId,
				})
			: null;
		if (!backing) {
			throw new ConvexError("Space has no active backing");
		}

		const environment = await ctx.runQuery(internal.environments.internalGet, {
			id: backing.environmentId,
		});
		if (!environment) {
			throw new ConvexError("Environment not found");
		}

		const sandbox = await ctx.runQuery(internal.sandboxes.getBySpace, {
			spaceId: args.spaceId,
		});
		if (!sandbox) {
			throw new ConvexError("Sandbox record not found");
		}

		if (!sandbox.snapshotId) {
			throw new ConvexError("Sandbox has no snapshot");
		}
		const snapshot = await ctx.runQuery(internal.snapshots.internalGet, {
			id: sandbox.snapshotId,
		});
		if (!snapshot?.externalSnapshotId || snapshot.status !== "ready") {
			throw new ConvexError("Snapshot is not ready");
		}

		if (sandbox.externalSandboxId) {
			throw new ConvexError("Sandbox already provisioned — use resume instead");
		}

		try {
			// 1. Create e2b sandbox
			const e2bSandbox = await Sandbox.betaCreate(snapshot.externalSnapshotId, {
				network: { allowPublicTraffic: true },
				autoPause: true,
				timeoutMs: SANDBOX_TIMEOUT_MS,
			});

			await ctx.runMutation(internal.sandboxes.update, {
				id: sandbox._id,
				externalSandboxId: e2bSandbox.sandboxId,
			});

			// 2. Install tendril CLI
			await runWorkspaceCommand(e2bSandbox, "npm install -g tendril", {
				cwd: SANDBOX_WORKDIR,
			});

			// 3. Auth (mock for now)
			await runWorkspaceCommand(e2bSandbox, "tendril auth mock-token", {
				cwd: SANDBOX_WORKDIR,
			});

			// 4. Connect to environment
			await runWorkspaceCommand(
				e2bSandbox,
				`tendril connect ${environment.connectionId}`,
				{ cwd: SANDBOX_WORKDIR }
			);

			// 5. Mark sandbox as running (environment gets marked connected when the CLI actually connects)
			await ctx.runMutation(internal.sandboxes.update, {
				id: sandbox._id,
				status: "running",
			});
		} catch (error) {
			console.error("Sandbox provisioning failed", {
				spaceId: args.spaceId,
				error: error instanceof Error ? error.message : String(error),
			});

			await ctx.runMutation(internal.sandboxes.update, {
				id: sandbox._id,
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			});

			throw error;
		}
	},
});

export const pauseForSpace = internalAction({
	args: { spaceId: v.id("spaces") },
	handler: async (ctx, args) => {
		const sandbox = await ctx.runQuery(internal.sandboxes.getBySpace, {
			spaceId: args.spaceId,
		});
		if (!sandbox?.externalSandboxId) {
			return;
		}

		try {
			await Sandbox.betaPause(sandbox.externalSandboxId);
		} catch (error) {
			console.error("Failed to pause sandbox", error);
		}
	},
});

export const killSandbox = internalAction({
	args: { externalSandboxId: v.string() },
	handler: async (_ctx, args) => {
		try {
			await Sandbox.kill(args.externalSandboxId);
		} catch (error) {
			console.error("Failed to kill sandbox", error);
		}
	},
});
