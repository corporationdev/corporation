import { env } from "@corporation/env/server";
import { Sandbox } from "@e2b/desktop";
import type { SpaceRuntimeContext, SpaceVars } from "./types";

export function requireSandbox(
	ctx: SpaceRuntimeContext | { vars: SpaceVars }
): Sandbox {
	const sandbox = ctx.vars.sandbox;
	if (!sandbox) {
		throw new Error("Sandbox is not connected");
	}
	return sandbox;
}

export async function ensureSandboxConnected(
	ctx:
		| SpaceRuntimeContext
		| { state: { binding: { sandboxId: string } | null }; vars: SpaceVars }
): Promise<Sandbox> {
	const existing = ctx.vars.sandbox;
	if (existing) {
		return existing;
	}

	if (ctx.vars.sandboxPromise) {
		return await ctx.vars.sandboxPromise;
	}

	const sandboxId = ctx.state.binding?.sandboxId ?? null;
	if (!sandboxId) {
		throw new Error("Sandbox is not connected");
	}

	const promise = Sandbox.connect(sandboxId, {
		apiKey: env.E2B_API_KEY,
	}).then((sandbox) => {
		ctx.vars.sandbox = sandbox;
		return sandbox;
	});

	ctx.vars.sandboxPromise = promise;

	try {
		return await promise;
	} finally {
		if (ctx.vars.sandboxPromise === promise) {
			ctx.vars.sandboxPromise = null;
		}
	}
}
