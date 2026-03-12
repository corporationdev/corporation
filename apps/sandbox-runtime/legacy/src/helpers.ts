export const ACP_PROTOCOL_VERSION = 1;
export const ACP_REQUEST_TIMEOUT_MS = 10 * 60_000;
export const CALLBACK_TIMEOUT_MS = 10_000;
export const CALLBACK_MAX_ATTEMPTS = 8;
export const EVENT_BATCH_MAX_SIZE = 10;
export const EVENT_BATCH_MAX_DELAY_MS = 5;

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

async function waitForRetry(delayMs: number): Promise<number> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
	return Math.min(delayMs * 2, 4000);
}

function isRetryableTransportError(error: unknown): boolean {
	if (error instanceof TypeError) {
		return true;
	}

	const errorName = error instanceof Error ? error.name : "";
	return errorName === "FetchError" || errorName === "NetworkError";
}

export async function postJsonWithRetry(
	url: string,
	body: unknown,
	timeoutMs: number,
	maxAttempts: number,
	headers?: Record<string, string>
): Promise<void> {
	let attempt = 0;
	let delayMs = 250;

	while (true) {
		attempt += 1;
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(headers ?? {}),
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				const error = new Error(
					`Callback failed (${response.status}): ${text}`
				);
				if (response.status < 500) {
					throw error;
				}
				if (attempt >= maxAttempts) {
					throw error;
				}
				delayMs = await waitForRetry(delayMs);
				continue;
			}
			return;
		} catch (error) {
			if (!isRetryableTransportError(error)) {
				throw error;
			}
			if (attempt >= maxAttempts) {
				throw error;
			}
			delayMs = await waitForRetry(delayMs);
		}
	}
}
