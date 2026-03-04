#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { SandboxAgent } from "sandbox-agent";

const DEFAULT_AGENT_URL = "http://127.0.0.1:5799";
const DEFAULT_CALLBACK_MODE = "rivet-action";
const DEFAULT_FLUSH_INTERVAL_MS = 75;
const DEFAULT_MAX_BATCH_SIZE = 10;
const DEFAULT_CALLBACK_TIMEOUT_MS = 10_000;
const DEFAULT_CALLBACK_MAX_ATTEMPTS = 8;
const RUNNER_LOG_PREFIX = "[corp-turn-runner]";
const RUNNER_LOG_FILE = "/tmp/corp-turn-runner.log";

function tryWriteRunnerLogLine(line) {
	try {
		appendFileSync(RUNNER_LOG_FILE, `${line}\n`, "utf8");
	} catch {
		// Best-effort file logging; stdout/stderr remains the source of truth.
	}
}

function safeSerialize(data) {
	try {
		return JSON.stringify(data);
	} catch (error) {
		return JSON.stringify({
			serializationError:
				error instanceof Error ? error.message : String(error),
		});
	}
}

function formatUnhandledReason(reason) {
	if (reason instanceof Error) {
		return {
			name: reason.name,
			message: reason.message,
			stack: reason.stack ?? null,
		};
	}
	return {
		name: "UnhandledRejection",
		message: safeSerialize(reason),
		stack: null,
	};
}

function log(message, data) {
	const linePrefix = `${RUNNER_LOG_PREFIX} ${new Date().toISOString()} ${message}`;
	tryWriteRunnerLogLine(
		data === undefined ? linePrefix : `${linePrefix} ${safeSerialize(data)}`
	);
	if (data !== undefined) {
		console.log(linePrefix, data);
		return;
	}
	console.log(linePrefix);
}

function warn(message, data) {
	const linePrefix = `${RUNNER_LOG_PREFIX} ${new Date().toISOString()} ${message}`;
	tryWriteRunnerLogLine(
		data === undefined ? linePrefix : `${linePrefix} ${safeSerialize(data)}`
	);
	if (data !== undefined) {
		console.warn(linePrefix, data);
		return;
	}
	console.warn(linePrefix);
}

function errorLog(message, data) {
	const linePrefix = `${RUNNER_LOG_PREFIX} ${new Date().toISOString()} ${message}`;
	tryWriteRunnerLogLine(
		data === undefined ? linePrefix : `${linePrefix} ${safeSerialize(data)}`
	);
	if (data !== undefined) {
		console.error(linePrefix, data);
		return;
	}
	console.error(linePrefix);
}

function printHelp() {
	console.log(`corp-turn-runner

Required:
  --turn-id / TURN_ID
  --session-id / SESSION_ID
  --agent / AGENT
  --callback-url / CALLBACK_URL
  --callback-token / CALLBACK_TOKEN
  --prompt / PROMPT (or --prompt-json / PROMPT_JSON)

Optional:
  --model-id / MODEL_ID
  --cwd / CWD (session init cwd)
  --agent-url / AGENT_URL (default: ${DEFAULT_AGENT_URL})
  --callback-mode / CALLBACK_MODE (rivet-action | raw, default: ${DEFAULT_CALLBACK_MODE})
  --flush-interval-ms / FLUSH_INTERVAL_MS (default: ${DEFAULT_FLUSH_INTERVAL_MS})
  --max-batch-size / MAX_BATCH_SIZE (default: ${DEFAULT_MAX_BATCH_SIZE})
  --callback-timeout-ms / CALLBACK_TIMEOUT_MS (default: ${DEFAULT_CALLBACK_TIMEOUT_MS})
  --callback-max-attempts / CALLBACK_MAX_ATTEMPTS (default: ${DEFAULT_CALLBACK_MAX_ATTEMPTS})
`);
}

function parseCliOptions(argv) {
	const options = new Map();
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token?.startsWith("--")) {
			continue;
		}
		const key = token.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			options.set(key, "true");
			continue;
		}
		options.set(key, next);
		i++;
	}
	return options;
}

function readOption(options, key, envKey, fallback) {
	const cli = options.get(key);
	if (typeof cli === "string" && cli.length > 0) {
		return cli;
	}
	const env = process.env[envKey];
	if (typeof env === "string" && env.length > 0) {
		return env;
	}
	return fallback;
}

function readRequiredOption(options, key, envKey) {
	const value = readOption(options, key, envKey, undefined);
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	throw new Error(`Missing required option --${key} (or ${envKey})`);
}

function readIntegerOption(options, key, envKey, fallback) {
	const value = readOption(options, key, envKey, String(fallback));
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new Error(`Invalid integer for --${key}: ${value}`);
	}
	return parsed;
}

function parsePrompt(promptJson, promptText) {
	if (promptJson) {
		const parsed = JSON.parse(promptJson);
		if (!Array.isArray(parsed)) {
			throw new Error("--prompt-json must parse to an array");
		}
		return parsed;
	}
	if (!promptText || promptText.trim().length === 0) {
		throw new Error("Missing prompt text: provide --prompt or --prompt-json");
	}
	return [{ type: "text", text: promptText }];
}

function formatError(error) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack ?? null,
		};
	}
	return {
		name: "Error",
		message: String(error),
		stack: null,
	};
}

async function postJsonWithRetry(url, body, timeoutMs, maxAttempts) {
	let attempt = 0;
	let delayMs = 250;

	while (true) {
		attempt += 1;
		try {
			log("callback: POST attempt", {
				attempt,
				maxAttempts,
				timeoutMs,
				kind: body?.args?.[0]?.kind ?? body?.kind ?? "unknown",
				sequence: body?.args?.[0]?.sequence ?? body?.sequence ?? null,
			});
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) {
				const responseText = await response.text().catch(() => "");
				throw new Error(
					`Callback failed (${response.status} ${response.statusText}): ${responseText}`
				);
			}
			log("callback: POST success", {
				attempt,
				kind: body?.args?.[0]?.kind ?? body?.kind ?? "unknown",
				sequence: body?.args?.[0]?.sequence ?? body?.sequence ?? null,
			});
			return;
		} catch (error) {
			warn("callback: POST failed", {
				attempt,
				maxAttempts,
				delayMs,
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

async function main() {
	process.on("unhandledRejection", (reason) => {
		errorLog("process: unhandledRejection", formatUnhandledReason(reason));
	});

	const options = parseCliOptions(process.argv.slice(2));
	if (options.has("help") || options.has("h")) {
		printHelp();
		return;
	}

	const callbackMode = readOption(
		options,
		"callback-mode",
		"CALLBACK_MODE",
		DEFAULT_CALLBACK_MODE
	);
	if (callbackMode !== "rivet-action" && callbackMode !== "raw") {
		throw new Error(
			`Invalid callback mode '${callbackMode}'. Supported: rivet-action, raw`
		);
	}

	const turnId = readRequiredOption(options, "turn-id", "TURN_ID");
	const sessionId = readRequiredOption(options, "session-id", "SESSION_ID");
	const agent = readRequiredOption(options, "agent", "AGENT");
	const callbackUrl = readRequiredOption(
		options,
		"callback-url",
		"CALLBACK_URL"
	);
	const callbackToken = readRequiredOption(
		options,
		"callback-token",
		"CALLBACK_TOKEN"
	);

	const agentUrl = readOption(
		options,
		"agent-url",
		"AGENT_URL",
		DEFAULT_AGENT_URL
	);
	const promptText = readOption(options, "prompt", "PROMPT", "");
	const promptJson = readOption(options, "prompt-json", "PROMPT_JSON", "");
	const modelId = readOption(options, "model-id", "MODEL_ID", "");
	const cwd = readOption(options, "cwd", "CWD", "");
	const callbackTimeoutMs = readIntegerOption(
		options,
		"callback-timeout-ms",
		"CALLBACK_TIMEOUT_MS",
		DEFAULT_CALLBACK_TIMEOUT_MS
	);
	const callbackMaxAttempts = readIntegerOption(
		options,
		"callback-max-attempts",
		"CALLBACK_MAX_ATTEMPTS",
		DEFAULT_CALLBACK_MAX_ATTEMPTS
	);
	const flushIntervalMs = readIntegerOption(
		options,
		"flush-interval-ms",
		"FLUSH_INTERVAL_MS",
		DEFAULT_FLUSH_INTERVAL_MS
	);
	const maxBatchSize = readIntegerOption(
		options,
		"max-batch-size",
		"MAX_BATCH_SIZE",
		DEFAULT_MAX_BATCH_SIZE
	);

	const prompt = parsePrompt(promptJson, promptText);
	log("main: configuration parsed", {
		turnId,
		sessionId,
		agent,
		modelId: modelId || null,
		agentUrl,
		callbackUrl,
		callbackMode,
		flushIntervalMs,
		maxBatchSize,
		callbackTimeoutMs,
		callbackMaxAttempts,
		promptItems: Array.isArray(prompt) ? prompt.length : null,
		cwd: cwd || null,
	});

	let sequence = 0;
	let callbackChain = Promise.resolve();
	let flushTimer = null;
	const eventBuffer = [];
	const seenEventIds = new Set();
	let lastEventIndex = -1;

	const fireAndForget = (promise, label) => {
		promise.catch((error) => {
			warn(`background ${label} failed`, {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	};

	const queueCallback = (kind, payload = {}) => {
		sequence += 1;
		const normalizedPayload =
			typeof payload.lastEventIndex === "number" && payload.lastEventIndex < 0
				? { ...payload, lastEventIndex: undefined }
				: payload;
		const envelope = {
			turnId,
			sessionId,
			token: callbackToken,
			sequence,
			kind,
			timestamp: Date.now(),
			...normalizedPayload,
		};
		const requestBody =
			callbackMode === "rivet-action" ? { args: [envelope] } : envelope;
		log("callback: queued", {
			kind,
			sequence,
			eventCount: Array.isArray(normalizedPayload.events)
				? normalizedPayload.events.length
				: 0,
			lastEventIndex:
				typeof normalizedPayload.lastEventIndex === "number"
					? normalizedPayload.lastEventIndex
					: null,
		});
		callbackChain = callbackChain
			.catch((error) => {
				warn("callback: recovering queue after previous failure", {
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.then(() =>
				postJsonWithRetry(
					callbackUrl,
					requestBody,
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
		log("events: flush begin", { bufferedEvents: eventBuffer.length });
		while (eventBuffer.length > 0) {
			const batch = eventBuffer.splice(0, maxBatchSize);
			log("events: flushing batch", {
				batchSize: batch.length,
				remainingAfterSplice: eventBuffer.length,
				lastEventIndex,
			});
			await queueCallback("events", {
				events: batch,
				lastEventIndex,
			});
		}
		log("events: flush done");
	};

	const scheduleFlush = () => {
		if (eventBuffer.length >= maxBatchSize) {
			log("events: flush triggered by max batch size", {
				bufferedEvents: eventBuffer.length,
				maxBatchSize,
			});
			fireAndForget(flushBufferedEvents(), "flush");
			return;
		}
		if (flushTimer) {
			log("events: flush already scheduled", {
				bufferedEvents: eventBuffer.length,
			});
			return;
		}
		log("events: scheduling delayed flush", {
			bufferedEvents: eventBuffer.length,
			flushIntervalMs,
		});
		flushTimer = setTimeout(() => {
			flushTimer = null;
			fireAndForget(flushBufferedEvents(), "flush");
		}, flushIntervalMs);
	};

	log("sdk: connecting", { agentUrl });
	const sdk = await SandboxAgent.connect({ baseUrl: agentUrl });
	log("sdk: connected");
	let unsubscribe = null;
	let exited = false;

	const onExit = async () => {
		if (exited) {
			return;
		}
		exited = true;
		log("shutdown: begin");
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		await sdk.dispose().catch(() => undefined);
		log("shutdown: sdk disposed");
	};

	try {
		log("session: resumeOrCreateSession begin", { sessionId, agent });
		const session = await sdk.resumeOrCreateSession({
			id: sessionId,
			agent,
			sessionInit: cwd
				? {
						cwd,
						mcpServers: [],
					}
				: undefined,
		});
		log("session: resumeOrCreateSession success", { sessionId, agent });

		unsubscribe = session.onEvent((event) => {
			try {
				if (seenEventIds.has(event.id)) {
					log("events: duplicate event skipped", {
						eventId: event.id,
						eventIndex: event.eventIndex,
					});
					return;
				}
				seenEventIds.add(event.id);
				lastEventIndex = Math.max(lastEventIndex, event.eventIndex);
				eventBuffer.push(event);
				log("events: received", {
					eventId: event.id,
					eventIndex: event.eventIndex,
					sender: event.sender,
					bufferedEvents: eventBuffer.length,
				});
				scheduleFlush();
			} catch (error) {
				errorLog("events: onEvent handler failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		log("events: subscription attached");

		log("turn: calling session.prompt");
		const response = await session.prompt(prompt);
		log("turn: session.prompt resolved", {
			stopReason:
				response && typeof response.stopReason === "string"
					? response.stopReason
					: null,
		});
		await flushBufferedEvents();
		await queueCallback("completed", {
			stopReason:
				response && typeof response.stopReason === "string"
					? response.stopReason
					: null,
			lastEventIndex,
		});
		await callbackChain;
		log("turn: completed callback chain drained", { lastEventIndex });
	} catch (error) {
		errorLog("turn: failed", {
			error: error instanceof Error ? error.message : String(error),
			lastEventIndex,
		});
		await flushBufferedEvents().catch(() => undefined);
		await queueCallback("failed", {
			error: formatError(error),
			lastEventIndex,
		}).catch(() => undefined);
		await callbackChain.catch(() => undefined);
		errorLog("turn: failed callback sent", {
			error: error instanceof Error ? error.message : String(error),
		});
		process.exitCode = 1;
	} finally {
		await onExit();
		log("main: exit", { exitCode: process.exitCode ?? 0 });
	}
}

await main();
