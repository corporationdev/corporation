#!/usr/bin/env node

import crypto from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { AcpHttpClient, PROTOCOL_VERSION } from "acp-http-client";

const CALLBACK_TIMEOUT_MS = 10_000;
const CALLBACK_MAX_ATTEMPTS = 8;
const RAW_PROMPT_RESPONSE_TIMEOUT_MS = 10 * 60_000;

function requireEnv(key) {
	const value = process.env[key];
	if (!value) {
		throw new Error(`Missing required env var: ${key}`);
	}
	return value;
}

function intEnv(key, fallback) {
	const raw = process.env[key];
	if (!raw) {
		return fallback;
	}
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1) {
		throw new Error(`Invalid integer for ${key}: ${raw}`);
	}
	return n;
}

function asRecord(value) {
	if (!value || typeof value !== "object") {
		return null;
	}
	return value;
}

function envelopeId(envelope) {
	const record = asRecord(envelope);
	const id = record?.id;
	if (id == null) {
		return null;
	}
	if (typeof id === "string" || typeof id === "number") {
		return String(id);
	}
	return null;
}

function envelopeResult(envelope) {
	const record = asRecord(envelope);
	return asRecord(record?.result);
}

function envelopeError(envelope) {
	const record = asRecord(envelope);
	return asRecord(record?.error);
}

function clonePayload(payload) {
	try {
		const cloned = JSON.parse(JSON.stringify(payload));
		if (cloned && typeof cloned === "object") {
			return cloned;
		}
		return { value: cloned };
	} catch {
		return { value: String(payload) };
	}
}

function formatError(error) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack ?? null,
		};
	}
	return { name: "Error", message: String(error), stack: null };
}

function pickPermissionOption(options) {
	if (!Array.isArray(options)) {
		return null;
	}

	const allowAlways = options.find(
		(option) =>
			asRecord(option) &&
			typeof option.kind === "string" &&
			option.kind === "allow_always" &&
			typeof option.optionId === "string"
	);
	if (allowAlways) {
		return allowAlways;
	}

	const allowOnce = options.find(
		(option) =>
			asRecord(option) &&
			typeof option.kind === "string" &&
			option.kind === "allow_once" &&
			typeof option.optionId === "string"
	);
	return allowOnce ?? null;
}

async function postJsonWithRetry(url, body, timeoutMs, maxAttempts) {
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
			await sleep(delayMs);
			delayMs = Math.min(delayMs * 2, 4000);
		}
	}
}

function createResponseWaiter(map, requestId, timeoutMs) {
	let settled = false;
	let timer = null;

	const promise = new Promise((resolve, reject) => {
		timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			map.delete(requestId);
			reject(
				new Error(
					`Timed out waiting for ACP response envelope for id ${requestId}`
				)
			);
		}, timeoutMs);

		map.set(requestId, (envelope) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			map.delete(requestId);
			resolve(envelope);
		});
	});

	return {
		promise,
		cancel: () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			map.delete(requestId);
		},
	};
}

async function sendPromptViaRawAcp({
	agentUrl,
	acpPath,
	sessionId,
	prompt,
	pendingResponseResolvers,
	timeoutMs,
	onClientEnvelope,
}) {
	const requestId = `prompt-${crypto.randomUUID()}`;
	const waiter = createResponseWaiter(
		pendingResponseResolvers,
		requestId,
		timeoutMs
	);
	const requestEnvelope = {
		jsonrpc: "2.0",
		id: requestId,
		method: "session/prompt",
		params: { sessionId, prompt },
	};
	const controller = new AbortController();
	const fetchTimeout = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	try {
		onClientEnvelope?.(requestEnvelope);

		const response = await fetch(new URL(acpPath, agentUrl), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(requestEnvelope),
			signal: controller.signal,
		});
		clearTimeout(fetchTimeout);

		const bodyText = await response.text().catch(() => "");
		if (!response.ok) {
			waiter.cancel();
			throw new Error(
				`Prompt failed (${response.status}): ${bodyText || "<empty>"}`
			);
		}

		const envelope = bodyText.trim()
			? JSON.parse(bodyText)
			: await waiter.promise;

		const error = envelopeError(envelope);
		if (error) {
			const code =
				typeof error.code === "number" ? String(error.code) : "unknown";
			const message =
				typeof error.message === "string"
					? error.message
					: JSON.stringify(error);
			throw new Error(`Prompt ACP error (${code}): ${message}`);
		}

		waiter.cancel();
		return envelopeResult(envelope) ?? {};
	} catch (error) {
		clearTimeout(fetchTimeout);
		waiter.cancel();
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(
				`Timed out waiting for ACP prompt transport after ${timeoutMs}ms`,
				{ cause: error }
			);
		}
		throw error;
	}
}

async function main() {
	const turnId = requireEnv("TURN_ID");
	const sessionId = requireEnv("SESSION_ID");
	const agent = requireEnv("AGENT");
	const callbackUrl = requireEnv("CALLBACK_URL");
	const callbackToken = requireEnv("CALLBACK_TOKEN");

	const agentUrl = process.env.AGENT_URL || "http://127.0.0.1:5799";
	const cwd = process.env.CWD || "/";
	const promptJson = requireEnv("PROMPT_JSON");
	const callbackTimeoutMs = intEnv("CALLBACK_TIMEOUT_MS", CALLBACK_TIMEOUT_MS);
	const callbackMaxAttempts = intEnv(
		"CALLBACK_MAX_ATTEMPTS",
		CALLBACK_MAX_ATTEMPTS
	);
	const rawPromptResponseTimeoutMs = intEnv(
		"RAW_PROMPT_RESPONSE_TIMEOUT_MS",
		RAW_PROMPT_RESPONSE_TIMEOUT_MS
	);

	const prompt = JSON.parse(promptJson);
	if (!Array.isArray(prompt)) {
		throw new Error("PROMPT_JSON must parse to an array");
	}

	const connectionId = `corp-turn-runner-${turnId}-${crypto.randomUUID()}`;
	const acpPath = `/v1/acp/${encodeURIComponent(connectionId)}`;
	const pendingResponseResolvers = new Map();

	let sequence = 0;
	let eventIndex = 0;
	let callbackChain = Promise.resolve();

	const queueCallback = (kind, payload = {}) => {
		sequence += 1;
		const envelope = {
			turnId,
			sessionId,
			token: callbackToken,
			sequence,
			kind,
			timestamp: Date.now(),
			...payload,
		};
		callbackChain = callbackChain
			.catch(() => undefined)
			.then(() =>
				postJsonWithRetry(
					callbackUrl,
					{ args: [envelope] },
					callbackTimeoutMs,
					callbackMaxAttempts
				)
			);
		return callbackChain;
	};

	const queueEnvelopeEvent = (envelope, direction) => {
		const id = envelopeId(envelope);
		if (direction === "inbound" && id && pendingResponseResolvers.has(id)) {
			pendingResponseResolvers.get(id)?.(envelope);
		}

		eventIndex += 1;
		queueCallback("events", {
			events: [
				{
					id: crypto.randomUUID(),
					eventIndex,
					sessionId,
					createdAt: Date.now(),
					connectionId,
					sender: direction === "outbound" ? "client" : "agent",
					payload: clonePayload(envelope),
				},
			],
		}).catch(() => undefined);
	};

	const acp = new AcpHttpClient({
		baseUrl: agentUrl,
		transport: {
			path: acpPath,
			bootstrapQuery: { agent },
		},
		onEnvelope: (envelope, direction) => {
			queueEnvelopeEvent(envelope, direction);
		},
		client: {
			requestPermission: (request) => {
				const record = asRecord(request);
				const options = Array.isArray(record?.options) ? record.options : [];
				const selected = pickPermissionOption(options);

				if (selected) {
					return {
						outcome: {
							outcome: "selected",
							optionId: selected.optionId,
						},
					};
				}
				return {
					outcome: {
						outcome: "cancelled",
					},
				};
			},
			sessionUpdate: async () => {
				// Session updates are captured through onEnvelope.
			},
		},
	});

	try {
		await acp.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientInfo: {
				name: "corp-turn-runner",
				version: "v1",
			},
		});

		const created = await acp.newSession({
			cwd,
			mcpServers: [],
		});
		if (!created.sessionId) {
			throw new Error("session/new did not return a sessionId");
		}

		await sendPromptViaRawAcp({
			agentUrl,
			acpPath,
			sessionId: created.sessionId,
			prompt,
			pendingResponseResolvers,
			timeoutMs: rawPromptResponseTimeoutMs,
			onClientEnvelope: (envelope) => queueEnvelopeEvent(envelope, "outbound"),
		});

		await queueCallback("completed");
		await callbackChain;
	} catch (error) {
		await queueCallback("failed", { error: formatError(error) }).catch(
			() => undefined
		);
		await callbackChain.catch(() => undefined);
		console.error(
			`[corp-turn-runner] failed: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
		process.exitCode = 1;
	} finally {
		await acp.disconnect().catch(() => undefined);
	}
}

process.on("unhandledRejection", (reason) => {
	console.error(
		`[corp-turn-runner] unhandledRejection: ${
			reason instanceof Error ? reason.message : String(reason)
		}`
	);
});

await main();
