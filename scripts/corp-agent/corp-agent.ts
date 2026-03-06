#!/usr/bin/env bun
/* global Bun */

/**
 * corp-agent — compiled Bun binary that runs inside E2B sandboxes.
 *
 * Responsibilities:
 *   1. HTTP server on a configurable port (default 5799)
 *      - GET  /v1/health
 *      - POST /v1/prompt
 *   2. ACP JSON-RPC bridge: spawns an agent subprocess and communicates
 *      via stdin/stdout using newline-delimited JSON (ndjson).
 *   3. Streams session events back to the actor via ordered HTTP callbacks.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import {
	type PromptRequestBody,
	promptRequestBodySchema,
	type SessionEvent,
	turnRunnerCallbackPayloadSchema,
} from "@corporation/shared/session-protocol";

declare const Bun: typeof import("bun");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_PATH = "/tmp/corp-agent.log";
const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });

function log(level: "info" | "warn" | "error", msg: string, data?: unknown) {
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		msg,
		...(data !== undefined ? { data } : {}),
	});
	logStream.write(`${line}\n`);
	if (level === "error") {
		console.error(`[corp-agent] ${msg}`, data ?? "");
	}
}

// ---------------------------------------------------------------------------
// Agent process registry
// ---------------------------------------------------------------------------

const AGENT_NPX_PACKAGES: Record<string, string> = {
	claude: "@zed-industries/claude-code-acp",
	codex: "@zed-industries/codex-acp",
	pi: "pi-acp",
	cursor: "@blowmage/cursor-agent-acp",
};

function agentCommand(agent: string): string[] {
	if (agent === "opencode") {
		return ["opencode", "acp"];
	}
	if (agent === "amp") {
		return ["amp-acp"];
	}

	const pkg = AGENT_NPX_PACKAGES[agent];
	if (!pkg) {
		throw new Error(`Unknown agent: ${agent}`);
	}
	return ["npx", "-y", pkg];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACP_PROTOCOL_VERSION = 1;
const ACP_REQUEST_TIMEOUT_MS = 10 * 60_000;
const CALLBACK_TIMEOUT_MS = 10_000;
const CALLBACK_MAX_ATTEMPTS = 8;

function formatError(error: unknown): {
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

function pickPermissionOption(
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

async function postJsonWithRetry(
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

// ---------------------------------------------------------------------------
// ACP stdio bridge
// ---------------------------------------------------------------------------

type StdioBridge = {
	dead: boolean;
	onNotification: ((envelope: Record<string, unknown>) => void) | null;
	pendingResolvers: Map<string, (envelope: Record<string, unknown>) => void>;
	proc: ReturnType<typeof Bun.spawn>;
};

function spawnStdioBridge(
	agent: string,
	onNotification: (envelope: Record<string, unknown>) => void
): StdioBridge {
	const cmd = agentCommand(agent);
	log("info", "Spawning agent command (stdio)", { cmd: cmd.join(" ") });

	const proc = Bun.spawn(cmd, {
		env: { ...process.env },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	const bridge: StdioBridge = {
		proc,
		pendingResolvers: new Map(),
		onNotification,
		dead: false,
	};

	if (proc.stdout) {
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: stdio parser handles framing + request/notification routing.
		(async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					buffer += decoder.decode(value, { stream: true });

					let newlineIdx = buffer.indexOf("\n");
					while (newlineIdx !== -1) {
						const line = buffer.slice(0, newlineIdx).trim();
						buffer = buffer.slice(newlineIdx + 1);

						if (!line) {
							continue;
						}

						try {
							const envelope = JSON.parse(line) as Record<string, unknown>;
							const envId = envelope.id != null ? String(envelope.id) : null;

							if (envId && bridge.pendingResolvers.has(envId)) {
								const resolver = bridge.pendingResolvers.get(envId);
								bridge.pendingResolvers.delete(envId);
								if (resolver) {
									resolver(envelope);
								}
							} else {
								bridge.onNotification?.(envelope);
							}
						} catch {
							log("warn", "Failed to parse agent stdout line", {
								line: line.slice(0, 200),
							});
						}

						newlineIdx = buffer.indexOf("\n");
					}
				}
			} catch {
				// stream ended
			}
			bridge.dead = true;
			log("info", "Agent stdout stream ended");
		})();
	}

	if (proc.stderr) {
		const reader = proc.stderr.getReader();
		const decoder = new TextDecoder();
		(async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					const text = decoder.decode(value, { stream: true });
					for (const line of text.split("\n")) {
						if (line.trim()) {
							log("info", `[${agent} stderr] ${line.trimEnd()}`);
						}
					}
				}
			} catch {
				// process exited
			}
		})();
	}

	return bridge;
}

function stdioWrite(
	bridge: StdioBridge,
	envelope: Record<string, unknown>
): void {
	bridge.proc.stdin.write(`${JSON.stringify(envelope)}\n`);
}

async function stdioRequest(
	bridge: StdioBridge,
	method: string,
	params: unknown,
	timeoutMs: number = ACP_REQUEST_TIMEOUT_MS
): Promise<Record<string, unknown>> {
	const id = `${method}-${crypto.randomUUID()}`;
	const envelope: Record<string, unknown> = {
		jsonrpc: "2.0",
		id,
		method,
		params,
	};

	const responsePromise = new Promise<Record<string, unknown>>(
		(resolve, reject) => {
			const timer = setTimeout(() => {
				bridge.pendingResolvers.delete(id);
				reject(new Error(`ACP request timed out: ${method} (${id})`));
			}, timeoutMs);

			bridge.pendingResolvers.set(id, (result) => {
				clearTimeout(timer);
				resolve(result);
			});
		}
	);

	stdioWrite(bridge, envelope);
	const result = await responsePromise;

	if ("error" in result) {
		const err = result.error as Record<string, unknown>;
		throw new Error(
			`ACP error (${err.code}): ${err.message ?? JSON.stringify(err)}`
		);
	}

	return (result.result as Record<string, unknown>) ?? {};
}

function killBridge(bridge: StdioBridge): void {
	bridge.dead = true;
	try {
		bridge.proc.stdin.end();
	} catch {
		// ignore
	}
	try {
		bridge.proc.kill();
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

async function executeTurn(params: PromptRequestBody): Promise<void> {
	const {
		turnId,
		sessionId,
		agent,
		modelId,
		prompt,
		cwd,
		callbackUrl,
		callbackToken,
	} = params;

	log("info", "executeTurn started", {
		turnId,
		sessionId,
		agent,
		modelId,
		cwd,
		callbackUrl,
	});

	const connectionId = `corp-agent-${turnId}-${crypto.randomUUID()}`;
	let eventIndex = 0;
	let sequence = 0;
	let callbackChain = Promise.resolve();
	let callbackDeliveryBroken = false;
	let callbackDeliveryError: unknown = null;
	let droppedEventCallbacks = 0;
	let hasLoggedDroppedEvents = false;

	const sendCallback = (
		kind: string,
		extra: Record<string, unknown> = {},
		options: { force?: boolean } = {}
	): Promise<void> => {
		if (callbackDeliveryBroken && !options.force) {
			return Promise.reject(
				new Error("Callback delivery unavailable after prior failure")
			);
		}

		sequence += 1;
		const payload = turnRunnerCallbackPayloadSchema.parse({
			turnId,
			sessionId,
			token: callbackToken,
			sequence,
			kind,
			timestamp: Date.now(),
			...extra,
		});

		callbackChain = callbackChain
			.catch(() => undefined)
			.then(async () => {
				if (callbackDeliveryBroken && !options.force) {
					throw new Error("Callback delivery unavailable after prior failure");
				}
				try {
					await postJsonWithRetry(
						callbackUrl,
						{ args: [payload] },
						CALLBACK_TIMEOUT_MS,
						CALLBACK_MAX_ATTEMPTS
					);
				} catch (error) {
					if (!callbackDeliveryBroken) {
						callbackDeliveryBroken = true;
						callbackDeliveryError = error;
						log("error", "Callback delivery failed; halting event callbacks", {
							turnId,
							sequence,
							error: formatError(error),
						});
					}
					throw error;
				}
			});

		return callbackChain;
	};

	const queueEnvelopeEvent = (
		envelope: Record<string, unknown>,
		direction: "inbound" | "outbound"
	): void => {
		if (callbackDeliveryBroken) {
			droppedEventCallbacks += 1;
			if (!hasLoggedDroppedEvents) {
				hasLoggedDroppedEvents = true;
				log(
					"warn",
					"Dropping events callbacks after callback delivery failure",
					{
						turnId,
						droppedEventCallbacks,
					}
				);
			}
			return;
		}

		eventIndex += 1;
		const event: SessionEvent = {
			id: crypto.randomUUID(),
			eventIndex,
			sessionId,
			createdAt: Date.now(),
			connectionId,
			sender: direction === "outbound" ? "client" : "agent",
			payload: envelope,
		};
		sendCallback("events", { events: [event] }).catch((error) => {
			log("error", "Failed to queue events callback", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	};

	let bridge: StdioBridge | null = null;

	try {
		log("info", "Spawning agent subprocess", { agent });
		bridge = spawnStdioBridge(agent, (envelope) => {
			queueEnvelopeEvent(envelope, "inbound");

			if (envelope.method === "requestPermission" && envelope.id != null) {
				const reqParams = envelope.params as
					| Record<string, unknown>
					| undefined;
				const request = reqParams?.request as
					| Record<string, unknown>
					| undefined;
				const options = Array.isArray(request?.options) ? request.options : [];
				const selected = pickPermissionOption(options);

				const response: Record<string, unknown> = {
					jsonrpc: "2.0",
					id: envelope.id,
					result: {
						outcome: selected
							? { outcome: "selected", optionId: selected.optionId }
							: { outcome: "cancelled" },
					},
				};
				if (bridge) {
					stdioWrite(bridge, response);
					queueEnvelopeEvent(response, "outbound");
				}
			}
		});
		activeTurns.set(turnId, bridge);

		await new Promise((r) => setTimeout(r, 250));
		if (bridge.proc.exitCode !== null) {
			throw new Error(
				`Agent ${agent} exited immediately with code ${bridge.proc.exitCode}`
			);
		}

		const initEnvelope = {
			jsonrpc: "2.0" as const,
			id: `initialize-${crypto.randomUUID()}`,
			method: "initialize",
			params: {
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientInfo: { name: "corp-agent", version: "v1" },
			},
		};
		queueEnvelopeEvent(initEnvelope, "outbound");
		await stdioRequest(bridge, "initialize", {
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientInfo: { name: "corp-agent", version: "v1" },
		});

		const sessionResult = await stdioRequest(bridge, "session/new", {
			cwd,
			mcpServers: [],
		});
		const agentSessionId = sessionResult.sessionId as string;
		if (!agentSessionId) {
			throw new Error("session/new did not return a sessionId");
		}

		if (modelId) {
			try {
				await stdioRequest(bridge, "session/set_model", {
					sessionId: agentSessionId,
					modelId,
				});
			} catch (error) {
				log("warn", "session/set_model not supported, skipping", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const promptEnvelope: Record<string, unknown> = {
			jsonrpc: "2.0",
			method: "session/prompt",
			params: { sessionId: agentSessionId, prompt },
		};
		queueEnvelopeEvent(promptEnvelope, "outbound");

		const promptResult = await stdioRequest(bridge, "session/prompt", {
			sessionId: agentSessionId,
			prompt,
		});

		if ("error" in promptResult) {
			throw new Error(`Prompt ACP error: ${JSON.stringify(promptResult)}`);
		}

		if (callbackDeliveryBroken) {
			throw new Error(
				`Callback delivery failed before completion: ${
					callbackDeliveryError instanceof Error
						? callbackDeliveryError.message
						: String(callbackDeliveryError)
				}`
			);
		}

		await sendCallback("completed");
		await callbackChain.catch(() => undefined);
	} catch (error) {
		await sendCallback(
			"failed",
			{ error: formatError(error) },
			{ force: true }
		).catch((callbackError) => {
			log("error", "Failed to deliver terminal failed callback", {
				turnId,
				error: formatError(callbackError),
			});
		});
		await callbackChain.catch(() => undefined);
		log("error", "Turn failed", { turnId, error: formatError(error) });
	} finally {
		if (bridge) {
			killBridge(bridge);
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 5799;
const DEFAULT_HOST = "0.0.0.0";

function parseArgs(): { host: string; port: number } {
	const args = process.argv.slice(2);
	let host = DEFAULT_HOST;
	let port = DEFAULT_PORT;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--host" && args[i + 1]) {
			host = args[i + 1];
			i++;
		} else if (args[i] === "--port" && args[i + 1]) {
			port = Number.parseInt(args[i + 1], 10);
			i++;
		}
	}

	return { host, port };
}

const { host, port } = parseArgs();
const activeTurns = new Map<string, StdioBridge | null>();

Bun.serve({
	hostname: host,
	port,
	async fetch(req) {
		const url = new URL(req.url);

		if (req.method === "GET" && url.pathname === "/v1/health") {
			return Response.json({ status: "ok" });
		}

		if (req.method === "POST" && url.pathname === "/v1/prompt") {
			let rawBody: unknown;
			try {
				rawBody = await req.json();
			} catch {
				return Response.json({ error: "Invalid JSON body" }, { status: 400 });
			}

			const result = promptRequestBodySchema.safeParse(rawBody);
			if (!result.success) {
				return Response.json(
					{ error: `Invalid request: ${result.error.message}` },
					{ status: 400 }
				);
			}
			const body = result.data;

			if (activeTurns.has(body.turnId)) {
				return Response.json(
					{ error: "Turn already in progress" },
					{ status: 409 }
				);
			}

			activeTurns.set(body.turnId, null);
			executeTurn(body)
				.catch((error) => {
					log("error", "Unhandled turn error", {
						turnId: body.turnId,
						error: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => {
					activeTurns.delete(body.turnId);
				});

			return Response.json({ accepted: true }, { status: 202 });
		}

		if (req.method === "DELETE" && url.pathname.startsWith("/v1/prompt/")) {
			const turnId = url.pathname.slice("/v1/prompt/".length);
			const bridge = activeTurns.get(turnId);
			if (bridge === undefined) {
				return Response.json({ error: "Turn not found" }, { status: 404 });
			}
			if (bridge) {
				killBridge(bridge);
			}
			activeTurns.delete(turnId);
			log("info", "Turn cancelled via DELETE", { turnId });
			return Response.json({ cancelled: true });
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
});

log("info", `Listening on ${host}:${port}`);
console.log(`[corp-agent] Listening on ${host}:${port}`);
