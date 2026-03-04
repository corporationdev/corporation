#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import crypto from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { AcpHttpClient, PROTOCOL_VERSION } from "acp-http-client";

const FLUSH_INTERVAL_MS = 0;
const MAX_BATCH_SIZE = 1;
const CALLBACK_TIMEOUT_MS = 10_000;
const CALLBACK_MAX_ATTEMPTS = 8;
const LOG_FILE = "/tmp/corp-turn-runner.log";

function log(level, message, data) {
	const line = `[corp-turn-runner] ${new Date().toISOString()} ${message}`;
	const full = data !== undefined ? `${line} ${JSON.stringify(data)}` : line;
	try {
		appendFileSync(LOG_FILE, `${full}\n`, "utf8");
	} catch {
		// best-effort file logging
	}
	console[level](full);
}

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

function asRecord(value) {
	if (!value || typeof value !== "object") {
		return null;
	}
	return value;
}

function envelopeMethod(envelope) {
	const record = asRecord(envelope);
	return typeof record?.method === "string" ? record.method : null;
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

function envelopeParams(envelope) {
	const record = asRecord(envelope);
	return asRecord(record?.params);
}

function envelopeResult(envelope) {
	const record = asRecord(envelope);
	return asRecord(record?.result);
}

function envelopeError(envelope) {
	const record = asRecord(envelope);
	return asRecord(record?.error);
}

function sessionIdFromRecord(record) {
	if (!record) {
		return null;
	}
	return typeof record.sessionId === "string" ? record.sessionId : null;
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

function selectAllowPermissionOption(options) {
	if (!Array.isArray(options)) {
		return null;
	}

	const always = options.find(
		(option) =>
			asRecord(option) &&
			typeof option.kind === "string" &&
			option.kind === "allow_always" &&
			typeof option.optionId === "string"
	);
	if (always) {
		return always;
	}

	const once = options.find(
		(option) =>
			asRecord(option) &&
			typeof option.kind === "string" &&
			option.kind === "allow_once" &&
			typeof option.optionId === "string"
	);
	return once ?? null;
}

function summarizePermissionOptions(options) {
	if (!Array.isArray(options)) {
		return [];
	}
	return options
		.map((option) => {
			const record = asRecord(option);
			if (!record) {
				return null;
			}
			return {
				kind: typeof record.kind === "string" ? record.kind : null,
				name: typeof record.name === "string" ? record.name : null,
				optionId:
					typeof record.optionId === "string" ? record.optionId : null,
			};
		})
		.filter((option) => option !== null);
}

function summarizeToolCall(toolCall) {
	const record = asRecord(toolCall);
	if (!record) {
		return null;
	}
	return {
		toolCallId:
			typeof record.toolCallId === "string" ? record.toolCallId : null,
		kind: typeof record.kind === "string" ? record.kind : null,
		title: typeof record.title === "string" ? record.title : null,
	};
}

function summarizeEnvelope(envelope) {
	const method = envelopeMethod(envelope);
	const id = envelopeId(envelope);
	const params = envelopeParams(envelope);
	const result = envelopeResult(envelope);
	const error = envelopeError(envelope);
	const outcome = asRecord(result?.outcome);
	return {
		method,
		id,
		sessionId: sessionIdFromRecord(params),
		hasResult: !!result,
		hasError: !!error,
		errorCode: typeof error?.code === "number" ? error.code : null,
		errorMessage: typeof error?.message === "string" ? error.message : null,
		outcome: typeof outcome?.outcome === "string" ? outcome.outcome : null,
		optionId: typeof outcome?.optionId === "string" ? outcome.optionId : null,
	};
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
			log("warn", `callback POST failed (attempt ${attempt}/${maxAttempts})`, {
				error: error instanceof Error ? error.message : String(error),
			});
			if (attempt >= maxAttempts) {
				throw error;
			}
			await sleep(delayMs);
			delayMs = Math.min(delayMs * 2, 4000);
		}
	}
}

async function readResponseText(response) {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

async function sendPromptViaRawAcp({
	agentUrl,
	acpPath,
	sessionId,
	prompt,
	waitForPromptResponseEnvelope,
	promptResponseTimeoutMs,
}) {
	const requestId = `prompt-${crypto.randomUUID()}`;
	const url = new URL(acpPath, agentUrl).toString();
	const startedAt = Date.now();
	log("log", "raw prompt request sending", {
		requestId,
		sessionId,
		promptItems: Array.isArray(prompt) ? prompt.length : null,
		url,
	});

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: requestId,
			method: "session/prompt",
			params: { sessionId, prompt },
		}),
	});

	const elapsedMs = Date.now() - startedAt;
	const bodyText = await readResponseText(response);
	log("log", "raw prompt request response", {
		requestId,
		status: response.status,
		ok: response.ok,
		elapsedMs,
		bodyText: bodyText || null,
	});

	if (!response.ok) {
		throw new Error(
			`raw prompt request failed (${response.status}): ${bodyText || "<empty>"}`
		);
	}

	if (!bodyText.trim()) {
		log("log", "raw prompt request awaiting SSE response envelope", {
			requestId,
			timeoutMs: promptResponseTimeoutMs,
		});
		const envelope = await waitForPromptResponseEnvelope(
			requestId,
			promptResponseTimeoutMs
		);
		const errorRecord = envelopeError(envelope);
		if (errorRecord) {
			const code =
				typeof errorRecord.code === "number"
					? String(errorRecord.code)
					: "unknown";
			const message =
				typeof errorRecord.message === "string"
					? errorRecord.message
					: JSON.stringify(errorRecord);
			throw new Error(`raw prompt ACP error (${code}): ${message}`);
		}
		return envelopeResult(envelope);
	}

	let envelope;
	try {
		envelope = JSON.parse(bodyText);
	} catch (error) {
		throw new Error(
			`raw prompt response was not valid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}

	const errorRecord = envelopeError(envelope);
	if (errorRecord) {
		const code =
			typeof errorRecord.code === "number" ? String(errorRecord.code) : "unknown";
		const message =
			typeof errorRecord.message === "string"
				? errorRecord.message
				: JSON.stringify(errorRecord);
		throw new Error(`raw prompt ACP error (${code}): ${message}`);
	}

	return envelopeResult(envelope);
}

async function main() {
	process.on("unhandledRejection", (reason) => {
		log("error", "unhandledRejection", formatError(reason));
	});

	const turnId = requireEnv("TURN_ID");
	const sessionId = requireEnv("SESSION_ID");
	const agent = requireEnv("AGENT");
	const callbackUrl = requireEnv("CALLBACK_URL");
	const callbackToken = requireEnv("CALLBACK_TOKEN");
	const agentUrl = process.env.AGENT_URL || "http://127.0.0.1:5799";
	const cwd = process.env.CWD || "";
	const promptJson = process.env.PROMPT_JSON || "";
	const callbackTimeoutMs = intEnv("CALLBACK_TIMEOUT_MS", CALLBACK_TIMEOUT_MS);
	const callbackMaxAttempts = intEnv(
		"CALLBACK_MAX_ATTEMPTS",
		CALLBACK_MAX_ATTEMPTS
	);
	const flushIntervalMs = intEnv("FLUSH_INTERVAL_MS", FLUSH_INTERVAL_MS);
	const maxBatchSize = intEnv("MAX_BATCH_SIZE", MAX_BATCH_SIZE);
	const promptWatchdogMs = intEnv("PROMPT_WATCHDOG_MS", 60_000);
	const rawPromptResponseTimeoutMs = intEnv(
		"RAW_PROMPT_RESPONSE_TIMEOUT_MS",
		10 * 60_000
	);

	if (!promptJson) {
		throw new Error("Missing PROMPT_JSON env var");
	}
	const prompt = JSON.parse(promptJson);
	if (!Array.isArray(prompt)) {
		throw new Error("PROMPT_JSON must parse to an array");
	}

	log("log", "starting", { turnId, sessionId, agent, agentUrl, callbackUrl });

	let sequence = 0;
	let callbackChain = Promise.resolve();
	let flushTimer = null;
	let eventIndex = 0;
	let agentSessionId = null;
	const sessionRequestIds = new Set();
	const newSessionRequestIds = new Set();
	const pendingPermissionRequestIds = new Set();
	const pendingRawPromptResponseResolvers = new Map();
	const connectionId = `corp-turn-runner-${turnId}-${crypto.randomUUID()}`;
	const eventBuffer = [];

	const waitForPromptResponseEnvelope = (requestId, timeoutMs) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingRawPromptResponseResolvers.delete(requestId);
				reject(
					new Error(
						`Timed out waiting for raw prompt response envelope for request ${requestId}`
					)
				);
			}, timeoutMs);

			pendingRawPromptResponseResolvers.set(requestId, (envelope) => {
				clearTimeout(timer);
				resolve(envelope);
			});
		});
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

	const flushBufferedEvents = async () => {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		while (eventBuffer.length > 0) {
			const batch = eventBuffer.splice(0, maxBatchSize);
			try {
				await queueCallback("events", { events: batch });
			} catch (error) {
				eventBuffer.unshift(...batch);
				log("warn", "event flush failed, batch re-queued", {
					batchSize: batch.length,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		}
	};

	const scheduleFlush = () => {
		if (eventBuffer.length >= maxBatchSize) {
			flushBufferedEvents().catch(() => undefined);
			return;
		}
		if (flushTimer) {
			return;
		}
		flushTimer = setTimeout(() => {
			flushTimer = null;
			flushBufferedEvents().catch(() => undefined);
		}, flushIntervalMs);
	};

	const pushSessionEnvelope = (envelope, direction) => {
		let scoped = false;
		const method = envelopeMethod(envelope);
		const id = envelopeId(envelope);
		const params = envelopeParams(envelope);
		const result = envelopeResult(envelope);
		const error = envelopeError(envelope);

		if (method) {
			if (method === "session/new") {
				scoped = true;
				if (id) {
					newSessionRequestIds.add(id);
				}
			} else {
				const envelopeSessionId = sessionIdFromRecord(params);
				if (agentSessionId && envelopeSessionId === agentSessionId) {
					scoped = true;
					if (id) {
						sessionRequestIds.add(id);
					}
				}
			}
		} else if (id) {
			if (newSessionRequestIds.has(id)) {
				newSessionRequestIds.delete(id);
				const sessionIdFromResult = sessionIdFromRecord(result);
				if (sessionIdFromResult) {
					agentSessionId = sessionIdFromResult;
				}
				scoped = true;
			} else if (sessionRequestIds.has(id)) {
				sessionRequestIds.delete(id);
				scoped = true;
			}
		}

		if (!scoped) {
			return;
		}

		if (method === "session/request_permission") {
			const permissionOptions = summarizePermissionOptions(params?.options);
			const toolCall = summarizeToolCall(params?.toolCall);
			log("log", "permission request envelope observed", {
				direction,
				id,
				envelopeSessionId: sessionIdFromRecord(params),
				options: permissionOptions,
				toolCall,
			});
			if (direction === "inbound" && id) {
				pendingPermissionRequestIds.add(id);
			}
		} else if (id && pendingPermissionRequestIds.has(id)) {
			const permissionOutcome = asRecord(result?.outcome);
			log("log", "permission response envelope observed", {
				direction,
				id,
				hasResult: !!result,
				hasError: !!error,
				errorCode: typeof error?.code === "number" ? error.code : null,
				errorMessage:
					typeof error?.message === "string" ? error.message : null,
				outcome:
					typeof permissionOutcome?.outcome === "string"
						? permissionOutcome.outcome
						: null,
				optionId:
					typeof permissionOutcome?.optionId === "string"
						? permissionOutcome.optionId
						: null,
			});
			if (direction === "outbound") {
				pendingPermissionRequestIds.delete(id);
			}
		}

		eventIndex += 1;
		eventBuffer.push({
			id: crypto.randomUUID(),
			eventIndex,
			sessionId,
			createdAt: Date.now(),
			connectionId,
			sender: direction === "outbound" ? "client" : "agent",
			payload: clonePayload(envelope),
		});
		scheduleFlush();
	};

	const acpPath = `/v1/acp/${encodeURIComponent(connectionId)}`;
	const acp = new AcpHttpClient({
		baseUrl: agentUrl,
		fetch: async (input, init) => {
			const method = init?.method ?? "GET";
			const url = typeof input === "string" ? input : input.toString();
			const startedAt = Date.now();
			try {
				const response = await fetch(input, init);
				const elapsedMs = Date.now() - startedAt;
				if (url.includes(acpPath) && (method !== "GET" || !response.ok)) {
					const bodyText = !response.ok
						? await response
								.clone()
								.text()
								.catch(() => "")
						: "";
					log("log", "acp transport response", {
						method,
						url,
						status: response.status,
						ok: response.ok,
						elapsedMs,
						bodyText: bodyText || null,
					});
				}
				return response;
			} catch (error) {
				log("error", "acp transport request failed", {
					method,
					url,
					elapsedMs: Date.now() - startedAt,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
		transport: {
			path: acpPath,
			bootstrapQuery: { agent },
		},
		onEnvelope: (envelope, direction) => {
			const summary = summarizeEnvelope(envelope);
			if (
				direction === "inbound" &&
				!summary.method &&
				summary.id &&
				pendingRawPromptResponseResolvers.has(summary.id)
			) {
				const resolvePrompt = pendingRawPromptResponseResolvers.get(summary.id);
				pendingRawPromptResponseResolvers.delete(summary.id);
				resolvePrompt(envelope);
				log("log", "raw prompt response envelope resolved", {
					id: summary.id,
					hasError: summary.hasError,
					errorCode: summary.errorCode,
					errorMessage: summary.errorMessage,
				});
			}
			if (
				summary.method === "session/request_permission" ||
				(summary.id && pendingPermissionRequestIds.has(summary.id)) ||
				summary.hasError
			) {
				log("log", "acp envelope observed", {
					direction,
					...summary,
				});
			}
			pushSessionEnvelope(envelope, direction);
		},
		client: {
			requestPermission: async (request) => {
				try {
					const requestRecord = asRecord(request);
					const options = Array.isArray(requestRecord?.options)
						? requestRecord.options
						: [];
					const selected = selectAllowPermissionOption(options);
					const toolCall = asRecord(requestRecord?.toolCall);

					log("log", "requestPermission callback invoked", {
						sessionId: requestRecord?.sessionId ?? null,
						options: summarizePermissionOptions(options),
						toolCall: summarizeToolCall(toolCall),
					});

					if (selected) {
						const response = {
							outcome: {
								outcome: "selected",
								optionId: selected.optionId,
							},
						};
						log("log", "auto-approved permission request", {
							sessionId: requestRecord?.sessionId ?? null,
							toolKind:
								typeof toolCall?.kind === "string" ? toolCall.kind : null,
							toolTitle:
								typeof toolCall?.title === "string" ? toolCall.title : null,
							selectedKind: selected.kind,
							selectedName:
								typeof selected.name === "string" ? selected.name : null,
							selectedOptionId: selected.optionId,
							response,
						});
						return response;
					}

					const response = {
						outcome: {
							outcome: "cancelled",
						},
					};
					log("warn", "permission request had no allow option; cancelling", {
						sessionId: requestRecord?.sessionId ?? null,
						optionKinds: options
							.map((option) =>
								asRecord(option) && typeof option.kind === "string"
									? option.kind
									: null
							)
							.filter((kind) => kind !== null),
						toolKind: typeof toolCall?.kind === "string" ? toolCall.kind : null,
						toolTitle:
							typeof toolCall?.title === "string" ? toolCall.title : null,
						response,
					});
					return response;
				} catch (error) {
					log("error", "requestPermission callback failed", formatError(error));
					throw error;
				}
			},
			sessionUpdate: async () => {
				// Session updates are captured from onEnvelope.
			},
		},
	});

	let exited = false;

	const onExit = async () => {
		if (exited) {
			return;
		}
		exited = true;
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		await acp.disconnect().catch(() => undefined);
	};

	try {
		await acp.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientInfo: {
				name: "corp-turn-runner",
				version: "v1",
			},
		});

		const created = await acp.newSession({
			cwd: cwd || "/",
			mcpServers: [],
		});
		agentSessionId = created.sessionId;
		if (!agentSessionId) {
			throw new Error("session/new did not return a sessionId");
		}

		log("log", "prompt request starting", {
			agentSessionId,
			promptItems: prompt.length,
		});
		const promptWatchdog = setTimeout(() => {
			log("warn", "prompt still pending", {
				agentSessionId,
				pendingPermissionRequestIds: Array.from(pendingPermissionRequestIds),
			});
		}, promptWatchdogMs);
		await sendPromptViaRawAcp({
			agentUrl,
			acpPath,
			sessionId: agentSessionId,
			prompt,
			waitForPromptResponseEnvelope,
			promptResponseTimeoutMs: rawPromptResponseTimeoutMs,
		}).finally(() => clearTimeout(promptWatchdog));
		log("log", "prompt request completed", { agentSessionId });

		await flushBufferedEvents();
		await queueCallback("completed");
		await callbackChain;
		log("log", "completed", { turnId });
	} catch (error) {
		log("error", "turn failed", formatError(error));
		await flushBufferedEvents().catch(() => undefined);
		await queueCallback("failed", {
			error: formatError(error),
		}).catch(() => undefined);
		await callbackChain.catch(() => undefined);
		process.exitCode = 1;
	} finally {
		await onExit();
	}
}

await main();
