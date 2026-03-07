#!/usr/bin/env bun
/* global Bun */

/**
 * sandbox-runtime — compiled Bun binary that runs inside E2B sandboxes.
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

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_PATH = "/tmp/sandbox-runtime.log";
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
		console.error(`[sandbox-runtime] ${msg}`, data ?? "");
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
// Agent config files
// ---------------------------------------------------------------------------

// Agent config files are imported as JSON so they get bundled into the compiled binary.
// To add configs for a new agent, add a JSON file to agent-configs/ and reference it here.
import claudeCodeSettings from "./agent-configs/claude-code-settings.json";

/** Map of agent name → array of { path, content } config files to write before spawning. */
const AGENT_CONFIGS: Record<string, { path: string; content: string }[]> = {
	claude: [
		{
			path: "/root/.claude/settings.json",
			content: JSON.stringify(claudeCodeSettings),
		},
	],
};

function writeAgentConfigs(agent: string): void {
	const configs = AGENT_CONFIGS[agent];
	if (!configs) {
		return;
	}
	for (const { path: filePath, content } of configs) {
		const dir = filePath.substring(0, filePath.lastIndexOf("/"));
		if (dir) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(filePath, content);
		log("info", `Wrote agent config: ${filePath}`);
	}
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
	pendingResolvers: Map<
		string,
		{
			resolve: (envelope: Record<string, unknown>) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>;
	proc: ReturnType<typeof Bun.spawn>;
};

function processLinesFromStream(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
	onClose?: () => void
): void {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const drainBufferedLines = () => {
		let newlineIdx = buffer.indexOf("\n");
		while (newlineIdx !== -1) {
			onLine(buffer.slice(0, newlineIdx));
			buffer = buffer.slice(newlineIdx + 1);
			newlineIdx = buffer.indexOf("\n");
		}
	};

	(async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				drainBufferedLines();
			}
		} catch {
			// stream ended
		} finally {
			buffer += decoder.decode();
			drainBufferedLines();
			if (buffer.length > 0) {
				onLine(buffer);
				buffer = "";
			}
			onClose?.();
		}
	})();
}

function rejectPendingRequests(bridge: StdioBridge, error: Error): void {
	for (const [id, pending] of bridge.pendingResolvers) {
		bridge.pendingResolvers.delete(id);
		clearTimeout(pending.timer);
		pending.reject(error);
	}
}

function routeStdoutEnvelope(
	bridge: StdioBridge,
	envelope: Record<string, unknown>
): void {
	bridge.onEnvelope?.(envelope, "inbound");

	const envId = envelope.id != null ? String(envelope.id) : null;
	if (envId && bridge.pendingResolvers.has(envId)) {
		const pending = bridge.pendingResolvers.get(envId);
		bridge.pendingResolvers.delete(envId);
		if (pending) {
			clearTimeout(pending.timer);
			pending.resolve(envelope);
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

function processStderrLine(agent: string, rawLine: string): void {
	if (!rawLine.trim()) {
		return;
	}
	log("info", `[${agent} stderr] ${rawLine.trimEnd()}`);
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

	// Write agent-specific config files before spawning
	writeAgentConfigs(agent);

	const proc = Bun.spawn(cmd, {
		env: { ...process.env, IS_SANDBOX: "1" },
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
		processLinesFromStream(
			proc.stdout,
			(line) => processStdoutLine(bridge, line),
			() => {
				bridge.dead = true;
				rejectPendingRequests(
					bridge,
					new Error(`Agent ${agent} stdout stream closed`)
				);
			}
		);
	}

	if (proc.stderr) {
		processLinesFromStream(proc.stderr, (line) =>
			processStderrLine(agent, line)
		);
	}

	return bridge;
}

function teardownBridge(
	bridge: StdioBridge,
	context: { agent: string; sessionId: string; reason: string }
): void {
	bridge.dead = true;
	rejectPendingRequests(
		bridge,
		new Error(`Agent bridge torn down: ${context.reason}`)
	);

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
				const pending = bridge.pendingResolvers.get(id);
				if (!pending) {
					return;
				}
				bridge.pendingResolvers.delete(id);
				reject(new Error(`ACP request timed out: ${method} (${id})`));
			}, timeoutMs);

			bridge.pendingResolvers.set(id, {
				resolve,
				reject,
				timer,
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
		clientInfo: { name: "sandbox-runtime", version: "v1" },
	});
	log("info", "ACP initialize result ", {
		sessionId,
		agent,
		initResult: JSON.stringify(initResult),
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
				mcpServers: [
					{
						name: "desktop",
						command: "bun",
						args: ["/usr/local/bin/sandbox-runtime.js", "mcp", "desktop"],
						env: [],
					},
				],
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
		const mcpServers = [
			{
				name: "desktop",
				command: "/usr/local/bin/sandbox-runtime",
				args: ["mcp", "desktop"],
				env: [],
			},
		];
		log("info", "Sending session/new with mcpServers", {
			sessionId,
			cwd,
			mcpServers,
		});
		const sessionResult = await stdioRequest(bridge, "session/new", {
			cwd,
			mcpServers,
		});
		log("info", "session/new result", {
			sessionId,
			sessionResult: JSON.stringify(sessionResult),
		});
		agentSessionId = sessionResult.sessionId as string;
		if (!agentSessionId) {
			throw new Error("session/new did not return a sessionId");
		}
	}

	previousAgentSessionIds.delete(sessionId);

	// Set bypassPermissions mode so MCP servers are auto-approved in ACP mode
	try {
		await stdioRequest(bridge, "session/set_mode", {
			sessionId: agentSessionId,
			modeId: "bypassPermissions",
		});
		log("info", "Set bypassPermissions mode", { sessionId, agentSessionId });
	} catch (error) {
		log("warn", "Failed to set bypassPermissions mode", {
			sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
	}

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
	) => void,
	pendingTurnId: string
): Promise<SessionBridge> {
	log("info", "Spawning new agent subprocess", { agent, sessionId });

	const sessionBridge: SessionBridge = {
		bridge: null as unknown as StdioBridge,
		agentSessionId: "",
		agent,
		cwd,
		modelId,
		activeTurnId: pendingTurnId,
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
		if (
			activeTurns.get(pendingTurnId) !== sessionId ||
			activeSessionTurns.get(sessionId) !== pendingTurnId
		) {
			throw new Error(
				`Turn reservation for ${pendingTurnId} was released before bridge bootstrap completed`
			);
		}

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

function releaseTurnReservation(turnId: string, sessionId: string): void {
	if (activeTurns.get(turnId) === sessionId) {
		activeTurns.delete(turnId);
	}
	if (activeSessionTurns.get(sessionId) === turnId) {
		activeSessionTurns.delete(sessionId);
	}
}

function hasTurnReservation(turnId: string, sessionId: string): boolean {
	return (
		activeTurns.get(turnId) === sessionId &&
		activeSessionTurns.get(sessionId) === turnId
	);
}

function ensureTurnReservation(turnId: string, sessionId: string): boolean {
	if (hasTurnReservation(turnId, sessionId)) {
		return true;
	}
	log("warn", "Skipping executeTurn without matching reservation", {
		turnId,
		sessionId,
	});
	releaseTurnReservation(turnId, sessionId);
	return false;
}

async function maybeSetModel(
	sessionBridge: SessionBridge,
	modelId: string | undefined
): Promise<void> {
	if (sessionBridge.modelId === modelId) {
		return;
	}
	if (modelId) {
		await setModelOrThrow(
			sessionBridge.bridge,
			sessionBridge.agentSessionId,
			modelId
		);
	}
	sessionBridge.modelId = modelId;
}

async function getOrInitSessionBridgeForTurn(params: {
	turnId: string;
	sessionId: string;
	agent: string;
	cwd: string;
	modelId: string | undefined;
	queueEnvelopeEvent: (
		envelope: Record<string, unknown>,
		direction: "inbound" | "outbound"
	) => void;
}): Promise<SessionBridge> {
	const { turnId, sessionId, agent, cwd, modelId, queueEnvelopeEvent } = params;

	const sessionBridge = getSessionBridge(sessionId);
	if (!sessionBridge) {
		return initBridge(
			sessionId,
			agent,
			cwd,
			modelId,
			queueEnvelopeEvent,
			turnId
		);
	}

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

	await maybeSetModel(sessionBridge, modelId);

	log("info", "Reusing existing session bridge", {
		sessionId,
		agentSessionId: sessionBridge.agentSessionId,
	});
	if (sessionBridge.activeTurnId && sessionBridge.activeTurnId !== turnId) {
		throw new Error(
			`Session ${sessionId} is already reserved for turn ${sessionBridge.activeTurnId}`
		);
	}
	sessionBridge.activeTurnId = turnId;
	sessionBridge.onEvent = queueEnvelopeEvent;
	return sessionBridge;
}

function createTurnCallbackDispatcher(params: {
	turnId: string;
	sessionId: string;
	callbackToken: string;
	callbackUrl: string;
	connectionId: string;
}): {
	queueEnvelopeEvent: (
		envelope: Record<string, unknown>,
		direction: "inbound" | "outbound"
	) => void;
	finalizeSuccess: () => Promise<void>;
	finalizeFailure: (error: unknown) => Promise<void>;
	cleanup: () => void;
} {
	const { turnId, sessionId, callbackToken, callbackUrl, connectionId } =
		params;
	let eventIndex = 0;
	let sequence = 0;
	let callbackChain = Promise.resolve();
	let callbackDeliveryBroken = false;
	let callbackDeliveryError: unknown = null;
	let droppedEventCallbacks = 0;
	let hasLoggedDroppedEvents = false;
	let pendingEventBatch: SessionEvent[] = [];
	let pendingEventFlushTimer: ReturnType<typeof setTimeout> | null = null;

	const logEventBatchFlushError = (error: unknown): void => {
		log("error", "Failed to flush events callback batch", {
			turnId,
			error: formatError(error),
		});
	};

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
			flushEventBatch().catch(logEventBatchFlushError);
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
			flushEventBatch().catch(logEventBatchFlushError);
			return;
		}
		scheduleEventBatchFlush();
	};

	const finalizeSuccess = async (): Promise<void> => {
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
	};

	const finalizeFailure = async (error: unknown): Promise<void> => {
		await flushEventBatch({ force: true }).catch(logEventBatchFlushError);
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
	};

	const cleanup = (): void => {
		clearPendingEventFlushTimer();
		pendingEventBatch = [];
	};

	return {
		queueEnvelopeEvent,
		finalizeSuccess,
		finalizeFailure,
		cleanup,
	};
}

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
	if (!ensureTurnReservation(turnId, sessionId)) {
		return;
	}

	const callbacks = createTurnCallbackDispatcher({
		turnId,
		sessionId,
		callbackToken,
		callbackUrl,
		connectionId: `sandbox-runtime-${turnId}-${crypto.randomUUID()}`,
	});
	let sessionBridge: SessionBridge | null = null;

	try {
		sessionBridge = await getOrInitSessionBridgeForTurn({
			turnId,
			sessionId,
			agent,
			cwd,
			modelId,
			queueEnvelopeEvent: callbacks.queueEnvelopeEvent,
		});

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

		await callbacks.finalizeSuccess();
	} catch (error) {
		await callbacks.finalizeFailure(error);
		log("error", "Turn failed", { turnId, error: formatError(error) });
	} finally {
		callbacks.cleanup();
		if (sessionBridge) {
			if (sessionBridge.activeTurnId === turnId) {
				sessionBridge.activeTurnId = null;
			}
			sessionBridge.onEvent = null;
		}
		releaseTurnReservation(turnId, sessionId);
	}
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Subcommand routing: `sandbox-runtime mcp desktop` starts the desktop MCP server
// ---------------------------------------------------------------------------

const subcommand = process.argv[2];
if (subcommand === "mcp") {
	const mcpName = process.argv[3];
	if (mcpName === "desktop") {
		const { runDesktopMcp } = await import("./desktop-mcp");
		await runDesktopMcp();
		// Keep the process alive — StdioServerTransport reads from stdin
		// but server.connect() returns immediately. Block here so we don't
		// fall through to the HTTP server code below.
		// biome-ignore lint/suspicious/noEmptyBlockStatements: intentionally block forever
		await new Promise(() => {});
	} else {
		console.error(`Unknown MCP server: ${mcpName}`);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// HTTP server (default mode)
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
const activeSessionTurns = new Map<string, string>(); // sessionId -> turnId

async function parsePromptBody(
	req: Request
): Promise<{ body: PromptRequestBody } | { errorResponse: Response }> {
	let rawBody: unknown;
	try {
		rawBody = await req.json();
	} catch {
		return {
			errorResponse: Response.json(
				{ error: "Invalid JSON body" },
				{ status: 400 }
			),
		};
	}

	const result = promptRequestBodySchema.safeParse(rawBody);
	if (!result.success) {
		return {
			errorResponse: Response.json(
				{ error: `Invalid request: ${result.error.message}` },
				{ status: 400 }
			),
		};
	}
	return { body: result.data };
}

function reserveTurn(body: PromptRequestBody): Response | null {
	if (activeTurns.has(body.turnId)) {
		return Response.json(
			{ error: "Turn already in progress" },
			{ status: 409 }
		);
	}
	if (activeSessionTurns.has(body.sessionId)) {
		return Response.json(
			{ error: "Session already has an active turn" },
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

	activeTurns.set(body.turnId, body.sessionId);
	activeSessionTurns.set(body.sessionId, body.turnId);
	if (existingBridge) {
		existingBridge.activeTurnId = body.turnId;
	}

	return null;
}

async function handlePromptRequest(req: Request): Promise<Response> {
	const parsed = await parsePromptBody(req);
	if ("errorResponse" in parsed) {
		return parsed.errorResponse;
	}

	const { body } = parsed;
	const reservationError = reserveTurn(body);
	if (reservationError) {
		return reservationError;
	}

	executeTurn(body).catch((error) => {
		log("error", "Unhandled turn error", {
			turnId: body.turnId,
			error: error instanceof Error ? error.message : String(error),
		});
	});

	return Response.json({ accepted: true }, { status: 202 });
}

function handleTurnCancel(pathname: string): Response {
	const turnId = pathname.slice("/v1/prompt/".length);
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

function handleRequest(req: Request): Response | Promise<Response> {
	const url = new URL(req.url);
	// TODO(auth): Require authentication for sandbox-runtime HTTP routes
	// (at minimum `/v1/prompt` and `/v1/prompt/:turnId`).

	if (req.method === "GET" && url.pathname === "/v1/health") {
		return Response.json({ status: "ok" });
	}
	if (req.method === "POST" && url.pathname === "/v1/prompt") {
		return handlePromptRequest(req);
	}
	if (req.method === "DELETE" && url.pathname.startsWith("/v1/prompt/")) {
		return handleTurnCancel(url.pathname);
	}
	return Response.json({ error: "Not found" }, { status: 404 });
}

Bun.serve({
	hostname: host,
	port,
	fetch: handleRequest,
});

log("info", `Listening on ${host}:${port}`);
console.log(`[sandbox-runtime] Listening on ${host}:${port}`);
