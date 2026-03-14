import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

type RuntimeRefreshTokenResponse = {
	refreshToken: string;
};

const DEFAULT_CREDENTIALS_PATH = join(
	homedir(),
	".corporation",
	"credentials.json"
);

const DEFAULT_DEV_SERVER_URL = "http://localhost:3000";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function getDefaultServerUrl(): string {
	return process.env.SERVER_URL?.trim() || DEFAULT_DEV_SERVER_URL;
}

export function getDefaultRefreshToken(): string | undefined {
	const value = process.env.RUNTIME_REFRESH_TOKEN?.trim();
	return value || undefined;
}

export function getDefaultCredentialsPath(): string {
	return DEFAULT_CREDENTIALS_PATH;
}

function normalizeServerKey(serverUrl: string): string {
	const url = new URL(serverUrl);
	return url.origin;
}

function buildRuntimeApiUrl(serverUrl: string, pathname: string): string {
	return new URL(pathname, serverUrl).toString();
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

async function saveRuntimeCredentials(input: {
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

async function loadRuntimeCredentials(input: {
	credentialsPath: string;
	serverUrl: string;
}): Promise<StoredCredential | null> {
	const data = await readCredentialsFile(input.credentialsPath);
	return data.servers[normalizeServerKey(input.serverUrl)] ?? null;
}

function openBrowser(url: string): void {
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

function isLoginCallbackRequest(url: URL, method: string | undefined): boolean {
	return (
		url.pathname === "/callback" && (method === "GET" || method === "POST")
	);
}

async function readPostSearchParams(
	request: IncomingMessage
): Promise<URLSearchParams> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function resolveCallbackParams(input: {
	request: IncomingMessage;
	requestUrl: URL;
}): Promise<URLSearchParams> {
	if (input.request.method !== "POST") {
		return input.requestUrl.searchParams;
	}

	return await readPostSearchParams(input.request);
}

function respondWithError(
	response: ServerResponse<IncomingMessage>,
	statusCode: number,
	message: string
): void {
	response.statusCode = statusCode;
	response.end(message);
}

async function handleLoginCallbackRequest(input: {
	expectedState: string;
	request: IncomingMessage;
	response: ServerResponse<IncomingMessage>;
	resolveToken: (value: RuntimeRefreshTokenResponse) => void;
	rejectToken: (reason?: unknown) => void;
	closeServer: () => void;
}): Promise<void> {
	const requestUrl = new URL(input.request.url ?? "/", "http://127.0.0.1");
	if (!isLoginCallbackRequest(requestUrl, input.request.method)) {
		respondWithError(input.response, 404, "Not found");
		return;
	}

	try {
		const params = await resolveCallbackParams({
			request: input.request,
			requestUrl,
		});
		const refreshToken = params.get("refreshToken")?.trim();
		const state = params.get("state")?.trim();

		if (!(refreshToken && state)) {
			respondWithError(input.response, 400, "Missing login payload");
			return;
		}
		if (state !== input.expectedState) {
			respondWithError(input.response, 400, "Invalid login state");
			return;
		}

		input.response.setHeader("Content-Type", "text/html; charset=utf-8");
		input.response.end(
			"<!doctype html><title>Runtime login complete</title><body><p>Runtime login complete. You can close this window.</p></body>"
		);
		input.resolveToken({ refreshToken });
		input.closeServer();
	} catch (error) {
		input.rejectToken(error);
		respondWithError(input.response, 500, "Runtime login failed");
		input.closeServer();
	}
}

async function startLoginCallbackServer(expectedState: string): Promise<{
	callbackUrl: string;
	waitForRefreshToken: Promise<RuntimeRefreshTokenResponse>;
}> {
	let resolveToken!: (value: RuntimeRefreshTokenResponse) => void;
	let rejectToken!: (reason?: unknown) => void;
	const waitForRefreshToken = new Promise<RuntimeRefreshTokenResponse>(
		(resolve, reject) => {
			resolveToken = resolve;
			rejectToken = reject;
		}
	);

	const server = createServer(async (request, response) => {
		response.setHeader("Cache-Control", "no-store");
		await handleLoginCallbackRequest({
			expectedState,
			request,
			response,
			resolveToken,
			rejectToken,
			closeServer: () => {
				server.close();
			},
		});
	});

	server.on("error", (error) => {
		rejectToken(error);
	});

	const port = await new Promise<number>((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!(address && typeof address === "object")) {
				reject(new Error("Failed to bind runtime login callback server"));
				return;
			}
			resolve(address.port);
		});
		server.on("error", reject);
	});

	return {
		callbackUrl: `http://127.0.0.1:${port}/callback`,
		waitForRefreshToken,
	};
}

async function requestRuntimeSession(input: {
	refreshToken: string;
	serverUrl: string;
}): Promise<RuntimeSessionResponse> {
	const response = await fetch(
		buildRuntimeApiUrl(input.serverUrl, "/api/runtime/auth/session"),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: input.refreshToken }),
		}
	);
	if (!response.ok) {
		throw new Error(`Runtime auth failed: ${response.status}`);
	}
	const body = (await response.json()) as RuntimeSessionResponse;
	if (!body.websocketUrl) {
		throw new Error("Runtime auth response did not include a websocket URL");
	}
	return body;
}

export async function loginWithBrowser(input: {
	credentialsPath: string;
	serverUrl: string;
}): Promise<void> {
	const clientId = crypto.randomUUID();
	const state = crypto.randomUUID();
	const callback = await startLoginCallbackServer(state);
	const loginUrl = new URL(
		buildRuntimeApiUrl(input.serverUrl, "/api/runtime/login")
	);
	loginUrl.search = new URLSearchParams({
		callbackUrl: callback.callbackUrl,
		clientId,
		state,
	}).toString();

	openBrowser(loginUrl.toString());
	console.log(`Opening browser for runtime login: ${loginUrl.toString()}`);

	const loginTimeout = new Promise<never>((_, reject) => {
		const timer = setTimeout(() => {
			reject(
				new Error(
					"Runtime login timed out before the browser completed the callback"
				)
			);
		}, LOGIN_TIMEOUT_MS);
		callback.waitForRefreshToken.finally(() => {
			clearTimeout(timer);
		});
	});
	const { refreshToken } = await Promise.race([
		callback.waitForRefreshToken,
		loginTimeout,
	]);
	await saveRuntimeCredentials({
		clientId,
		credentialsPath: input.credentialsPath,
		refreshToken,
		serverUrl: input.serverUrl,
	});

	console.log(
		`Stored runtime credentials in ${input.credentialsPath} for ${normalizeServerKey(input.serverUrl)}`
	);
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
			"No runtime refresh token found. Run `sandbox-runtime login --server-url ...` first or pass --token."
		);
	}

	const session = await requestRuntimeSession({
		refreshToken,
		serverUrl: input.serverUrl,
	});
	return session.websocketUrl;
}
