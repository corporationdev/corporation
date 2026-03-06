import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import type { SpaceRuntimeContext } from "./types";

const log = createLogger("space:keepalive");

// Keep in sync with SANDBOX_TIMEOUT_MS in packages/backend/convex/sandboxActions.ts
const SANDBOX_TIMEOUT_MS = 900_000;
const SANDBOX_KEEPALIVE_DEBOUNCE_MS = 60_000;

export function refreshSandboxTimeout(runtime: SpaceRuntimeContext): void {
	const now = Date.now();
	const elapsed = now - runtime.vars.lastTimeoutRefreshAt;

	if (elapsed < SANDBOX_KEEPALIVE_DEBOUNCE_MS) {
		return;
	}

	runtime.vars.lastTimeoutRefreshAt = now;

	const sandboxId = runtime.state.sandboxId;
	const expiresAt = now + SANDBOX_TIMEOUT_MS;

	runtime.vars.sandbox
		.setTimeout(SANDBOX_TIMEOUT_MS)
		.then(() => {
			log.info({ actorId: runtime.actorId }, "sandbox-timeout.refreshed");

			const convexSiteUrl = env.CONVEX_SITE_URL;
			const internalApiKey = env.INTERNAL_API_KEY;
			if (!(convexSiteUrl && internalApiKey)) {
				return;
			}

			fetch(`${convexSiteUrl}/internal/sandbox-timeout`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${internalApiKey}`,
				},
				body: JSON.stringify({ sandboxId, expiresAt }),
			}).catch((error) => {
				log.warn(
					{ actorId: runtime.actorId, err: error },
					"sandbox-timeout.convex-update-failed"
				);
			});
		})
		.catch((error) => {
			log.warn(
				{ actorId: runtime.actorId, err: error },
				"sandbox-timeout.refresh-failed"
			);
			runtime.vars.lastTimeoutRefreshAt = 0;
		});
}
