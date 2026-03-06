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
 *      via stdin/stdout using the Streamable HTTP transport (POST/GET/DELETE).
 *   3. Streams session events back to a Rivet actor over a persistent
 *      WebSocket connection using the RivetKit client SDK.
 */

import crypto from "node:crypto";
import { createClient } from "rivetkit/client";

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

const AGENT_ACP_PACKAGES: Record<string, string> = {
	claude: "@anthropic-ai/claude-code",
	codex: "@openai/codex",
	amp: "amp-acp",
	opencode: "opencode",
	pi: "pi-acp",
	cursor: "@blowmage/cursor-agent-acp",
};

function agentCommand(agent: string): string[] {
	const pkg = AGENT_ACP_PACKAGES[agent];
	if (!pkg) {
		throw new Error(`Unknown agent: ${agent}`);
	}
	// For opencode, the binary itself supports `acp` subcommand
	if (agent === "opencode") {
		return ["opencode", "acp"];
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
// ACP subprocess bridge
// ---------------------------------------------------------------------------

/**
 * AcpSubprocessBridge manages a single ACP agent subprocess.
 * It communicates using the ACP Streamable HTTP transport:
 *   - Spawns the agent subprocess
 *   - Sends JSON-RPC envelopes via POST to the agent's stdin-based HTTP server
 *   - Receives responses and notifications via SSE (GET)
 *
 * Wait — actually, the ACP subprocess bridge used by sandbox-agent works
 * differently: the Rust binary spawns the agent process with piped stdio,
 * writes JSON-RPC envelopes line-by-line to stdin, and reads responses
 * line-by-line from stdout. But the `acp-http-client` uses HTTP transport
 * (POST/GET/DELETE to the server's HTTP endpoint).
 *
 * Since we're replacing the sandbox-agent server (which was the HTTP endpoint),
 * our binary IS the server. The approach is:
 *   - We use acp-http-client style HTTP transport
 *   - The agent subprocess starts its own HTTP server (that's what the -acp
 *     packages do — they start an ACP-compliant HTTP server)
 *   - We connect to it via HTTP, same as the old corp-turn-runner did
 *
 * So we don't need a stdio bridge — the agent ACP process starts its own
 * HTTP server and we talk to it over HTTP. We just need to:
 *   1. Spawn the agent process
 *   2. Wait for it to be ready
 *   3. Forward ACP JSON-RPC to it (initialize, newSession, prompt)
 *   4. Collect events via SSE and forward to the Rivet actor
 */

const ACP_PROTOCOL_VERSION = 1;
const ACP_AGENT_PORT = 8900; // Port for the agent's ACP HTTP server
const ACP_REQUEST_TIMEOUT_MS = 10 * 60_000; // 10 minutes

interface AcpConnection {
	acpPath: string;
	baseUrl: string;
	bootstrapped: boolean;
	bootstrapQuery: Record<string, string>;
	pendingResolvers: Map<string, (envelope: Record<string, unknown>) => void>;
	sseAbort: AbortController | null;
}

function createAcpConnection(port: number, agent: string): AcpConnection {
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		acpPath: "/v1/rpc",
		bootstrapped: false,
		bootstrapQuery: { agent },
		sseAbort: null,
		pendingResolvers: new Map(),
	};
}

function buildUrl(conn: AcpConnection): string {
	const base = `${conn.baseUrl}${conn.acpPath}`;
	if (!conn.bootstrapped) {
		conn.bootstrapped = true;
		const params = new URLSearchParams(conn.bootstrapQuery);
		return `${base}?${params.toString()}`;
	}
	return base;
}

async function acpPost(
	conn: AcpConnection,
	envelope: Record<string, unknown>,
	timeoutMs: number = ACP_REQUEST_TIMEOUT_MS
): Promise<Record<string, unknown> | null> {
	const url = buildUrl(conn);
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(envelope),
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`ACP POST failed (${response.status}): ${text}`);
	}

	const bodyText = await response.text();
	if (bodyText.trim()) {
		return JSON.parse(bodyText);
	}
	return null; // 202-style: response will come via SSE
}

async function acpRequest(
	conn: AcpConnection,
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

	const waiterPromise = new Promise<Record<string, unknown>>(
		(resolve, reject) => {
			const timer = setTimeout(() => {
				conn.pendingResolvers.delete(id);
				reject(new Error(`ACP request timed out: ${method} (${id})`));
			}, timeoutMs);

			conn.pendingResolvers.set(id, (result) => {
				clearTimeout(timer);
				conn.pendingResolvers.delete(id);
				resolve(result);
			});
		}
	);

	const directResponse = await acpPost(conn, envelope, timeoutMs);
	if (
		directResponse &&
		typeof directResponse === "object" &&
		"id" in directResponse
	) {
		// Direct response — cancel waiter and return
		conn.pendingResolvers.delete(id);
		if ("error" in directResponse) {
			const err = directResponse.error as Record<string, unknown>;
			throw new Error(
				`ACP error (${err.code}): ${err.message ?? JSON.stringify(err)}`
			);
		}
		return (directResponse.result as Record<string, unknown>) ?? {};
	}

	// Wait for response via SSE
	const result = await waiterPromise;
	if ("error" in result) {
		const err = result.error as Record<string, unknown>;
		throw new Error(
			`ACP error (${err.code}): ${err.message ?? JSON.stringify(err)}`
		);
	}
	return (result.result as Record<string, unknown>) ?? {};
}

/**
 * Start the SSE loop to receive notifications and responses from the agent.
 */
function startSseLoop(
	conn: AcpConnection,
	onEnvelope: (envelope: Record<string, unknown>, direction: "inbound") => void
): void {
	conn.sseAbort = new AbortController();
	const signal = conn.sseAbort.signal;

	(async () => {
		let lastEventId: string | undefined;

		while (!signal.aborted) {
			try {
				const headers: Record<string, string> = {
					Accept: "text/event-stream",
				};
				if (lastEventId) {
					headers["Last-Event-ID"] = lastEventId;
				}

				const response = await fetch(`${conn.baseUrl}${conn.acpPath}`, {
					method: "GET",
					headers,
					signal,
				});

				if (!(response.ok && response.body)) {
					await new Promise((r) => setTimeout(r, 500));
					continue;
				}

				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let currentId: string | undefined;
				let currentData = "";

				while (!signal.aborted) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						if (line.startsWith("id: ")) {
							currentId = line.slice(4).trim();
						} else if (line.startsWith("data: ")) {
							currentData += (currentData ? "\n" : "") + line.slice(6);
						} else if (line === "") {
							// End of event
							if (currentData) {
								if (currentId) {
									lastEventId = currentId;
								}
								try {
									const envelope = JSON.parse(currentData);
									// Resolve pending request if this is a response
									const envId =
										envelope?.id != null ? String(envelope.id) : null;
									if (envId && conn.pendingResolvers.has(envId)) {
										conn.pendingResolvers.get(envId)?.(envelope);
									}
									onEnvelope(envelope, "inbound");
								} catch {
									// Ignore malformed JSON
								}
							}
							currentId = undefined;
							currentData = "";
						}
					}
				}
			} catch (error) {
				if (signal.aborted) {
					break;
				}
				// Reconnect after brief delay
				await new Promise((r) => setTimeout(r, 150));
			}
		}
	})();
}

function stopSseLoop(conn: AcpConnection): void {
	conn.sseAbort?.abort();
	conn.sseAbort = null;
}

async function acpDelete(conn: AcpConnection): Promise<void> {
	try {
		await fetch(`${conn.baseUrl}${conn.acpPath}`, {
			method: "DELETE",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		// Best effort
	}
}

// ---------------------------------------------------------------------------
// Agent subprocess management
// ---------------------------------------------------------------------------

interface AgentProcess {
	port: number;
	proc: ReturnType<typeof Bun.spawn>;
}

async function spawnAgentProcess(agent: string): Promise<AgentProcess> {
	const port = ACP_AGENT_PORT + Math.floor(Math.random() * 1000);
	const cmd = agentCommand(agent);

	const proc = Bun.spawn(cmd, {
		env: {
			...process.env,
			PORT: String(port),
			// Some ACP agents use HOST/PORT env vars
			HOST: "127.0.0.1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	// Wait for the agent's HTTP server to be ready
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const resp = await fetch(`http://127.0.0.1:${port}/v1/rpc`, {
				method: "GET",
				headers: { Accept: "text/event-stream" },
				signal: AbortSignal.timeout(2000),
			});
			// Any response (even error) means the server is up
			if (resp.body) {
				// Close the SSE stream immediately
				await resp.body.cancel();
			}
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 300));
		}
	}

	if (Date.now() >= deadline) {
		proc.kill();
		throw new Error(`Agent ${agent} did not start within 30s`);
	}

	return { proc, port };
}

function killAgentProcess(ap: AgentProcess): void {
	try {
		ap.proc.kill();
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

	const connectionId = `corp-agent-${turnId}-${crypto.randomUUID()}`;
	let eventIndex = 0;
	let sequence = 0;

	// Connect to actor via RivetKit client SDK
	const client = createClient({ endpoint: actorEndpoint });
	const actorHandle = (
		client as Record<string, Record<string, Function>>
	).space.getOrCreate(actorKey);

	// Helper to send a callback to the actor
	const sendCallback = async (
		kind: string,
		extra: Record<string, unknown> = {}
	) => {
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
		try {
			await actorHandle.ingestTurnRunnerBatch(payload);
		} catch (error) {
			console.error(
				`[corp-agent] Failed to send ${kind} callback:`,
				error instanceof Error ? error.message : String(error)
			);
		}
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

	let agentProcess: AgentProcess | null = null;
	let conn: AcpConnection | null = null;

	try {
		// 1. Spawn agent subprocess
		agentProcess = await spawnAgentProcess(agent);
		conn = createAcpConnection(agentProcess.port, agent);

		// 2. Start SSE loop to receive notifications
		startSseLoop(conn, (envelope, direction) => {
			queueEnvelopeEvent(envelope, direction);

			// Handle requestPermission from agent
			if (envelope.method === "requestPermission" && envelope.id != null) {
				const params = envelope.params as Record<string, unknown> | undefined;
				const request = params?.request as Record<string, unknown> | undefined;
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
				acpPost(conn!, response).catch(() => {});
				queueEnvelopeEvent(response, "outbound");
			}
		});

		// 3. Initialize
		const initEnvelope = {
			jsonrpc: "2.0",
			id: `initialize-${crypto.randomUUID()}`,
			method: "initialize",
			params: {
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientInfo: { name: "corp-agent", version: "v1" },
			},
		};
		queueEnvelopeEvent(initEnvelope, "outbound");
		await acpRequest(conn, "initialize", {
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientInfo: { name: "corp-agent", version: "v1" },
		});

		// 4. Create session
		const sessionResult = await acpRequest(conn, "session/new", {
			cwd,
			mcpServers: [],
		});
		const agentSessionId = sessionResult.sessionId as string;
		if (!agentSessionId) {
			throw new Error("session/new did not return a sessionId");
		}

		// 5. Set model (optional)
		if (modelId) {
			await acpRequest(conn, "unstable/setSessionModel", {
				sessionId: agentSessionId,
				modelId,
			});
		}

		// 6. Send prompt
		const promptId = `prompt-${crypto.randomUUID()}`;
		const promptEnvelope: Record<string, unknown> = {
			jsonrpc: "2.0",
			id: promptId,
			method: "session/prompt",
			params: { sessionId: agentSessionId, prompt },
		};
		queueEnvelopeEvent(promptEnvelope, "outbound");

		// Send prompt and wait for response
		const promptWaiter = new Promise<Record<string, unknown>>(
			(resolve, reject) => {
				const timer = setTimeout(() => {
					conn!.pendingResolvers.delete(promptId);
					reject(new Error("Prompt timed out"));
				}, ACP_REQUEST_TIMEOUT_MS);

				conn!.pendingResolvers.set(promptId, (result) => {
					clearTimeout(timer);
					conn!.pendingResolvers.delete(promptId);
					resolve(result);
				});
			}
		);

		const directResponse = await acpPost(
			conn,
			promptEnvelope,
			ACP_REQUEST_TIMEOUT_MS
		);
		let promptResult: Record<string, unknown>;

		if (
			directResponse &&
			typeof directResponse === "object" &&
			"id" in directResponse
		) {
			conn.pendingResolvers.delete(promptId);
			promptResult = directResponse;
		} else {
			promptResult = await promptWaiter;
		}

		if ("error" in promptResult) {
			const err = promptResult.error as Record<string, unknown>;
			throw new Error(
				`Prompt ACP error (${err.code}): ${err.message ?? JSON.stringify(err)}`
			);
		}

		// 7. Send completed callback
		await sendCallback("completed");
	} catch (error) {
		await sendCallback("failed", { error: formatError(error) });
		console.error(
			`[corp-agent] Turn failed: ${error instanceof Error ? error.message : String(error)}`
		);
	} finally {
		if (conn) {
			stopSseLoop(conn);
			await acpDelete(conn);
		}
		if (agentProcess) {
			killAgentProcess(agentProcess);
		}
	}
}

// ---------------------------------------------------------------------------
// Agent discovery (for /v1/agents)
// ---------------------------------------------------------------------------

async function discoverAgents(): Promise<
	Array<{ id: string; installed: boolean }>
> {
	const agents: Array<{ id: string; installed: boolean }> = [];
	for (const id of Object.keys(AGENT_ACP_PACKAGES)) {
		// Check if the command exists by trying `which`
		let installed = false;
		try {
			const result = Bun.spawnSync(["which", id === "claude" ? "claude" : id]);
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
			let body: PromptRequestBody;
			try {
				body = (await req.json()) as PromptRequestBody;
			} catch {
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
				return Response.json(
					{ error: "Missing required fields: actorEndpoint, actorKey" },
					{ status: 400 }
				);
			}

			// Prevent duplicate turns
			if (activeTurns.has(body.turnId)) {
				return Response.json(
					{ error: "Turn already in progress" },
					{ status: 409 }
				);
			}

			activeTurns.set(body.turnId, true);

			// Fire and forget — respond immediately
			executeTurn(body)
				.catch((error) => {
					console.error(
						`[corp-agent] Unhandled turn error: ${error instanceof Error ? error.message : String(error)}`
					);
				})
				.finally(() => {
					activeTurns.delete(body.turnId);
				});

			return Response.json({ accepted: true }, { status: 202 });
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
});

console.log(`[corp-agent] Listening on ${host}:${port}`);
