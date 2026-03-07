import type { InitializeResponse } from "@agentclientprotocol/sdk";

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_REQUEST_TIMEOUT_MS = 10 * 60_000;
export const CALLBACK_TIMEOUT_MS = 10_000;
export const CALLBACK_MAX_ATTEMPTS = 8;
export const EVENT_BATCH_MAX_SIZE = 10;
export const EVENT_BATCH_MAX_DELAY_MS = 5;

export const AUTH_METHOD_ENV_CANDIDATES: Record<string, string[]> = {
	"anthropic-api-key": ["ANTHROPIC_API_KEY"],
	"codex-api-key": ["CODEX_API_KEY"],
	"openai-api-key": ["OPENAI_API_KEY"],
	"opencode-api-key": ["OPENCODE_API_KEY"],
};

export type AuthMethod = { id: string };

export function formatError(error: unknown): {
	name: string;
	message: string;
	stack: string | null;
} {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack ?? null,
		};
	}
	return { name: "Error", message: String(error), stack: null };
}

export function pickPermissionOption(
	options: unknown[]
): { kind: string; optionId: string } | null {
	if (!Array.isArray(options)) {
		return null;
	}
	const allowAlways = options.find(
		(o) =>
			o &&
			typeof o === "object" &&
			(o as Record<string, unknown>).kind === "allow_always" &&
			typeof (o as Record<string, unknown>).optionId === "string"
	) as { kind: string; optionId: string } | undefined;
	if (allowAlways) {
		return allowAlways;
	}
	const allowOnce = options.find(
		(o) =>
			o &&
			typeof o === "object" &&
			(o as Record<string, unknown>).kind === "allow_once" &&
			typeof (o as Record<string, unknown>).optionId === "string"
	) as { kind: string; optionId: string } | undefined;
	return allowOnce ?? null;
}

export function extractAuthMethods(
	initResult: InitializeResponse
): AuthMethod[] {
	const authMethods = initResult.authMethods ?? [];
	if (!Array.isArray(authMethods)) {
		return [];
	}

	return authMethods
		.filter((method) => method && typeof method.id === "string")
		.map((method) => ({ id: method.id }));
}

export function selectAuthMethod(
	authMethods: AuthMethod[]
): { methodId: string; envVar: string } | null {
	for (const method of authMethods) {
		const envCandidates = AUTH_METHOD_ENV_CANDIDATES[method.id] ?? [];
		for (const envVar of envCandidates) {
			if (typeof process.env[envVar] === "string" && process.env[envVar]) {
				return { methodId: method.id, envVar };
			}
		}
	}
	return null;
}

export async function postJsonWithRetry(
	url: string,
	body: unknown,
	timeoutMs: number,
	maxAttempts: number
): Promise<void> {
	let attempt = 0;
	let delayMs = 250;

	while (true) {
		attempt += 1;
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(`Callback failed (${response.status}): ${text}`);
			}
			return;
		} catch (error) {
			if (attempt >= maxAttempts) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			delayMs = Math.min(delayMs * 2, 4000);
		}
	}
}
