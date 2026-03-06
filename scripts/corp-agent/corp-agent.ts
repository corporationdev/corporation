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
const EVENT_BATCH_MAX_SIZE = 10;
const EVENT_BATCH_MAX_DELAY_MS = 5;
const AUTH_METHOD_ENV_CANDIDATES: Record<string, string[]> = {
	"anthropic-api-key": ["ANTHROPIC_API_KEY"],
	"codex-api-key": ["CODEX_API_KEY"],
	"openai-api-key": ["OPENAI_API_KEY"],
	"opencode-api-key": ["OPENCODE_API_KEY"],
};

type AuthMethod = { id: string };

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

function extractAuthMethods(initResult: Record<string, unknown>): AuthMethod[] {
	const authMethods = initResult.authMethods;
	if (!Array.isArray(authMethods)) {
		return [];
	}

	return authMethods
		.map((method) => {
			if (!method || typeof method !== "object") {
				return null;
			}
			const methodId = (method as Record<string, unknown>).id;
			if (typeof methodId !== "string" || methodId.length === 0) {
				return null;
			}
			return { id: methodId };
		})
		.filter((method): method is AuthMethod => method !== null);
}

function selectAuthMethod(
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
	onEnvelope:
		| ((
				envelope: Record<string, unknown>,
				direction: "inbound" | "outbound"
		  ) => void)
		| null;
	onNotification: ((envelope: Record<string, unknown>) => void) | null;
	pendingResolvers: Map<string, (envelope: Record<string, unknown>) => void>;
	proc: ReturnType<typeof Bun.spawn>;
};

function routeStdoutEnvelope(
	bridge: StdioBridge,
	envelope: Record<string, unknown>
): void {
	bridge.onEnvelope?.(envelope, "inbound");

	const envId = envelope.id != null ? String(envelope.id) : null;
	if (envId && bridge.pendingResolvers.has(envId)) {
		const resolver = bridge.pendingResolvers.get(envId);
		bridge.pendingResolvers.delete(envId);
		if (resolver) {
			resolver(envelope);
		}
		return;
	}
	bridge.onNotification?.(envelope);
}

function processStdoutLine(bridge: StdioBridge, rawLine: string): void {
	const line = rawLine.trim();
	if (!line) {
		return;
	}

	try {
		const envelope = JSON.parse(line) as Record<string, unknown>;
		routeStdoutEnvelope(bridge, envelope);
	} catch {
		log("warn", "Failed to parse agent stdout line", {
			line: line.slice(0, 200),
		});
	}
}

function spawnStdioBridge(
	agent: string,
	onNotification: (envelope: Record<string, unknown>) => void,
	onEnvelope:
		| ((
				envelope: Record<string, unknown>,
				direction: "inbound" | "outbound"
		  ) => void)
		| null = null
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
		onEnvelope,
		dead: false,
	};

	if (proc.stdout) {
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		(async () => {
			const drainBufferedLines = () => {
				let newlineIdx = buffer.indexOf("\n");
				while (newlineIdx !== -1) {
					processStdoutLine(bridge, buffer.slice(0, newlineIdx));
					buffer = buffer.slice(newlineIdx + 1);
					newlineIdx = buffer.indexOf("\n");
				}
			};

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						buffer += decoder.decode();
						drainBufferedLines();
						if (buffer.trim()) {
							processStdoutLine(bridge, buffer);
							buffer = "";
						}
						break;
					}
					buffer += decoder.decode(value, { stream: true });
					drainBufferedLines();
				}
			} catch {
				// stream ended
			}
			bridge.dead = true;
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

function teardownBridge(
	bridge: StdioBridge,
	context: { agent: string; sessionId: string; reason: string }
): void {
	bridge.dead = true;
	bridge.pendingResolvers.clear();

	try {
		bridge.proc.stdin.end();
	} catch {
		// stdin already closed
	}

	try {
		bridge.proc.stdout?.cancel();
	} catch {
		// stdout already closed
	}

	try {
		bridge.proc.stderr?.cancel();
	} catch {
		// stderr already closed
	}

	try {
		bridge.proc.kill();
	} catch {
		// process may already be gone
	}

	log("info", "Tore down spawned session bridge", context);
}

function stdioWrite(
	bridge: StdioBridge,
	envelope: Record<string, unknown>
): void {
	bridge.onEnvelope?.(envelope, "outbound");
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

// ---------------------------------------------------------------------------
// Persistent session bridges
// ---------------------------------------------------------------------------

type SessionBridge = {
	bridge: StdioBridge;
	agentSessionId: string;
	agent: string;
	cwd: string;
	modelId: string | undefined;
	activeTurnId: string | null;
	onEvent:
		| ((
				envelope: Record<string, unknown>,
				direction: "inbound" | "outbound"
		  ) => void)
		| null;
};

const sessionBridges = new Map<string, SessionBridge>();
// Preserved agentSessionIds from dead bridges, keyed by corporation sessionId.
// Used to attempt session/load when the agent process restarts.
const previousAgentSessionIds = new Map<string, string>();

async function performAuth(
	bridge: StdioBridge,
	agent: string,
	initResult: Record<string, unknown>
): Promise<void> {
	const authMethods = extractAuthMethods(initResult);
	if (authMethods.length === 0) {
		return;
	}
	const selectedAuth = selectAuthMethod(authMethods);
	if (selectedAuth) {
		await stdioRequest(bridge, "authenticate", {
			methodId: selectedAuth.methodId,
		});
		log("info", "ACP authentication succeeded", {
			agent,
			methodId: selectedAuth.methodId,
			envVar: selectedAuth.envVar,
		});
	} else {
		log("info", "ACP auth methods advertised but no env-backed match", {
			agent,
			authMethodIds: authMethods.map((method) => method.id),
		});
	}
}

function maybeHandlePermissionRequest(
	bridge: StdioBridge,
	envelope: Record<string, unknown>
): void {
	if (envelope.method !== "requestPermission" || envelope.id == null) {
		return;
	}

	const reqParams = envelope.params as Record<string, unknown> | undefined;
	const request = reqParams?.request as Record<string, unknown> | undefined;
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
	stdioWrite(bridge, response);
}

function isUnsupportedMethodError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return msg.includes("(-32601)");
}

async function setModelOrThrow(
	bridge: StdioBridge,
	agentSessionId: string,
	modelId: string
): Promise<void> {
	try {
		await stdioRequest(bridge, "session/set_model", {
			sessionId: agentSessionId,
			modelId,
		});
	} catch (error) {
		if (isUnsupportedMethodError(error)) {
			log("warn", "session/set_model not supported by agent, skipping", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		throw error;
	}
}

async function bootstrapSessionBridge(
	bridge: StdioBridge,
	sessionId: string,
	agent: string,
	cwd: string,
	modelId: string | undefined
): Promise<string> {
	await new Promise((r) => setTimeout(r, 250));
	if (bridge.proc.exitCode !== null) {
		throw new Error(
			`Agent ${agent} exited immediately with code ${bridge.proc.exitCode}`
		);
	}

	const initResult = await stdioRequest(bridge, "initialize", {
		protocolVersion: ACP_PROTOCOL_VERSION,
		clientInfo: { name: "corp-agent", version: "v1" },
	});
	await performAuth(bridge, agent, initResult);

	const capabilities = initResult.agentCapabilities as
		| Record<string, unknown>
		| undefined;
	const supportsLoad = capabilities?.loadSession === true;
	const previousAgentSessionId = previousAgentSessionIds.get(sessionId);

	let agentSessionId: string | null = null;

	if (supportsLoad && previousAgentSessionId) {
		try {
			const loadResult = await stdioRequest(bridge, "session/load", {
				sessionId: previousAgentSessionId,
				cwd,
				mcpServers: [],
			});
			agentSessionId =
				(loadResult.sessionId as string) || previousAgentSessionId;
			log("info", "session/load succeeded", { sessionId, agentSessionId });
		} catch (error) {
			log("warn", "session/load failed, falling back to session/new", {
				sessionId,
				previousAgentSessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (!agentSessionId) {
		const sessionResult = await stdioRequest(bridge, "session/new", {
			cwd,
			mcpServers: [],
		});
		agentSessionId = sessionResult.sessionId as string;
		if (!agentSessionId) {
			throw new Error("session/new did not return a sessionId");
		}
	}

	previousAgentSessionIds.delete(sessionId);

	if (modelId) {
		await setModelOrThrow(bridge, agentSessionId, modelId);
	}

	return agentSessionId;
}

async function initBridge(
	sessionId: string,
	agent: string,
	cwd: string,
	modelId: string | undefined,
	queueEnvelopeEvent: (
		envelope: Record<string, unknown>,
		direction: "inbound" | "outbound"
	) => void
): Promise<SessionBridge> {
	log("info", "Spawning new agent subprocess", { agent, sessionId });

	const sessionBridge: SessionBridge = {
		bridge: null as unknown as StdioBridge,
		agentSessionId: "",
		agent,
		cwd,
		modelId,
		activeTurnId: null,
		onEvent: queueEnvelopeEvent,
	};

	const bridge = spawnStdioBridge(
		agent,
		(envelope) => {
			maybeHandlePermissionRequest(bridge, envelope);
		},
		(envelope, direction) => {
			sessionBridge.onEvent?.(envelope, direction);
		}
	);
	sessionBridge.bridge = bridge;
	let bootstrapComplete = false;
	try {
		sessionBridge.agentSessionId = await bootstrapSessionBridge(
			bridge,
			sessionId,
			agent,
			cwd,
			modelId
		);

		sessionBridges.set(sessionId, sessionBridge);
		bootstrapComplete = true;
		return sessionBridge;
	} finally {
		if (!bootstrapComplete) {
			teardownBridge(bridge, {
				agent,
				sessionId,
				reason: "initBridge bootstrap failed before sessionBridges.set",
			});
			sessionBridge.bridge = null as unknown as StdioBridge;
		}
	}
}

function getSessionBridge(sessionId: string): SessionBridge | null {
	const existing = sessionBridges.get(sessionId);
	if (!existing || existing.bridge.dead) {
		if (existing) {
			log("info", "Session bridge dead, discarding", {
				sessionId,
				exitCode: existing.bridge.proc.exitCode,
			});
			previousAgentSessionIds.set(sessionId, existing.agentSessionId);
			sessionBridges.delete(sessionId);
		}
		return null;
	}
	return existing;
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
	let pendingEventBatch: SessionEvent[] = [];
	let pendingEventFlushTimer: ReturnType<typeof setTimeout> | null = null;

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

	const logDroppedEvents = () => {
		if (hasLoggedDroppedEvents) {
			return;
		}
		hasLoggedDroppedEvents = true;
		log("warn", "Dropping events callbacks after callback delivery failure", {
			turnId,
			droppedEventCallbacks,
		});
	};

	const clearPendingEventFlushTimer = () => {
		if (!pendingEventFlushTimer) {
			return;
		}
		clearTimeout(pendingEventFlushTimer);
		pendingEventFlushTimer = null;
	};

	const flushEventBatch = (
		options: { force?: boolean } = {}
	): Promise<void> => {
		clearPendingEventFlushTimer();
		if (pendingEventBatch.length === 0) {
			return Promise.resolve();
		}

		const events = pendingEventBatch;
		pendingEventBatch = [];

		if (callbackDeliveryBroken && !options.force) {
			droppedEventCallbacks += events.length;
			logDroppedEvents();
			return Promise.resolve();
		}

		return sendCallback("events", { events }, options);
	};

	const scheduleEventBatchFlush = (): void => {
		if (pendingEventFlushTimer || pendingEventBatch.length === 0) {
			return;
		}
		pendingEventFlushTimer = setTimeout(() => {
			pendingEventFlushTimer = null;
			flushEventBatch().catch((error) => {
				log("error", "Failed to flush events callback batch", {
					turnId,
					error: formatError(error),
				});
			});
		}, EVENT_BATCH_MAX_DELAY_MS);
	};

	const queueEnvelopeEvent = (
		envelope: Record<string, unknown>,
		direction: "inbound" | "outbound"
	): void => {
		if (callbackDeliveryBroken) {
			droppedEventCallbacks += 1;
			logDroppedEvents();
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
		pendingEventBatch.push(event);
		if (pendingEventBatch.length >= EVENT_BATCH_MAX_SIZE) {
			flushEventBatch().catch((error) => {
				log("error", "Failed to flush events callback batch", {
					turnId,
					error: formatError(error),
				});
			});
			return;
		}
		scheduleEventBatchFlush();
	};

	let sessionBridge: SessionBridge | null = null;

	try {
		sessionBridge = getSessionBridge(sessionId);

		if (sessionBridge) {
			if (sessionBridge.agent !== agent) {
				throw new Error(
					`Cannot reuse session ${sessionId}: agent changed from "${sessionBridge.agent}" to "${agent}"`
				);
			}
			if (sessionBridge.cwd !== cwd) {
				throw new Error(
					`Cannot reuse session ${sessionId}: cwd changed from "${sessionBridge.cwd}" to "${cwd}"`
				);
			}
			if (sessionBridge.modelId !== modelId) {
				const newModelId = modelId;
				if (newModelId) {
					await setModelOrThrow(
						sessionBridge.bridge,
						sessionBridge.agentSessionId,
						newModelId
					);
				}
				sessionBridge.modelId = modelId;
			}
			log("info", "Reusing existing session bridge", {
				sessionId,
				agentSessionId: sessionBridge.agentSessionId,
			});
			sessionBridge.onEvent = queueEnvelopeEvent;
		} else {
			sessionBridge = await initBridge(
				sessionId,
				agent,
				cwd,
				modelId,
				queueEnvelopeEvent
			);
		}

		sessionBridge.activeTurnId = turnId;
		activeTurns.set(turnId, sessionId);

		const promptResult = await stdioRequest(
			sessionBridge.bridge,
			"session/prompt",
			{
				sessionId: sessionBridge.agentSessionId,
				prompt,
			}
		);

		if ("error" in promptResult) {
			throw new Error(`Prompt ACP error: ${JSON.stringify(promptResult)}`);
		}

		await flushEventBatch();

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
		await flushEventBatch({ force: true }).catch((flushError) => {
			log("error", "Failed to flush events callback batch", {
				turnId,
				error: formatError(flushError),
			});
		});
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
		clearPendingEventFlushTimer();
		pendingEventBatch = [];
		if (sessionBridge) {
			sessionBridge.activeTurnId = null;
			sessionBridge.onEvent = null;
		}
		activeTurns.delete(turnId);
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
const activeTurns = new Map<string, string>(); // turnId -> sessionId

Bun.serve({
	hostname: host,
	port,
	async fetch(req) {
		const url = new URL(req.url);
		// TODO(auth): Require authentication for corp-agent HTTP routes
		// (at minimum `/v1/prompt` and `/v1/prompt/:turnId`).

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

			const existingBridge = getSessionBridge(body.sessionId);
			if (existingBridge?.activeTurnId) {
				return Response.json(
					{ error: "Session already has an active turn" },
					{ status: 409 }
				);
			}

			executeTurn(body).catch((error) => {
				log("error", "Unhandled turn error", {
					turnId: body.turnId,
					error: error instanceof Error ? error.message : String(error),
				});
			});

			return Response.json({ accepted: true }, { status: 202 });
		}

		if (req.method === "DELETE" && url.pathname.startsWith("/v1/prompt/")) {
			const turnId = url.pathname.slice("/v1/prompt/".length);
			const sessionId = activeTurns.get(turnId);
			if (sessionId === undefined) {
				return Response.json({ error: "Turn not found" }, { status: 404 });
			}
			const sessionBridge = getSessionBridge(sessionId);
			if (sessionBridge) {
				// Send ACP session/cancel notification — the agent will finish
				// the in-flight session/prompt with a "cancelled" stop reason,
				// preserving the bridge and its history for the next turn.
				const cancelEnvelope: Record<string, unknown> = {
					jsonrpc: "2.0",
					method: "session/cancel",
					params: { sessionId: sessionBridge.agentSessionId },
				};
				stdioWrite(sessionBridge.bridge, cancelEnvelope);
				log("info", "Sent session/cancel to agent", { turnId, sessionId });
			}
			return Response.json({ cancelled: true });
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
});

log("info", `Listening on ${host}:${port}`);
console.log(`[corp-agent] Listening on ${host}:${port}`);
