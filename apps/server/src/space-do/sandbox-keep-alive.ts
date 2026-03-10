import type { SpaceRuntimeContext } from "./types";

const SANDBOX_TIMEOUT_MS = 900_000;
const SANDBOX_KEEP_ALIVE_THROTTLE_MS = 240_000;

export async function keepAliveSandbox(
	ctx: SpaceRuntimeContext
): Promise<void> {
	const now = Date.now();
	if (now - ctx.vars.lastSandboxKeepAliveAt < SANDBOX_KEEP_ALIVE_THROTTLE_MS) {
		return;
	}

	const sandbox = ctx.vars.sandbox;
	if (!sandbox) {
		return;
	}

	await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
	ctx.vars.lastSandboxKeepAliveAt = now;
}
