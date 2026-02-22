"use node";

import type { Sandbox } from "@daytonaio/sdk";
import { Daytona } from "@daytonaio/sdk";
import type { FunctionReturnType, GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";

type Space = Awaited<FunctionReturnType<typeof internal.spaces.internalGet>>;

type ActionCtx = GenericActionCtx<DataModel>;

const SANDBOX_AGENT_PORT = 5799;
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;
const PREVIEW_URL_EXPIRY_SECONDS = 86_400;
const NEEDS_QUOTING_RE = /[\s"'#]/;

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

async function getPreviewUrl(sandbox: Sandbox): Promise<string> {
	const result = await sandbox.getSignedPreviewUrl(
		SANDBOX_AGENT_PORT,
		PREVIEW_URL_EXPIRY_SECONDS
	);
	return result.url;
}

async function writeServiceEnvFiles(
	sandbox: Sandbox,
	services: Array<{
		cwd: string;
		envVars?: Array<{ key: string; value: string }>;
	}>
): Promise<void> {
	const files = services
		.filter(
			(s): s is typeof s & { envVars: Array<{ key: string; value: string }> } =>
				s.envVars !== undefined && s.envVars.length > 0
		)
		.map((s) => {
			const content = s.envVars
				.map(({ key, value }) => {
					if (NEEDS_QUOTING_RE.test(value)) {
						return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
					}
					return `${key}=${value}`;
				})
				.join("\n");
			const dir = s.cwd || ".";
			return { source: Buffer.from(content), destination: `${dir}/.env` };
		});

	if (files.length === 0) {
		return;
	}

	await sandbox.fs.uploadFiles(files);
}

async function provisionSandbox(
	ctx: ActionCtx,
	daytona: Daytona,
	spaceId: Id<"spaces">,
	snapshotName: string,
	anthropicApiKey: string,
	services: Space["environment"]["services"]
): Promise<Sandbox> {
	await ctx.runMutation(internal.spaces.internalUpdate, {
		id: spaceId,
		status: "creating" as const,
	});
	const sandbox = await daytona.create({
		snapshot: snapshotName,
		envVars: { ANTHROPIC_API_KEY: anthropicApiKey },
	});
	await bootSandboxAgent(sandbox);
	await writeServiceEnvFiles(sandbox, services);
	return sandbox;
}

async function resolveSandbox(
	ctx: ActionCtx,
	daytona: Daytona,
	space: Space,
	anthropicApiKey: string
): Promise<Sandbox> {
	const { snapshotName, services } = space.environment;

	if (!snapshotName) {
		throw new Error("Environment snapshot is not ready yet");
	}

	if (!space.sandboxId) {
		return await provisionSandbox(
			ctx,
			daytona,
			space._id,
			snapshotName,
			anthropicApiKey,
			services
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
			anthropicApiKey,
			services
		);
	}

	const { state } = sandbox;

	if (state === "stopped" || state === "archived") {
		await ctx.runMutation(internal.spaces.internalUpdate, {
			id: space._id,
			status: "starting" as const,
		});
		await sandbox.start();
		await bootSandboxAgent(sandbox);
		return sandbox;
	}

	return await provisionSandbox(
		ctx,
		daytona,
		space._id,
		snapshotName,
		anthropicApiKey,
		services
	);
}

export const ensureSandbox = internalAction({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		const daytonaApiKey = process.env.DAYTONA_API_KEY;
		const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
		if (!(daytonaApiKey && anthropicApiKey)) {
			throw new Error("Missing DAYTONA_API_KEY or ANTHROPIC_API_KEY env vars");
		}

		const daytona = new Daytona({ apiKey: daytonaApiKey });

		try {
			const space = await ctx.runQuery(internal.spaces.internalGet, {
				id: args.spaceId,
			});

			const sandbox = await resolveSandbox(
				ctx,
				daytona,
				space,
				anthropicApiKey
			);

			const sandboxUrl = await getPreviewUrl(sandbox);

			await ctx.runMutation(internal.spaces.internalUpdate, {
				id: args.spaceId,
				status: "started",
				sandboxId: sandbox.id,
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
