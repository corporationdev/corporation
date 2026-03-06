#!/usr/bin/env bun

/**
 * corp-agent — compiled Bun binary that runs inside E2B sandboxes.
 *
 * Responsibilities:
 *   1. HTTP server on a configurable port (default 5799)
 *      - GET  /v1/health
 *      - GET  /v1/agents
 *      - POST /v1/prompt
 *   2. ACP JSON-RPC bridge: spawns an agent subprocess, communicates
 *      via stdin/stdout using newline-delimited JSON (ndjson).
 *   3. Streams session events back to a Rivet actor over a persistent
 *      WebSocket connection using the RivetKit client SDK.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { createClient } from "rivetkit/client";

// ---------------------------------------------------------------------------
// Logging — append to /tmp/corp-agent.log for debugging
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
// Types
// ---------------------------------------------------------------------------

type SessionEventSender = "client" | "agent";

interface SessionEvent {
	connectionId: string;
	createdAt: number;
	eventIndex: number;
	id: string;
	payload: Record<string, unknown>;
	sender: SessionEventSender;
	sessionId: string;
}

interface PromptRequestBody {
	actorEndpoint: string;
	actorKey: string[];
	agent: string;
	callbackToken: string;
	cwd: string;
	modelId?: string;
	prompt: Array<{ type: string; text: string }>;
	sessionId: string;
	turnId: string;
}

// ---------------------------------------------------------------------------
// ACP agent process registry — maps agent name → npx package / binary
// ---------------------------------------------------------------------------

// Maps agent name → npx package for npm-based agents
const AGENT_NPX_PACKAGES: Record<string, string> = {
	claude: "@zed-industries/claude-code-acp",
	codex: "@zed-industries/codex-acp",
	pi: "pi-acp",
	cursor: "@blowmage/cursor-agent-acp",
};

function agentCommand(agent: string): string[] {
	// Native binary agents
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

function clonePayload(payload: unknown): Record<string, unknown> {
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

// ---------------------------------------------------------------------------
// ACP stdio bridge — ndjson over stdin/stdout
// ---------------------------------------------------------------------------

const ACP_PROTOCOL_VERSION = 1;
const ACP_REQUEST_TIMEOUT_MS = 10 * 60_000; // 10 minutes

interface StdioBridge {
	dead: boolean;
	onNotification: ((envelope: Record<string, unknown>) => void) | null;
	pendingResolvers: Map<string, (envelope: Record<string, unknown>) => void>;
	proc: ReturnType<typeof Bun.spawn>;
}

/**
 * Spawn an ACP agent subprocess and set up the stdio bridge.
 * The agent reads JSON-RPC from stdin and writes JSON-RPC to stdout,
 * both as newline-delimited JSON.
 */
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

	// Read stdout line-by-line for JSON-RPC messages
	if (proc.stdout) {
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		(async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					buffer += decoder.decode(value, { stream: true });

					// Process complete lines
					let newlineIdx: number;
					while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
						const line = buffer.slice(0, newlineIdx).trim();
						buffer = buffer.slice(newlineIdx + 1);

						if (!line) {
							continue;
						}

						try {
							const envelope = JSON.parse(line) as Record<string, unknown>;
							const envId = envelope.id != null ? String(envelope.id) : null;

							// If it has an id and we have a pending resolver, it's a response
							if (envId && bridge.pendingResolvers.has(envId)) {
								const resolver = bridge.pendingResolvers.get(envId)!;
								bridge.pendingResolvers.delete(envId);
								resolver(envelope);
							} else {
								// It's a notification or unsolicited message
								bridge.onNotification?.(envelope);
							}
						} catch {
							log("warn", "Failed to parse agent stdout line", {
								line: line.slice(0, 200),
							});
						}
					}
				}
			} catch {
				// Stream ended
			}
			bridge.dead = true;
			log("info", "Agent stdout stream ended");
		})();
	}

	// Stream stderr to log
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
				// Process exited
			}
		})();
	}

	return bridge;
}

/**
 * Write a JSON-RPC envelope to the agent's stdin.
 */
function stdioWrite(
	bridge: StdioBridge,
	envelope: Record<string, unknown>
): void {
	const line = `${JSON.stringify(envelope)}\n`;
	bridge.proc.stdin.write(line);
}

/**
 * Send a JSON-RPC request and wait for the response.
 */
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
		// Already closed
	}
	try {
		bridge.proc.kill();
	} catch {
		// Already dead
	}
}

// ---------------------------------------------------------------------------
// Turn execution — runs the full ACP lifecycle for one prompt
// ---------------------------------------------------------------------------

async function executeTurn(params: PromptRequestBody): Promise<void> {
	const {
		turnId,
		sessionId,
		agent,
		modelId,
		prompt,
		cwd,
		actorEndpoint,
		actorKey,
		callbackToken,
	} = params;

	log("info", "executeTurn started", {
		turnId,
		sessionId,
		agent,
		modelId,
		cwd,
		actorEndpoint,
		actorKey,
	});

	const connectionId = `corp-agent-${turnId}-${crypto.randomUUID()}`;
	let eventIndex = 0;
	let sequence = 0;

	// Test actor resolution (same PUT /actors the SDK does internally)
	try {
		const actorsUrl = `${actorEndpoint}/actors`;
		const putBody = {
			name: "space",
			key: JSON.stringify(actorKey),
			crash_policy: "sleep",
		};
		log("info", "Testing actor resolution (PUT /actors)", {
			url: actorsUrl,
			body: putBody,
		});
		const resolveResp = await fetch(actorsUrl, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(putBody),
			signal: AbortSignal.timeout(5000),
		});
		const resolveBody = await resolveResp.text();
		log("info", "Actor resolution result", {
			status: resolveResp.status,
			body: resolveBody.slice(0, 500),
		});
	} catch (error) {
		log("error", "Actor resolution test FAILED", {
			actorEndpoint,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	// Connect to actor via RivetKit client SDK (persistent WebSocket)
	log("info", "Connecting to actor via RivetKit WebSocket", {
		actorEndpoint,
		actorKey,
	});
	const client = createClient({
		endpoint: actorEndpoint,
		disableMetadataLookup: true,
		devtools: false,
	});
	const actorHandle = (
		client as Record<string, Record<string, Function>>
	).space.getOrCreate(actorKey);
	const actorConn = actorHandle.connect() as Record<string, Function>;
	log("info", "Actor connect() called (connection is lazy)");
	let callbackQueue = Promise.resolve();

	// Hook into connection lifecycle events
	if (typeof actorConn.onOpen === "function") {
		actorConn.onOpen(() => {
			log("info", "WS EVENT: connection OPENED", {
				connStatus: actorConn.connStatus,
			});
		});
	}
	if (typeof actorConn.onClose === "function") {
		actorConn.onClose(() => {
			log("warn", "WS EVENT: connection CLOSED", {
				connStatus: actorConn.connStatus,
			});
		});
	}
	if (typeof actorConn.onError === "function") {
		actorConn.onError((error: unknown) => {
			log("error", "WS EVENT: connection ERROR", {
				error: error instanceof Error ? error.message : String(error),
				errorType: error?.constructor?.name,
			});
		});
	}
	if (typeof actorConn.onStatusChange === "function") {
		actorConn.onStatusChange((status: string) => {
			log("info", "WS EVENT: status changed", { status });
		});
	}

	log("info", "Initial connStatus", {
		connStatus: actorConn.connStatus ?? "unknown",
	});

	// Helper to send a callback to the actor over WebSocket
	// Uses a serialized queue (in-flight=1) to avoid bursty callback completions.
	const sendCallback = (
		kind: string,
		extra: Record<string, unknown> = {}
	): Promise<void> => {
		sequence += 1;
		const payload = {
			turnId,
			sessionId,
			token: callbackToken,
			sequence,
			kind,
			timestamp: Date.now(),
			...extra,
		};

		callbackQueue = callbackQueue
			.catch(() => undefined)
			.then(async () => {
				try {
					log("info", `Sending ${kind} callback (seq=${sequence})`, {
						turnId,
						kind,
						payloadKeys: Object.keys(payload),
						hasEvents: "events" in extra ? (extra.events as unknown[]).length : 0,
					});
					const result = await actorConn.ingestTurnRunnerBatch(payload);
					log("info", `Sent ${kind} callback OK (seq=${sequence})`, {
						result: result !== undefined ? JSON.stringify(result) : "void",
					});
				} catch (error) {
					log("error", `Failed to send ${kind} callback`, {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
						errorType: error?.constructor?.name,
					});
				}
			});

		return callbackQueue;
	};

	// Queue an envelope as a session event
	const queueEnvelopeEvent = (
		envelope: Record<string, unknown>,
		direction: "inbound" | "outbound"
	) => {
		eventIndex += 1;
		const event: SessionEvent = {
			id: crypto.randomUUID(),
			eventIndex,
			sessionId,
			createdAt: Date.now(),
			connectionId,
			sender: direction === "outbound" ? "client" : "agent",
			payload: clonePayload(envelope),
		};
		sendCallback("events", { events: [event] });
	};

	let bridge: StdioBridge | null = null;

	try {
		// 1. Spawn agent subprocess with stdio bridge
		log("info", "Spawning agent subprocess", { agent });
		bridge = spawnStdioBridge(agent, (envelope) => {
			// Every inbound notification/message from the agent
			queueEnvelopeEvent(envelope, "inbound");

			// Handle requestPermission from agent
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
				stdioWrite(bridge!, response);
				queueEnvelopeEvent(response, "outbound");
			}
		});

		// Brief pause to check if process exits immediately
		await new Promise((r) => setTimeout(r, 500));
		if (bridge.proc.exitCode !== null) {
			throw new Error(
				`Agent ${agent} exited immediately with code ${bridge.proc.exitCode}`
			);
		}
		log("info", "Agent subprocess running", { agent });

		// 2. Initialize
		log("info", "Sending ACP initialize");
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
		log("info", "ACP initialized OK");

		// 3. Create session
		log("info", "Creating ACP session");
		const sessionResult = await stdioRequest(bridge, "session/new", {
			cwd,
			mcpServers: [],
		});
		const agentSessionId = sessionResult.sessionId as string;
		if (!agentSessionId) {
			throw new Error("session/new did not return a sessionId");
		}
		log("info", "ACP session created", { agentSessionId });

		// 4. Set model (optional, best-effort — not all agents support this)
		if (modelId) {
			log("info", "Setting model", { modelId });
			try {
				await stdioRequest(bridge, "unstable/setSessionModel", {
					sessionId: agentSessionId,
					modelId,
				});
			} catch (error) {
				log("warn", "setSessionModel not supported, skipping", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// 5. Send prompt and wait for response
		log("info", "Sending prompt to agent");
		const promptResult = await stdioRequest(bridge, "session/prompt", {
			sessionId: agentSessionId,
			prompt,
		});

		// Record the outbound prompt envelope for events
		queueEnvelopeEvent(
			{
				jsonrpc: "2.0",
				method: "session/prompt",
				params: { sessionId: agentSessionId, prompt },
			},
			"outbound"
		);

		if ("error" in promptResult) {
			const err = promptResult as Record<string, unknown>;
			throw new Error(`Prompt ACP error: ${JSON.stringify(err)}`);
		}

		// 6. Send completed callback
		log("info", "Turn completed successfully", { turnId });
		await sendCallback("completed");
		await callbackQueue.catch(() => undefined);
	} catch (error) {
		log("error", "Turn failed", { turnId, error: formatError(error) });
		await sendCallback("failed", { error: formatError(error) });
		await callbackQueue.catch(() => undefined);
	} finally {
		// Disconnect actor WebSocket
		try {
			if (typeof actorConn.dispose === "function") {
				await actorConn.dispose();
				log("info", "Actor connection disposed");
			}
		} catch (error) {
			log("warn", "Error disposing actor connection", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		if (bridge) {
			killBridge(bridge);
		}
	}
}

// ---------------------------------------------------------------------------
// Agent discovery (for /v1/agents)
// ---------------------------------------------------------------------------

const ALL_AGENT_IDS = [...Object.keys(AGENT_NPX_PACKAGES), "amp", "opencode"];

async function discoverAgents(): Promise<
	Array<{ id: string; installed: boolean }>
> {
	const agents: Array<{ id: string; installed: boolean }> = [];
	for (const id of ALL_AGENT_IDS) {
		// Check if the command exists by trying `which`
		let installed = false;
		try {
			const bin = id === "amp" ? "amp-acp" : id;
			const result = Bun.spawnSync(["which", bin]);
			installed = result.exitCode === 0;
		} catch {
			// not installed
		}
		agents.push({ id, installed });
	}
	return agents;
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

// Track active turns to prevent double-prompting
const activeTurns = new Map<string, boolean>();

Bun.serve({
	hostname: host,
	port,
	async fetch(req) {
		const url = new URL(req.url);

		// Health check
		if (req.method === "GET" && url.pathname === "/v1/health") {
			return Response.json({ status: "ok" });
		}

		// List agents
		if (req.method === "GET" && url.pathname === "/v1/agents") {
			const agents = await discoverAgents();
			return Response.json({ agents });
		}

		// Prompt
		if (req.method === "POST" && url.pathname === "/v1/prompt") {
			log("info", "Received POST /v1/prompt");
			let body: PromptRequestBody;
			try {
				body = (await req.json()) as PromptRequestBody;
			} catch {
				log("error", "Invalid JSON body in /v1/prompt");
				return Response.json({ error: "Invalid JSON body" }, { status: 400 });
			}

			if (!(body.turnId && body.sessionId && body.agent && body.prompt)) {
				return Response.json(
					{
						error: "Missing required fields: turnId, sessionId, agent, prompt",
					},
					{ status: 400 }
				);
			}

			if (!(body.actorEndpoint && body.actorKey)) {
				log("error", "Missing actorEndpoint or actorKey", {
					actorEndpoint: body.actorEndpoint,
					actorKey: body.actorKey,
				});
				return Response.json(
					{ error: "Missing required fields: actorEndpoint, actorKey" },
					{ status: 400 }
				);
			}

			log("info", "Prompt request body received", {
				turnId: body.turnId,
				sessionId: body.sessionId,
				agent: body.agent,
				actorEndpoint: body.actorEndpoint,
				actorKey: body.actorKey,
				callbackToken: body.callbackToken ? "present" : "missing",
			});

			// Prevent duplicate turns
			if (activeTurns.has(body.turnId)) {
				return Response.json(
					{ error: "Turn already in progress" },
					{ status: 409 }
				);
			}

			activeTurns.set(body.turnId, true);

			// Fire and forget — respond immediately
			log("info", "Accepted turn", {
				turnId: body.turnId,
				agent: body.agent,
				sessionId: body.sessionId,
			});
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

		return Response.json({ error: "Not found" }, { status: 404 });
	},
});

log("info", `Listening on ${host}:${port}`);
console.log(`[corp-agent] Listening on ${host}:${port}`);
