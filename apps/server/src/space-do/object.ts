import { DurableObject } from "cloudflare:workers";
import acpAgents from "@corporation/config/acp-agent-manifest";
import type { AgentProbeResponse } from "@corporation/contracts/sandbox-do";
import {
	type SpaceSocketClientMessage,
	spaceSocketClientMessageSchema,
} from "@corporation/contracts/space-socket";
import { env } from "@corporation/env/server";
import { Sandbox } from "@e2b/desktop";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { nanoid } from "nanoid";
import { createRuntimeAuthHeaders, requireActorAuth } from "./actor-auth";
import { ingestAgentRunnerBatch } from "./agent-runner";
import bundledMigrations from "./db/migrations";
import { schema, spaceMetadata } from "./db/schema";
import { getDesktopStreamUrl } from "./desktop";
import { requireSandbox } from "./sandbox";
import { keepAliveSandbox } from "./sandbox-keep-alive";
import { getSessionStreamState, readSessionStream } from "./session-stream";
import { cancelSession, listSessions, sendMessage } from "./sessions";
import {
	broadcastTerminalSnapshot,
	getTerminalSnapshot,
	resetTerminal,
	runCommandInTerminal,
	input as terminalInput,
	resize as terminalResize,
} from "./terminal";
import type {
	BrowserConnection,
	PersistedState,
	SandboxBinding,
	SpaceConnectionState,
	SpaceRuntimeContext,
	SpaceVars,
} from "./types";

const BROWSER_SOCKET_TAG = "browser";
const SPACE_AUTH_HEADER = "x-space-auth";
const SPACE_SLUG_HEADER = "x-space-slug";
const SANDBOX_USER = "user";
const KEEP_ALIVE_ACTIONS = new Set([
	"getDesktopStreamUrl",
	"ingestAgentRunnerBatch",
	"input",
	"keepAliveSandbox",
	"runCommand",
	"sendMessage",
]);

type BrowserSocketAttachment = {
	connectionId: string;
	connectedAt: number;
	spaceSlug: string;
	auth: SpaceConnectionState;
};

function quoteShellArg(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function connectSandbox(
	sandboxId: string | null
): Promise<Sandbox | null> {
	if (!sandboxId) {
		return null;
	}

	return await Sandbox.connect(sandboxId, {
		apiKey: env.E2B_API_KEY,
	});
}

function sameBinding(
	current: SandboxBinding | null,
	next: SandboxBinding | null
): boolean {
	if (current === null && next === null) {
		return true;
	}
	if (current === null || next === null) {
		return false;
	}
	return (
		current.sandboxId === next.sandboxId && current.agentUrl === next.agentUrl
	);
}

function emptyAgentProbeResponse(status: "not_installed" | "error") {
	const agents = acpAgents
		.filter((agent) => agent.runtimeCommand)
		.map((agent) => ({
			id: agent.id,
			name: agent.name,
			status,
			configOptions: null,
			verifiedAt: null,
			authCheckedAt: Date.now(),
			error: status === "error" ? "Unable to reach sandbox runtime" : null,
		}));

	return {
		probedAt: Date.now(),
		agents,
	} satisfies AgentProbeResponse;
}

function parseSpaceAuthHeader(
	header: string | null
): SpaceConnectionState | null {
	if (!header) {
		return null;
	}

	try {
		return JSON.parse(header) as SpaceConnectionState;
	} catch {
		return null;
	}
}

function parseRequestBool(url: URL, name: string, fallback = false): boolean {
	const raw = url.searchParams.get(name);
	if (!raw) {
		return fallback;
	}
	return raw === "1" || raw === "true";
}

function parseRequestNumber(url: URL, name: string): number | undefined {
	const raw = url.searchParams.get(name);
	if (!raw) {
		return undefined;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAfterOffset(url: URL): number | undefined {
	const raw = url.searchParams.get("offset");
	if (!raw) {
		return undefined;
	}
	if (raw === "-1") {
		return -1;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function asRpcResultSuccess(id: string, result: unknown) {
	return JSON.stringify({
		type: "rpc_result",
		id,
		ok: true,
		result,
	});
}

function asRpcResultError(id: string, code: string, message: string) {
	return JSON.stringify({
		type: "rpc_result",
		id,
		ok: false,
		error: {
			code,
			message,
		},
	});
}

export class SpaceDurableObject extends DurableObject<Env> {
	private readonly actorId: string;
	private readonly stateData: PersistedState = { binding: null };
	private readonly connections = new Map<string, BrowserConnection>();
	private readonly ready: Promise<void>;
	private readonly key: string[] = ["__space__"];
	private readonly bindings: Env;
	private vars!: SpaceVars;
	private spaceSlug = "__space__";

	constructor(ctx: DurableObjectState, bindings: Env) {
		super(ctx, bindings);
		this.bindings = bindings;
		this.actorId = ctx.id.toString();
		this.ready = this.initialize();
		ctx.blockConcurrencyWhile(async () => {
			await this.ready;
		});
	}

	private async initialize(): Promise<void> {
		const db = drizzle(this.ctx.storage, { schema });
		await migrate(db, bundledMigrations);

		const metadata = await db
			.select({
				sandboxId: spaceMetadata.sandboxId,
				agentUrl: spaceMetadata.agentUrl,
			})
			.from(spaceMetadata)
			.where(eq(spaceMetadata.id, 1))
			.limit(1);
		this.stateData.binding =
			metadata[0]?.sandboxId && metadata[0]?.agentUrl
				? {
						sandboxId: metadata[0].sandboxId,
						agentUrl: metadata[0].agentUrl,
					}
				: null;

		let sandbox: Sandbox | null = null;
		try {
			sandbox = await connectSandbox(this.stateData.binding?.sandboxId ?? null);
		} catch (error) {
			console.warn("Failed to connect sandbox for space durable object", {
				actorId: this.actorId,
				sandboxId: this.stateData.binding?.sandboxId ?? null,
				error,
			});
		}

		this.vars = {
			db,
			sandbox,
			terminalHandles: new Map(),
			sessionStreamWaiters: new Map(),
			agentRunnerSequenceBySessionId: new Map(),
			lastSandboxKeepAliveAt: 0,
		};

		this.rebuildConnectionsFromHibernation();
	}

	private rebuildConnectionsFromHibernation() {
		this.connections.clear();
		for (const socket of this.ctx.getWebSockets(BROWSER_SOCKET_TAG)) {
			const attachment =
				socket.deserializeAttachment() as BrowserSocketAttachment | null;
			if (!attachment) {
				continue;
			}
			this.spaceSlug = attachment.spaceSlug;
			this.key[0] = attachment.spaceSlug;
			this.connections.set(
				attachment.connectionId,
				this.createBrowserConnection(socket)
			);
		}
	}

	private createBrowserConnection(socket: WebSocket): BrowserConnection {
		return {
			socket,
			send: (eventName: string, payload?: unknown) => {
				if (socket.readyState !== WebSocket.OPEN) {
					return;
				}
				socket.send(
					JSON.stringify({
						type: "event",
						event: eventName,
						payload,
					})
				);
			},
		};
	}

	private createContext(
		authState?: SpaceConnectionState,
		connectionId?: string
	): SpaceRuntimeContext {
		return {
			actorId: this.actorId,
			key: this.key,
			ctx: this.ctx,
			env: this.bindings,
			state: this.stateData,
			vars: this.vars,
			conns: this.connections,
			waitUntil: (promise) => {
				this.ctx.waitUntil(promise);
			},
			broadcast: (eventName, payload) => {
				for (const connection of this.connections.values()) {
					connection.send(eventName, payload);
				}
			},
			conn:
				authState && connectionId
					? {
							id: connectionId,
							state: authState,
						}
					: undefined,
		};
	}

	private async persistBinding(binding: SandboxBinding | null): Promise<void> {
		this.stateData.binding = binding;
		await this.vars.db
			.insert(spaceMetadata)
			.values({
				id: 1,
				sandboxId: binding?.sandboxId ?? null,
				agentUrl: binding?.agentUrl ?? null,
			})
			.onConflictDoUpdate({
				target: spaceMetadata.id,
				set: {
					sandboxId: binding?.sandboxId ?? null,
					agentUrl: binding?.agentUrl ?? null,
				},
			});
	}

	private async getAgentProbeState(
		c: Pick<SpaceRuntimeContext, "state" | "conn">
	): Promise<AgentProbeResponse> {
		const binding = c.state.binding;
		if (!binding) {
			return emptyAgentProbeResponse("not_installed");
		}
		const { authToken } = requireActorAuth(c);

		try {
			const response = await fetch(`${binding.agentUrl}/v1/agents/probe`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...createRuntimeAuthHeaders(authToken),
				},
				body: JSON.stringify({
					ids: acpAgents
						.filter((agent) => agent.runtimeCommand)
						.map((agent) => agent.id),
				}),
			});

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(
					`sandbox-runtime agent probe failed (${response.status}): ${text}`
				);
			}

			return (await response.json()) as AgentProbeResponse;
		} catch (error) {
			console.error("Failed to fetch agent probe state", error);
			return emptyAgentProbeResponse("error");
		}
	}

	private async syncSandboxBinding(
		ctx: SpaceRuntimeContext,
		binding: SandboxBinding | null
	): Promise<boolean> {
		if (sameBinding(this.stateData.binding, binding)) {
			return false;
		}

		const sandbox = await connectSandbox(binding?.sandboxId ?? null);
		await resetTerminal(ctx);
		await this.persistBinding(binding);
		this.vars.sandbox = sandbox;
		this.vars.lastSandboxKeepAliveAt = 0;

		if (this.vars.sandbox && this.connections.size > 0) {
			try {
				await broadcastTerminalSnapshot(ctx);
			} catch (error) {
				console.error(
					"Failed to broadcast terminal snapshot after sync",
					error
				);
			}
		}

		return true;
	}

	private async handleRpc(
		message: SpaceSocketClientMessage,
		authState: SpaceConnectionState,
		connectionId: string
	): Promise<string> {
		const ctx = this.createContext(authState, connectionId);

		try {
			let result: unknown;
			switch (message.method) {
				case "syncSandboxBinding":
					result = await this.syncSandboxBinding(
						ctx,
						(message.args[0] as SandboxBinding | null | undefined) ?? null
					);
					break;
				case "listSessions":
					result = await listSessions(ctx);
					break;
				case "sendMessage":
					result = await sendMessage(
						ctx,
						message.args[0] as string,
						message.args[1] as string,
						message.args[2] as string,
						message.args[3] as string
					);
					break;
				case "cancelSession":
					result = await cancelSession(ctx, message.args[0] as string);
					break;
				case "getAgentProbeState":
					result = await this.getAgentProbeState(ctx);
					break;
				case "runCommand": {
					const command = message.args[0] as string;
					const background = (message.args[1] as boolean | undefined) ?? false;
					if (!command.trim()) {
						throw new Error("Command cannot be empty");
					}
					if (!background) {
						await runCommandInTerminal(ctx, command);
						result = null;
						break;
					}
					const logId = crypto.randomUUID();
					const nextCommand = `nohup bash -lc ${quoteShellArg(command)} >/tmp/corporation-run-command-${logId}.log 2>&1 </dev/null &`;
					await requireSandbox(ctx).commands.run(nextCommand, {
						user: SANDBOX_USER,
					});
					result = null;
					break;
				}
				case "input":
					result = await terminalInput(ctx, message.args[0] as number[]);
					break;
				case "resize":
					result = await terminalResize(
						ctx,
						message.args[0] as number,
						message.args[1] as number
					);
					break;
				case "getTerminalSnapshot":
					result = await getTerminalSnapshot(ctx);
					break;
				case "getDesktopStreamUrl":
					result = await getDesktopStreamUrl(ctx);
					break;
				default:
					return asRpcResultError(
						message.id,
						"unknown_method",
						`Unknown method: ${message.method}`
					);
			}

			if (KEEP_ALIVE_ACTIONS.has(message.method)) {
				await keepAliveSandbox(ctx);
			}

			return asRpcResultSuccess(message.id, result);
		} catch (error) {
			const messageText =
				error instanceof Error ? error.message : "Unexpected RPC error";
			return asRpcResultError(message.id, "internal", messageText);
		}
	}

	private handleSocketUpgrade(request: Request): Response {
		const authState = parseSpaceAuthHeader(
			request.headers.get(SPACE_AUTH_HEADER)
		);
		if (!authState) {
			return new Response("Unauthorized", { status: 401 });
		}

		this.spaceSlug = request.headers.get(SPACE_SLUG_HEADER) ?? this.spaceSlug;
		this.key[0] = this.spaceSlug;

		// biome-ignore lint/correctness/noUndeclaredVariables: Cloudflare Workers exposes WebSocketPair globally.
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const connectionId = nanoid();
		const attachment: BrowserSocketAttachment = {
			connectionId,
			connectedAt: Date.now(),
			spaceSlug: this.spaceSlug,
			auth: authState,
		};

		server.serializeAttachment(attachment);
		this.ctx.acceptWebSocket(server, [BROWSER_SOCKET_TAG]);
		this.connections.set(connectionId, this.createBrowserConnection(server));

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	private async handleInternalRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const authState = parseSpaceAuthHeader(
			request.headers.get(SPACE_AUTH_HEADER)
		);
		const connectionId = nanoid();
		const ctx = this.createContext(authState ?? undefined, connectionId);

		if (url.pathname === "/internal/session-stream/state") {
			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId) {
				return Response.json({ error: "Missing sessionId" }, { status: 400 });
			}
			return Response.json(await getSessionStreamState(ctx, sessionId));
		}

		if (url.pathname === "/internal/session-stream/read") {
			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId) {
				return Response.json({ error: "Missing sessionId" }, { status: 400 });
			}
			return Response.json(
				await readSessionStream(
					ctx,
					sessionId,
					parseAfterOffset(url),
					parseRequestNumber(url, "limit"),
					parseRequestBool(url, "live"),
					parseRequestNumber(url, "timeoutMs")
				)
			);
		}

		if (
			url.pathname === "/internal/runtime/agent-runner-callback" &&
			request.method === "POST"
		) {
			const payload = await request.json();
			await ingestAgentRunnerBatch(ctx, payload);
			await keepAliveSandbox(ctx);
			return Response.json({ ok: true });
		}

		return new Response("Not found", { status: 404 });
	}

	async fetch(request: Request): Promise<Response> {
		await this.ready;
		const url = new URL(request.url);

		if (url.pathname === "/socket") {
			return await this.handleSocketUpgrade(request);
		}

		if (url.pathname.startsWith("/internal/")) {
			return await this.handleInternalRequest(request);
		}

		return new Response("Not found", { status: 404 });
	}

	async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer
	): Promise<void> {
		const attachment =
			ws.deserializeAttachment() as BrowserSocketAttachment | null;
		if (!attachment) {
			ws.close(4401, "Missing connection attachment");
			return;
		}

		const rawMessage =
			typeof message === "string" ? message : new TextDecoder().decode(message);
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(rawMessage);
		} catch {
			ws.send(asRpcResultError("unknown", "invalid_json", "Invalid JSON"));
			return;
		}

		const parsedMessage = spaceSocketClientMessageSchema.safeParse(parsedJson);
		if (!parsedMessage.success) {
			ws.send(
				asRpcResultError("unknown", "invalid_message", "Invalid socket message")
			);
			return;
		}

		ws.send(
			await this.handleRpc(
				parsedMessage.data,
				attachment.auth,
				attachment.connectionId
			)
		);
	}

	webSocketClose(
		ws: WebSocket,
		_code: number,
		_reason: string,
		_wasClean: boolean
	): void {
		const attachment =
			ws.deserializeAttachment() as BrowserSocketAttachment | null;
		if (!attachment) {
			return;
		}
		this.connections.delete(attachment.connectionId);
	}

	webSocketError(_ws: WebSocket, error: unknown): void {
		console.error("Space websocket error", error);
	}
}

export type { SessionRow } from "./db/schema";
