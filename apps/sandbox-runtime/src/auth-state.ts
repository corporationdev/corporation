import { mkdirSync, writeFileSync } from "node:fs";
import type { RuntimeJWTPayload } from "./auth";
import { getLocalProxyConfig } from "./proxy-config";

let latestVerifiedToken: { token: string; payload: RuntimeJWTPayload } | null =
	null;

export function rememberVerifiedAuthToken(
	token: string,
	payload: RuntimeJWTPayload
) {
	// Temporary stopgap while the runtime control plane is still inbound HTTP.
	// This should be replaced by a reverse WebSocket control channel so proxy
	// auth follows a live runtime connection instead of the last valid request.
	latestVerifiedToken = { token, payload };

	try {
		const proxyConfig = getLocalProxyConfig(process.env);
		mkdirSync(proxyConfig.stateDir, { recursive: true });
		writeFileSync(proxyConfig.workerTokenPath, token);
	} catch (error) {
		console.error("Failed to persist proxy auth token", error);
	}
}

export function getLatestVerifiedAuthToken() {
	return latestVerifiedToken;
}
