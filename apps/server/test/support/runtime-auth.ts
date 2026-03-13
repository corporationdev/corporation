import { readFileSync } from "node:fs";
import {
	mintRuntimeAccessToken,
	mintRuntimeRefreshToken,
} from "@corporation/contracts/runtime-auth";

export const TEST_RUNTIME_AUTH_SECRET = "test-secret";
const DEFAULT_TOKEN_TTL_SECONDS = 5 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 24 * 60 * 60;
let cachedRuntimeAuthSecret: string | undefined;

function getServerDotEnvPath(): string {
	return new URL("../../.env", import.meta.url).pathname;
}

function readRuntimeAuthSecretFromDotEnv(): string | undefined {
	if (cachedRuntimeAuthSecret !== undefined) {
		return cachedRuntimeAuthSecret || undefined;
	}

	try {
		const contents = readFileSync(getServerDotEnvPath(), "utf8");
		for (const line of contents.split(/\r?\n/u)) {
			const trimmed = line.trim();
			if (
				trimmed.startsWith("CORPORATION_RUNTIME_AUTH_SECRET=") &&
				trimmed.length > "CORPORATION_RUNTIME_AUTH_SECRET=".length
			) {
				cachedRuntimeAuthSecret = trimmed
					.slice("CORPORATION_RUNTIME_AUTH_SECRET=".length)
					.trim();
				return cachedRuntimeAuthSecret;
			}
		}
	} catch {
		// Fall back to the test default when no local .env file is present.
	}

	cachedRuntimeAuthSecret = "";
	return undefined;
}

function getRuntimeAuthSecret(secret?: string): string {
	return (
		secret ??
		process.env.CORPORATION_RUNTIME_AUTH_SECRET?.trim() ??
		readRuntimeAuthSecretFromDotEnv() ??
		TEST_RUNTIME_AUTH_SECRET
	);
}

export async function mintTestRuntimeAccessToken(input: {
	userId: string;
	clientId: string;
	expiresInSeconds?: number;
	secret?: string;
}): Promise<string> {
	return await mintRuntimeAccessToken(
		{
			sub: input.userId,
			sandboxId: input.clientId,
			exp:
				Math.floor(Date.now() / 1000) +
				(input.expiresInSeconds ?? DEFAULT_TOKEN_TTL_SECONDS),
		},
		getRuntimeAuthSecret(input.secret)
	);
}

export async function mintTestRuntimeRefreshToken(input: {
	userId: string;
	clientId: string;
	expiresInSeconds?: number;
	secret?: string;
}): Promise<string> {
	return await mintRuntimeRefreshToken(
		{
			sub: input.userId,
			sandboxId: input.clientId,
			exp:
				Math.floor(Date.now() / 1000) +
				(input.expiresInSeconds ?? DEFAULT_REFRESH_TTL_SECONDS),
		},
		getRuntimeAuthSecret(input.secret)
	);
}

export function buildRuntimeSocketUrl(input: {
	accessToken: string;
	serverUrl: string;
}): string {
	const url = new URL("/api/runtime/socket", input.serverUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.search = new URLSearchParams({
		token: input.accessToken,
	}).toString();
	return url.toString();
}

export function buildRuntimeAuthSessionUrl(serverUrl: string): string {
	return new URL("/api/runtime/auth/session", serverUrl).toString();
}
