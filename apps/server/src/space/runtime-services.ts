import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import { Sandbox } from "e2b";
import { SandboxAgent as SandboxAgentClient } from "sandbox-agent";
import type { RuntimeServices, SpaceRuntimeContext } from "./types";

const log = createLogger("space:runtime-services");
const CONNECT_RETRY_DELAY_MS = 250;
const MAX_CONNECT_ATTEMPTS = 2;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientRuntimeServiceError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	const message = error.message.toLowerCase();
	return (
		message.includes("timeout") ||
		message.includes("timed out") ||
		message.includes("connection") ||
		message.includes("network") ||
		message.includes("econnreset") ||
		message.includes("socket hang up")
	);
}

function setRuntimeServices(
	ctx: SpaceRuntimeContext,
	services: RuntimeServices
): void {
	ctx.vars.runtimeServices.sandbox = services.sandbox;
	ctx.vars.runtimeServices.sandboxClient = services.sandboxClient;
}

function clearRuntimeServices(ctx: SpaceRuntimeContext): void {
	ctx.vars.runtimeServices.sandbox = null;
	ctx.vars.runtimeServices.sandboxClient = null;
}

function getReadyRuntimeServices(
	ctx: SpaceRuntimeContext
): RuntimeServices | null {
	const { sandbox, sandboxClient } = ctx.vars.runtimeServices;
	if (!(sandbox && sandboxClient)) {
		return null;
	}
	return { sandbox, sandboxClient };
}

async function connectRuntimeServices(
	ctx: SpaceRuntimeContext
): Promise<RuntimeServices> {
	if (!env.E2B_API_KEY) {
		throw new Error("Missing E2B_API_KEY env var");
	}

	const [sandboxClient, sandbox] = await Promise.all([
		SandboxAgentClient.connect({
			baseUrl: ctx.state.agentUrl,
			persist: ctx.vars.persist,
		}),
		Sandbox.connect(ctx.state.sandboxId, {
			apiKey: env.E2B_API_KEY,
		}),
	]);

	return { sandbox, sandboxClient };
}

export async function ensureRuntimeServices(
	ctx: SpaceRuntimeContext
): Promise<RuntimeServices> {
	const existing = getReadyRuntimeServices(ctx);
	if (existing) {
		return existing;
	}

	const inFlight = ctx.vars.runtimeServices.inFlight;
	if (inFlight) {
		return inFlight;
	}

	const reconnectPromise = (async () => {
		const startedAt = Date.now();

		for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt += 1) {
			try {
				log.info(
					{ actorId: ctx.actorId, attempt, maxAttempts: MAX_CONNECT_ATTEMPTS },
					"runtime-services.connect-attempt"
				);
				const services = await connectRuntimeServices(ctx);
				setRuntimeServices(ctx, services);
				log.info(
					{
						actorId: ctx.actorId,
						attempt,
						durationMs: Date.now() - startedAt,
					},
					"runtime-services.connected"
				);
				return services;
			} catch (error) {
				clearRuntimeServices(ctx);
				const transient = isTransientRuntimeServiceError(error);
				log.warn(
					{
						actorId: ctx.actorId,
						attempt,
						transient,
						err: error,
					},
					"runtime-services.connect-failed"
				);

				if (!(transient && attempt < MAX_CONNECT_ATTEMPTS)) {
					throw error;
				}

				await sleep(CONNECT_RETRY_DELAY_MS);
			}
		}

		throw new Error("Failed to initialize runtime services");
	})();

	ctx.vars.runtimeServices.inFlight = reconnectPromise;

	try {
		return await reconnectPromise;
	} finally {
		if (ctx.vars.runtimeServices.inFlight === reconnectPromise) {
			ctx.vars.runtimeServices.inFlight = null;
		}
	}
}

export async function getSandbox(ctx: SpaceRuntimeContext): Promise<Sandbox> {
	const services = await ensureRuntimeServices(ctx);
	return services.sandbox;
}

export async function getSandboxClient(
	ctx: SpaceRuntimeContext
): Promise<SandboxAgentClient> {
	const services = await ensureRuntimeServices(ctx);
	return services.sandboxClient;
}
