import type { RuntimeJWTPayload } from "./auth";

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
}

export function getLatestVerifiedAuthToken() {
	return latestVerifiedToken;
}
