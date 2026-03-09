import type { Sandbox } from "@e2b/desktop";
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
