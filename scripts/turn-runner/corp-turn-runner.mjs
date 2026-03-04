#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { SandboxAgent } from "sandbox-agent";

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
	const eventBuffer = [];
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

	const sdk = await SandboxAgent.connect({ baseUrl: agentUrl });
	let unsubscribe = null;
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
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		await sdk.dispose().catch(() => undefined);
	};

	try {
		const session = await sdk.resumeOrCreateSession({
			id: sessionId,
			agent,
			sessionInit: cwd ? { cwd, mcpServers: [] } : undefined,
		});

		unsubscribe = session.onEvent((event) => {
			eventBuffer.push(event);
			scheduleFlush();
		});

		await session.prompt(prompt);

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
