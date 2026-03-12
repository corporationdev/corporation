import type { CreateRuntimeAuthSessionInput } from "@corporation/contracts/orpc/worker-http";
import {
	mintRuntimeAccessToken,
	runtimeAuthSessionResponseSchema,
	verifyRuntimeRefreshToken,
} from "@corporation/contracts/runtime-auth";

const RUNTIME_ACCESS_TOKEN_TTL_SECONDS = 5 * 60;

function buildRuntimeSocketUrl(
	serverUrl: string,
	spaceSlug: string,
	token: string
) {
	const url = new URL(serverUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = `/api/spaces/${encodeURIComponent(spaceSlug)}/runtime/socket`;
	url.search = new URLSearchParams({ token }).toString();
	url.hash = "";
	return url.toString();
}

export async function createRuntimeAuthSession(
	env: Env,
	requestUrl: string,
	input: CreateRuntimeAuthSessionInput
) {
	const secret = env.CORPORATION_RUNTIME_AUTH_SECRET?.trim();
	if (!secret) {
		throw new Error("Runtime auth is not configured");
	}

	const claims = await verifyRuntimeRefreshToken(input.refreshToken, secret);
	if (!claims || claims.spaceSlug !== input.spaceSlug) {
		throw new Error("Unauthorized");
	}

	const expiresAtSeconds =
		Math.floor(Date.now() / 1000) + RUNTIME_ACCESS_TOKEN_TTL_SECONDS;
	const accessToken = await mintRuntimeAccessToken(
		{
			sub: claims.sub,
			spaceSlug: claims.spaceSlug,
			sandboxId: claims.sandboxId,
			exp: expiresAtSeconds,
		},
		secret
	);
	const canonicalServerUrl = env.CORPORATION_SERVER_URL?.trim();
	const runtimeSocketBaseUrl = canonicalServerUrl || requestUrl;

	return runtimeAuthSessionResponseSchema.parse({
		accessToken,
		websocketUrl: buildRuntimeSocketUrl(
			runtimeSocketBaseUrl,
			input.spaceSlug,
			accessToken
		),
		expiresAt: expiresAtSeconds * 1000,
	});
}
