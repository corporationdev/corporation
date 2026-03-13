import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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

export function getDefaultServerUrl(): string | undefined {
	const value = process.env.CORPORATION_SERVER_URL?.trim();
	return value || undefined;
}

export function getDefaultRefreshToken(): string | undefined {
	const value = process.env.CORPORATION_RUNTIME_REFRESH_TOKEN?.trim();
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
	await writeFile(credentialsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
	if (process.platform === "darwin") {
		void spawn("open", [url], { stdio: "ignore", detached: true }).unref();
		return;
	}
	if (process.platform === "win32") {
		void spawn("cmd", ["/c", "start", "", url], {
			stdio: "ignore",
			detached: true,
		}).unref();
		return;
	}
	void spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}

async function startLoginCallbackServer(expectedState: string): Promise<{
	callbackUrl: string;
	waitForRefreshToken: Promise<RuntimeRefreshTokenResponse>;
}> {
	let resolveToken: (value: RuntimeRefreshTokenResponse) => void = () => {};
	let rejectToken: (reason?: unknown) => void = () => {};
	const waitForRefreshToken = new Promise<RuntimeRefreshTokenResponse>(
		(resolve, reject) => {
			resolveToken = resolve;
			rejectToken = reject;
		}
	);

	const server = createServer(async (request, response) => {
		response.setHeader("Cache-Control", "no-store");

		if (!(request.method === "POST" && request.url === "/callback")) {
			response.statusCode = 404;
			response.end("Not found");
			return;
		}

		try {
			const chunks: Uint8Array[] = [];
			for await (const chunk of request) {
				chunks.push(
					typeof chunk === "string" ? Buffer.from(chunk) : chunk
				);
			}
			const body = Buffer.concat(chunks).toString("utf8");
			const params = new URLSearchParams(body);
			const refreshToken = params.get("refreshToken")?.trim();
			const state = params.get("state")?.trim();

			if (!(refreshToken && state)) {
				response.statusCode = 400;
				response.end("Missing login payload");
				return;
			}
			if (state !== expectedState) {
				response.statusCode = 400;
				response.end("Invalid login state");
				return;
			}

			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end(
				"<!doctype html><title>Runtime login complete</title><body><p>Runtime login complete. You can close this window.</p></body>"
			);
			resolveToken({ refreshToken });
			server.close();
		} catch (error) {
			rejectToken(error);
			response.statusCode = 500;
			response.end("Runtime login failed");
			server.close();
		}
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
	const loginUrl = new URL(buildRuntimeApiUrl(input.serverUrl, "/api/runtime/login"));
	loginUrl.search = new URLSearchParams({
		callbackUrl: callback.callbackUrl,
		clientId,
		state,
	}).toString();

	openBrowser(loginUrl.toString());
	console.log(`Opening browser for runtime login: ${loginUrl.toString()}`);

	const { refreshToken } = await callback.waitForRefreshToken;
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
	serverUrl?: string;
	url?: string;
}): Promise<string> {
	if (input.url) {
		if (input.serverUrl || input.refreshToken) {
			throw new Error(
				"Use either --url for a direct websocket connection or --server-url with a refresh token"
			);
		}
		return input.url;
	}

	if (!input.serverUrl) {
		throw new Error("Either --url or --server-url is required");
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
