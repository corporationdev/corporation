import {
	mintRuntimeAccessToken,
	mintRuntimeRefreshToken,
	type RuntimeAuthSessionRequest,
	type RuntimeRefreshTokenRequest,
	runtimeAuthSessionResponseSchema,
	runtimeRefreshTokenResponseSchema,
	verifyRuntimeRefreshToken,
} from "@corporation/contracts/runtime-auth";

const RUNTIME_REFRESH_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const RUNTIME_ACCESS_TOKEN_TTL_SECONDS = 5 * 60;

function buildRuntimeSocketUrl(serverUrl: string, token: string) {
	const url = new URL(serverUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/api/runtime/socket";
	url.search = new URLSearchParams({ token }).toString();
	url.hash = "";
	return url.toString();
}

export async function createRuntimeAuthSession(
	env: {
		RUNTIME_AUTH_SECRET?: string;
		SERVER_URL?: string;
	},
	requestUrl: string,
	input: RuntimeAuthSessionRequest
) {
	const secret = env.RUNTIME_AUTH_SECRET?.trim();
	if (!secret) {
		throw new Error("Runtime auth is not configured");
	}

	const claims = await verifyRuntimeRefreshToken(input.refreshToken, secret);
	if (!claims) {
		throw new Error("Unauthorized");
	}

	const expiresAtSeconds =
		Math.floor(Date.now() / 1000) + RUNTIME_ACCESS_TOKEN_TTL_SECONDS;
	const accessToken = await mintRuntimeAccessToken(
		{
			sub: claims.sub,
			clientId: claims.clientId,
			exp: expiresAtSeconds,
		},
		secret
	);
	const canonicalServerUrl = env.SERVER_URL?.trim();
	const runtimeSocketBaseUrl = canonicalServerUrl || requestUrl;

	return runtimeAuthSessionResponseSchema.parse({
		accessToken,
		websocketUrl: buildRuntimeSocketUrl(runtimeSocketBaseUrl, accessToken),
		expiresAt: expiresAtSeconds * 1000,
	});
}

export async function createRuntimeRefreshToken(
	env: {
		RUNTIME_AUTH_SECRET?: string;
	},
	input: RuntimeRefreshTokenRequest & {
		userId: string;
	}
) {
	const secret = env.RUNTIME_AUTH_SECRET?.trim();
	if (!secret) {
		throw new Error("Runtime auth is not configured");
	}

	const expiresAtSeconds =
		Math.floor(Date.now() / 1000) + RUNTIME_REFRESH_TOKEN_TTL_SECONDS;
	const refreshToken = await mintRuntimeRefreshToken(
		{
			sub: input.userId,
			clientId: input.clientId,
			exp: expiresAtSeconds,
		},
		secret
	);

	return runtimeRefreshTokenResponseSchema.parse({
		refreshToken,
		expiresAt: expiresAtSeconds * 1000,
	});
}
