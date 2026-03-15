import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveRuntimeContext } from "@tendril/config/runtime";

type StoredCredential = {
	clientId: string;
	refreshToken: string;
	updatedAt: string;
};

type CredentialsFile = {
	version: 1;
	servers: Record<string, StoredCredential>;
};

type RuntimeSessionResponse = {
	websocketUrl: string;
};

type DeviceAuthorizationCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
};

type DeviceAuthorizationPollResult =
	| {
			status: "authorized";
			accessToken: string;
			expiresInSeconds: number;
	  }
	| {
			status:
				| "authorization_pending"
				| "slow_down"
				| "expired_token"
				| "access_denied"
				| "invalid_grant";
			errorDescription?: string;
	  };

type RuntimeRefreshTokenResponse = {
	refreshToken: string;
	expiresAt: number;
};

const DEFAULT_CREDENTIALS_PATH = join(
	homedir(),
	".tendril",
	"credentials.json"
);

const DEFAULT_STAGE = "prod";
const LEADING_SLASHES_REGEX = /^\/+/u;

function getDefaultStage(): string {
	const stage = process.env.STAGE?.trim();
	return stage && stage.length > 0 ? stage : DEFAULT_STAGE;
}

function getDefaultRuntimeContext() {
	return resolveRuntimeContext(getDefaultStage(), {
		allowMissingPreviewConvex: true,
	});
}

export function getDefaultServerUrl(): string {
	return (
		process.env.SERVER_URL?.trim() ||
		getDefaultRuntimeContext().serverBindings.SERVER_URL
	);
}

export function getDefaultAuthUrl(
	serverUrl: string = getDefaultServerUrl()
): string {
	const explicitAuthUrl = process.env.TENDRIL_AUTH_URL?.trim();
	if (explicitAuthUrl) {
		return explicitAuthUrl;
	}

	const convexSiteUrl =
		process.env.CONVEX_SITE_URL?.trim() ||
		getDefaultRuntimeContext().serverBindings.CONVEX_SITE_URL;
	if (convexSiteUrl) {
		return new URL("/api/auth", convexSiteUrl).toString();
	}

	return new URL("/api/auth", serverUrl).toString();
}

export function getDefaultRefreshToken(): string | undefined {
	const value = process.env.RUNTIME_REFRESH_TOKEN?.trim();
	return value || undefined;
}

export function getDefaultApiKey(): string | undefined {
	const value = process.env.TENDRIL_API_KEY?.trim();
	return value || undefined;
}

export function getDefaultCredentialsPath(): string {
	return DEFAULT_CREDENTIALS_PATH;
}

function normalizeServerKey(serverUrl: string): string {
	const url = new URL(serverUrl);
	return url.origin;
}

function buildUrl(baseUrl: string, pathname: string): string {
	const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	const normalizedPath = pathname.replace(LEADING_SLASHES_REGEX, "");
	return new URL(normalizedPath, normalizedBase).toString();
}

async function readCredentialsFile(
	credentialsPath: string
): Promise<CredentialsFile> {
	try {
		const raw = await readFile(credentialsPath, "utf8");
		const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
		return {
			version: 1,
			servers: parsed.servers ?? {},
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { version: 1, servers: {} };
		}
		throw error;
	}
}

async function writeCredentialsFile(
	credentialsPath: string,
	data: CredentialsFile
): Promise<void> {
	await mkdir(dirname(credentialsPath), { recursive: true });
	await writeFile(
		credentialsPath,
		`${JSON.stringify(data, null, 2)}\n`,
		"utf8"
	);
}

export async function saveRuntimeCredentials(input: {
	clientId: string;
	credentialsPath: string;
	refreshToken: string;
	serverUrl: string;
}): Promise<void> {
	const data = await readCredentialsFile(input.credentialsPath);
	data.servers[normalizeServerKey(input.serverUrl)] = {
		clientId: input.clientId,
		refreshToken: input.refreshToken,
		updatedAt: new Date().toISOString(),
	};
	await writeCredentialsFile(input.credentialsPath, data);
}

export async function loadRuntimeCredentials(input: {
	credentialsPath: string;
	serverUrl: string;
}): Promise<StoredCredential | null> {
	const data = await readCredentialsFile(input.credentialsPath);
	return data.servers[normalizeServerKey(input.serverUrl)] ?? null;
}

export async function clearRuntimeCredentials(input: {
	credentialsPath: string;
	serverUrl: string;
}) {
	const data = await readCredentialsFile(input.credentialsPath);
	delete data.servers[normalizeServerKey(input.serverUrl)];
	await writeCredentialsFile(input.credentialsPath, data);
}

export function openBrowser(url: string): void {
	const spawnDetached = (command: string, args: string[]): void => {
		spawn(command, args, { stdio: "ignore", detached: true }).unref();
	};

	if (process.platform === "darwin") {
		spawnDetached("open", [url]);
		return;
	}
	if (process.platform === "win32") {
		spawnDetached("cmd", ["/c", "start", "", url]);
		return;
	}
	spawnDetached("xdg-open", [url]);
}

export async function startDeviceAuthorization(input: {
	authUrl: string;
	clientId: string;
}): Promise<DeviceAuthorizationCodeResponse> {
	const response = await fetch(buildUrl(input.authUrl, "/device/code"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: input.clientId,
		}),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			error?: string;
			error_description?: string;
		} | null;
		throw new Error(
			body?.error_description ||
				body?.error ||
				`Device auth failed to start (${response.status})`
		);
	}

	const body = (await response.json()) as DeviceAuthorizationCodeResponse;
	if (
		!(
			body.device_code &&
			body.user_code &&
			body.verification_uri &&
			body.verification_uri_complete
		)
	) {
		throw new Error("Device auth start response is invalid");
	}
	return body;
}

export async function pollDeviceAuthorization(input: {
	authUrl: string;
	clientId: string;
	deviceCode: string;
}): Promise<DeviceAuthorizationPollResult> {
	const response = await fetch(buildUrl(input.authUrl, "/device/token"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: input.deviceCode,
			client_id: input.clientId,
		}),
	});

	if (response.ok) {
		const body = (await response.json()) as {
			access_token?: string;
			expires_in?: number;
		};
		if (!(body.access_token && body.expires_in)) {
			throw new Error("Device auth token response is invalid");
		}
		return {
			status: "authorized",
			accessToken: body.access_token,
			expiresInSeconds: body.expires_in,
		};
	}

	const body = (await response.json().catch(() => null)) as {
		error?: DeviceAuthorizationPollResult["status"];
		error_description?: string;
	} | null;

	const errorCode = body?.error;
	if (
		errorCode === "authorization_pending" ||
		errorCode === "slow_down" ||
		errorCode === "expired_token" ||
		errorCode === "access_denied" ||
		errorCode === "invalid_grant"
	) {
		return {
			status: errorCode,
			errorDescription: body?.error_description,
		};
	}

	throw new Error(
		body?.error_description ||
			body?.error ||
			`Device auth poll failed (${response.status})`
	);
}

export async function exchangeRuntimeAccessToken(input: {
	accessToken: string;
	clientId: string;
	serverUrl: string;
}): Promise<RuntimeRefreshTokenResponse> {
	const response = await fetch(
		buildUrl(input.serverUrl, "/auth/access-token"),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				accessToken: input.accessToken,
				clientId: input.clientId,
			}),
		}
	);
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			error?: string;
		} | null;
		throw new Error(
			body?.error || `Runtime token exchange failed (${response.status})`
		);
	}
	return (await response.json()) as RuntimeRefreshTokenResponse;
}

export async function exchangeRuntimeApiKey(input: {
	apiKey: string;
	clientId: string;
	serverUrl: string;
}): Promise<RuntimeRefreshTokenResponse> {
	const response = await fetch(buildUrl(input.serverUrl, "/auth/api-key"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			apiKey: input.apiKey,
			clientId: input.clientId,
		}),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			error?: string;
		} | null;
		throw new Error(
			body?.error || `API key exchange failed (${response.status})`
		);
	}
	return (await response.json()) as RuntimeRefreshTokenResponse;
}

async function requestRuntimeSession(input: {
	refreshToken: string;
	serverUrl: string;
}): Promise<RuntimeSessionResponse> {
	const response = await fetch(buildUrl(input.serverUrl, "/auth/session"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refreshToken: input.refreshToken }),
	});
	if (!response.ok) {
		throw new Error(`Runtime auth failed: ${response.status}`);
	}
	const body = (await response.json()) as RuntimeSessionResponse;
	if (!body.websocketUrl) {
		throw new Error("Runtime auth response did not include a websocket URL");
	}
	return body;
}

export async function resolveRuntimeWebSocketUrl(input: {
	credentialsPath: string;
	refreshToken?: string;
	serverUrl: string;
	url?: string;
}): Promise<string> {
	if (input.url) {
		if (input.refreshToken) {
			throw new Error(
				"Use either --url for a direct websocket connection or --server-url with a refresh token"
			);
		}
		return input.url;
	}

	const storedCredentials =
		input.refreshToken === undefined
			? await loadRuntimeCredentials({
					credentialsPath: input.credentialsPath,
					serverUrl: input.serverUrl,
				})
			: null;
	const refreshToken =
		input.refreshToken ?? storedCredentials?.refreshToken ?? undefined;
	if (!refreshToken) {
		throw new Error(
			"No runtime refresh token found. Run `tendril login` first or pass --refresh-token."
		);
	}

	const session = await requestRuntimeSession({
		refreshToken,
		serverUrl: input.serverUrl,
	});
	return session.websocketUrl;
}
