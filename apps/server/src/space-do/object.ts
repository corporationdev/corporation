import { DurableObject } from "cloudflare:workers";
import acpAgents from "@corporation/config/acp-agent-manifest";
import type {
	SessionRow,
	SpaceSocketEventName,
} from "@corporation/contracts/browser-do";
import { browserSpaceContract } from "@corporation/contracts/orpc/browser-space";
import type { runtimeControlContract } from "@corporation/contracts/orpc/runtime-control";
import {
	type RuntimeRegisterInput,
	runtimeIngressContract,
} from "@corporation/contracts/orpc/runtime-ingress";
import type {
	AgentProbeResponse,
	RuntimeCancelTurnMessage,
	RuntimeCommandRejectedMessage,
	RuntimeProbeAgentsMessage,
	RuntimeProbeResultMessage,
	RuntimeSessionEventBatchMessage,
	RuntimeStartTurnMessage,
	RuntimeTurnCompletedMessage,
	RuntimeTurnFailedMessage,
} from "@corporation/contracts/sandbox-do";
import { createLogger } from "@corporation/logger";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { implement } from "@orpc/server";
import {
	encodeHibernationRPCEvent,
	HibernationEventIterator,
	HibernationPlugin,
} from "@orpc/server/hibernation";
import { RPCHandler } from "@orpc/server/websocket";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { nanoid } from "nanoid";
import {
	failRunningSessionsForRuntimeDisconnect,
	ingestRuntimeCommandRejected,
	ingestRuntimeSessionEventBatch,
	ingestRuntimeTurnCompleted,
	ingestRuntimeTurnFailed,
} from "./agent-runner";
import bundledMigrations from "./db/migrations";
import { schema, spaceMetadata } from "./db/schema";
import { getDesktopStreamUrl } from "./desktop";
import { ensureSandboxConnected } from "./sandbox";
import { keepAliveSandbox } from "./sandbox-keep-alive";
import { getSessionStreamState, readSessionStream } from "./session-stream";
import { cancelSession, listSessions, sendMessage } from "./sessions";
import {
	getTerminalSnapshot,
	resetTerminal,
	runCommandInTerminal,
	input as terminalInput,
	resize as terminalResize,
} from "./terminal";
import type {
	BrowserConnection,
	PersistedState,
	RuntimeCommandMetadata,
	RuntimeConnectionAuthState,
	SandboxBinding,
	SpaceConnectionState,
	SpaceRuntimeContext,
	SpaceVars,
} from "./types";

const BROWSER_SOCKET_TAG = "browser";
const RUNTIME_SOCKET_TAG = "runtime";
const SPACE_AUTH_HEADER = "x-space-auth";
const SPACE_RUNTIME_AUTH_HEADER = "x-space-runtime-auth";
const SPACE_SLUG_HEADER = "x-space-slug";
const SANDBOX_USER = "user";

const RUNTIME_HEARTBEAT_FRAME = JSON.stringify({ type: "heartbeat" });
const RUNTIME_HEARTBEAT_ACK_FRAME = JSON.stringify({
	type: "heartbeat_ack",
});
const RUNTIME_PROBE_TIMEOUT_MS = 10_000;
const log = createLogger("space:runtime");

type BrowserSubscription = {
	id: string;
	event: SpaceSocketEventName;
};

type BrowserSocketAttachment = {
	connectionId: string;
	connectedAt: number;
	spaceSlug: string;
	auth: SpaceConnectionState;
	subscriptions: BrowserSubscription[];
};

type RuntimeSocketAttachment = {
	connectionId: string;
	connectedAt: number;
	registeredAt: number | null;
	lastSeenAt: number | null;
	spaceSlug: string;
	auth: RuntimeConnectionAuthState;
};

type DurableSocketListener = Parameters<WebSocket["addEventListener"]>[1];
type DurableSocketListenerOptions = Parameters<
	WebSocket["addEventListener"]
>[2];

class DurableObjectSocketPeer {
	private readonly listeners = new Map<string, Set<DurableSocketListener>>();
	private readonly socket: WebSocket;

	constructor(socket: WebSocket) {
		this.socket = socket;
	}

	addEventListener(
		type: string,
		listener: DurableSocketListener,
		_options?: DurableSocketListenerOptions
	) {
		if (!listener) {
			return;
		}
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	get readyState() {
		return this.socket.readyState;
	}

	send(data: string | ArrayBuffer | ArrayBufferView<ArrayBufferLike>) {
		this.socket.send(
			data as string | ArrayBuffer | ArrayBufferView<ArrayBufferLike>
		);
	}

	notifyMessage(data: string | ArrayBuffer) {
		for (const listener of this.listeners.get("message") ?? []) {
			this.emitListener(listener, { data } as unknown as Event);
		}
	}

	notifyClose() {
		for (const listener of this.listeners.get("close") ?? []) {
			this.emitListener(listener, {} as Event);
		}
	}

	private emitListener(listener: DurableSocketListener, event: Event) {
		if (typeof listener === "function") {
			listener(event);
			return;
		}
		listener.handleEvent(event);
	}
}

type RuntimeSocketConnection = {
	socket: WebSocket;
	attachment: RuntimeSocketAttachment;
	peer: DurableObjectSocketPeer;
	client: ContractRouterClient<typeof runtimeControlContract>;
};

type PendingProbeRequest = {
	resolve: (value: AgentProbeResponse) => void;
	reject: (reason: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
};

type WebSocketRequestResponsePairCtor = new (
	request: string,
	response: string
) => WebSocketRequestResponsePair;

function quoteShellArg(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
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
	return current.sandboxId === next.sandboxId;
}

function emptyAgentProbeResponse(status: "not_installed" | "error") {
	const error = status === "error" ? "Sandbox runtime is unavailable" : null;
	const agents = acpAgents
		.filter((agent) => agent.runtimeCommand)
		.map((agent) => ({
			id: agent.id,
			name: agent.name,
			status,
			configOptions: null,
			verifiedAt: null,
			authCheckedAt: Date.now(),
			error,
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

function parseRuntimeAuthHeader(
	header: string | null
): RuntimeConnectionAuthState | null {
	if (!header) {
		return null;
	}

	try {
		return JSON.parse(header) as RuntimeConnectionAuthState;
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

function isORPCRequestFrame(message: string | ArrayBuffer): boolean {
	try {
		const text =
			typeof message === "string" ? message : new TextDecoder().decode(message);
		const parsed = JSON.parse(text) as {
			t?: number;
			p?: { u?: unknown };
		};
		if (parsed.t === 4) {
			return true;
		}
		return typeof parsed.p?.u === "string";
	} catch {
		return false;
	}
}

function compareRuntimeAttachments(
	left: RuntimeSocketAttachment,
	right: RuntimeSocketAttachment
): number {
	const leftRegistered = left.registeredAt ?? 0;
	const rightRegistered = right.registeredAt ?? 0;
	if (leftRegistered !== rightRegistered) {
		return rightRegistered - leftRegistered;
	}
	if (left.connectedAt !== right.connectedAt) {
		return right.connectedAt - left.connectedAt;
	}
	return right.connectionId.localeCompare(left.connectionId);
}

export class SpaceDurableObject extends DurableObject<Env> {
	private readonly actorId: string;
	private readonly stateData: PersistedState = { binding: null };
	private readonly browserConnections = new Map<string, BrowserConnection>();
	private readonly browserRPCHandler: RPCHandler<{
		authState: SpaceConnectionState;
		connectionId: string;
	}>;
	private readonly runtimeIngressRPCHandler: RPCHandler<{
		connectionId: string;
		connection: RuntimeSocketConnection;
	}>;
	private readonly runtimeConnections = new Map<
		string,
		RuntimeSocketConnection
	>();
	private readonly pendingRuntimeCommands = new Map<
		string,
		RuntimeCommandMetadata
	>();
	private readonly pendingProbeRequests = new Map<
		string,
		PendingProbeRequest
	>();
	private readonly ready: Promise<void>;
	private readonly key: string[] = ["__space__"];
	private readonly bindings: Env;
	private vars!: SpaceVars;
	private spaceSlug = "__space__";
	private runtimeConnectionId: string | null = null;

	constructor(ctx: DurableObjectState, bindings: Env) {
		super(ctx, bindings);
		this.bindings = bindings;
		this.actorId = ctx.id.toString();
		this.browserRPCHandler = new RPCHandler(this.createBrowserSocketRouter(), {
			plugins: [new HibernationPlugin()],
		});
		this.runtimeIngressRPCHandler = new RPCHandler(
			this.createRuntimeIngressRouter()
		);
		const WebSocketRequestResponsePair = (
			globalThis as {
				WebSocketRequestResponsePair?: WebSocketRequestResponsePairCtor;
			}
		).WebSocketRequestResponsePair;
		if (ctx.setWebSocketAutoResponse && WebSocketRequestResponsePair) {
			ctx.setWebSocketAutoResponse(
				new WebSocketRequestResponsePair(
					RUNTIME_HEARTBEAT_FRAME,
					RUNTIME_HEARTBEAT_ACK_FRAME
				)
			);
		}
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
			})
			.from(spaceMetadata)
			.where(eq(spaceMetadata.id, 1))
			.limit(1);
		this.stateData.binding = metadata[0]?.sandboxId
			? {
					sandboxId: metadata[0].sandboxId,
				}
			: null;

		this.vars = {
			db,
			sandbox: null,
			sandboxPromise: null,
			terminalHandles: new Map(),
			sessionStreamWaiters: new Map(),
			lastSandboxKeepAliveAt: 0,
		};

		this.rebuildConnectionsFromHibernation();
	}

	private rebuildConnectionsFromHibernation() {
		this.browserConnections.clear();
		this.runtimeConnections.clear();
		this.runtimeConnectionId = null;

		for (const socket of this.ctx.getWebSockets(BROWSER_SOCKET_TAG)) {
			const serialized =
				socket.deserializeAttachment() as BrowserSocketAttachment | null;
			if (!serialized) {
				continue;
			}
			const attachment: BrowserSocketAttachment = {
				...serialized,
				subscriptions: serialized.subscriptions ?? [],
			};
			socket.serializeAttachment(attachment);
			this.spaceSlug = attachment.spaceSlug;
			this.key[0] = attachment.spaceSlug;
			this.browserConnections.set(
				attachment.connectionId,
				this.createBrowserConnection(socket, attachment.connectionId)
			);
		}

		for (const socket of this.ctx.getWebSockets(RUNTIME_SOCKET_TAG)) {
			const serialized =
				socket.deserializeAttachment() as RuntimeSocketAttachment | null;
			if (!serialized) {
				continue;
			}
			const attachment: RuntimeSocketAttachment = {
				...serialized,
				registeredAt:
					serialized.registeredAt ??
					(
						serialized as RuntimeSocketAttachment & {
							helloReceivedAt?: number | null;
						}
					).helloReceivedAt ??
					null,
			};
			socket.serializeAttachment(attachment);
			this.spaceSlug = attachment.spaceSlug;
			this.key[0] = attachment.spaceSlug;
			this.runtimeConnections.set(
				attachment.connectionId,
				this.createRuntimeSocketConnection(socket, attachment)
			);
		}

		this.reconcileRuntimeConnections();
	}

	private createBrowserConnection(
		socket: WebSocket,
		connectionId: string
	): BrowserConnection {
		return {
			socket,
			send: (eventName: string, payload?: unknown) => {
				this.sendBrowserSubscriptionEvent(
					connectionId,
					eventName as SpaceSocketEventName,
					payload
				);
			},
		};
	}

	private createRuntimeSocketConnection(
		socket: WebSocket,
		attachment: RuntimeSocketAttachment
	): RuntimeSocketConnection {
		const peer = new DurableObjectSocketPeer(socket);
		return {
			socket,
			attachment,
			peer,
			client: createORPCClient(
				new RPCLink({
					websocket: peer,
				})
			),
		};
	}

	private updateBrowserAttachment(
		connectionId: string,
		update: (attachment: BrowserSocketAttachment) => BrowserSocketAttachment
	): BrowserSocketAttachment | null {
		const connection = this.browserConnections.get(connectionId);
		if (!connection) {
			return null;
		}
		const current =
			connection.socket.deserializeAttachment() as BrowserSocketAttachment | null;
		if (!current) {
			return null;
		}
		const next = update({
			...current,
			subscriptions: current.subscriptions ?? [],
		});
		connection.socket.serializeAttachment(next);
		return next;
	}

	private registerBrowserSubscription(
		connectionId: string,
		event: SpaceSocketEventName,
		subscriptionId: string
	) {
		this.updateBrowserAttachment(connectionId, (attachment) => {
			if (
				attachment.subscriptions.some(
					(subscription) => subscription.id === subscriptionId
				)
			) {
				return attachment;
			}
			return {
				...attachment,
				subscriptions: [
					...attachment.subscriptions,
					{
						id: subscriptionId,
						event,
					},
				],
			};
		});
	}

	private sendBrowserSubscriptionEvent(
		connectionId: string,
		event: SpaceSocketEventName,
		payload: unknown
	) {
		const connection = this.browserConnections.get(connectionId);
		if (!(connection && connection.socket.readyState === WebSocket.OPEN)) {
			return;
		}
		const attachment =
			connection.socket.deserializeAttachment() as BrowserSocketAttachment | null;
		if (!attachment) {
			return;
		}
		for (const subscription of attachment.subscriptions ?? []) {
			if (subscription.event !== event) {
				continue;
			}
			connection.socket.send(
				encodeHibernationRPCEvent(subscription.id, payload)
			);
		}
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
			conns: this.browserConnections,
			waitUntil: (promise) => {
				this.ctx.waitUntil(promise);
			},
			broadcast: (eventName, payload) => {
				for (const connection of this.browserConnections.values()) {
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
			runtime: {
				isConnected: () => this.getActiveRuntimeSocket() !== null,
				send: (message, metadata) => {
					this.sendToRuntime(message, metadata);
				},
			},
		};
	}

	private createBrowserSocketRouter() {
		const implementer = implement(browserSpaceContract).$context<{
			authState: SpaceConnectionState;
			connectionId: string;
		}>();

		return implementer.router({
			syncSandboxBinding: implementer.syncSandboxBinding.handler(
				async ({ context, input }) => {
					return await this.syncSandboxBinding(
						this.createContext(context.authState, context.connectionId),
						input.binding
					);
				}
			),
			listSessions: implementer.listSessions.handler(async ({ context }) => {
				return (await listSessions(
					this.createContext(context.authState, context.connectionId)
				)) as SessionRow[];
			}),
			sendMessage: implementer.sendMessage.handler(
				async ({ context, input }) => {
					try {
						await sendMessage(
							this.createContext(context.authState, context.connectionId),
							input.sessionId,
							input.content,
							input.agent,
							input.modelId
						);
					} catch (error) {
						if (
							error instanceof Error &&
							error.message === "Sandbox runtime is not connected"
						) {
							throw new ORPCError("SERVICE_UNAVAILABLE", {
								message: error.message,
							});
						}
						throw error;
					}
					return null;
				}
			),
			cancelSession: implementer.cancelSession.handler(
				async ({ context, input }) => {
					await cancelSession(
						this.createContext(context.authState, context.connectionId),
						input.sessionId
					);
					return null;
				}
			),
			getAgentProbeState: implementer.getAgentProbeState.handler(async () => {
				return await this.requestRuntimeProbe();
			}),
			runCommand: implementer.runCommand.handler(async ({ context, input }) => {
				const ctx = this.createContext(context.authState, context.connectionId);
				const background = input.background ?? false;
				if (!input.command.trim()) {
					throw new Error("Command cannot be empty");
				}
				if (!background) {
					await runCommandInTerminal(ctx, input.command);
					await keepAliveSandbox(ctx);
					return null;
				}

				const logId = crypto.randomUUID();
				const nextCommand = `nohup bash -lc ${quoteShellArg(input.command)} >/tmp/corporation-run-command-${logId}.log 2>&1 </dev/null &`;
				await (await ensureSandboxConnected(ctx)).commands.run(nextCommand, {
					user: SANDBOX_USER,
				});
				await keepAliveSandbox(ctx);
				return null;
			}),
			input: implementer.input.handler(async ({ context, input }) => {
				const ctx = this.createContext(context.authState, context.connectionId);
				await terminalInput(ctx, input.data);
				await keepAliveSandbox(ctx);
				return null;
			}),
			resize: implementer.resize.handler(async ({ context, input }) => {
				await terminalResize(
					this.createContext(context.authState, context.connectionId),
					input.cols,
					input.rows
				);
				return null;
			}),
			getTerminalSnapshot: implementer.getTerminalSnapshot.handler(
				async ({ context }) => {
					return await getTerminalSnapshot(
						this.createContext(context.authState, context.connectionId)
					);
				}
			),
			getDesktopStreamUrl: implementer.getDesktopStreamUrl.handler(
				async ({ context }) => {
					const ctx = this.createContext(
						context.authState,
						context.connectionId
					);
					const result = await getDesktopStreamUrl(ctx);
					await keepAliveSandbox(ctx);
					return result;
				}
			),
			onSessionsChanged: implementer.onSessionsChanged.handler(
				async ({ context }) =>
					new HibernationEventIterator<SessionRow[]>((subscriptionId) => {
						this.registerBrowserSubscription(
							context.connectionId,
							"sessions.changed",
							subscriptionId
						);
					})
			),
			onTerminalOutput: implementer.onTerminalOutput.handler(
				async ({ context }) =>
					new HibernationEventIterator((subscriptionId) => {
						this.registerBrowserSubscription(
							context.connectionId,
							"terminal.output",
							subscriptionId
						);
					})
			),
		});
	}

	private createRuntimeIngressRouter() {
		const implementer = implement(runtimeIngressContract).$context<{
			connectionId: string;
			connection: RuntimeSocketConnection;
		}>();

		return implementer.router({
			register: implementer.register.handler(async ({ context, input }) => {
				log.info(
					{
						actorId: this.actorId,
						connectionId: context.connectionId,
						spaceSlug: input.spaceSlug,
						sandboxId: input.sandboxId,
						clientType: input.clientType,
					},
					"runtime ingress register received"
				);
				return await this.registerRuntimeConnection(
					context.connection.socket,
					context.connection,
					input
				);
			}),
			pushSessionEventBatch: implementer.pushSessionEventBatch.handler(
				async ({ context, input }) => {
					log.info(
						{
							actorId: this.actorId,
							connectionId: context.connectionId,
							sessionId: input.sessionId,
							turnId: input.turnId,
							eventCount: input.events.length,
						},
						"runtime ingress received session event batch"
					);
					const ctx = this.createContext(undefined, nanoid());
					await ingestRuntimeSessionEventBatch(
						ctx,
						input as RuntimeSessionEventBatchMessage
					);
					await keepAliveSandbox(ctx);
					return null;
				}
			),
			completeTurn: implementer.completeTurn.handler(
				async ({ context, input }) => {
					log.info(
						{
							actorId: this.actorId,
							connectionId: context.connectionId,
							sessionId: input.sessionId,
							turnId: input.turnId,
						},
						"runtime ingress received turn completion"
					);
					this.clearPendingCommandsForTurn(input.turnId);
					await ingestRuntimeTurnCompleted(
						this.createContext(undefined, nanoid()),
						input as RuntimeTurnCompletedMessage
					);
					return null;
				}
			),
			failTurn: implementer.failTurn.handler(async ({ context, input }) => {
				log.warn(
					{
						actorId: this.actorId,
						connectionId: context.connectionId,
						sessionId: input.sessionId,
						turnId: input.turnId,
						error: input.error.message,
					},
					"runtime ingress received turn failure"
				);
				this.clearPendingCommandsForTurn(input.turnId);
				await ingestRuntimeTurnFailed(
					this.createContext(undefined, nanoid()),
					input as RuntimeTurnFailedMessage
				);
				return null;
			}),
			commandRejected: implementer.commandRejected.handler(
				async ({ context, input }) => {
					log.warn(
						{
							actorId: this.actorId,
							connectionId: context.connectionId,
							commandId: input.commandId,
							reason: input.reason,
						},
						"runtime ingress received command rejection"
					);
					await this.handleRuntimeCommandRejected(
						input as RuntimeCommandRejectedMessage
					);
					return null;
				}
			),
			probeResult: implementer.probeResult.handler(({ context, input }) => {
				log.info(
					{
						actorId: this.actorId,
						connectionId: context.connectionId,
						commandId: input.commandId,
						agentCount: input.agents.length,
					},
					"runtime ingress received probe result"
				);
				this.handleRuntimeProbeResult(input as RuntimeProbeResultMessage);
				return null;
			}),
		});
	}

	private async persistBinding(binding: SandboxBinding | null): Promise<void> {
		this.stateData.binding = binding;
		await this.vars.db
			.insert(spaceMetadata)
			.values({
				id: 1,
				sandboxId: binding?.sandboxId ?? null,
				agentUrl: null,
			})
			.onConflictDoUpdate({
				target: spaceMetadata.id,
				set: {
					sandboxId: binding?.sandboxId ?? null,
					agentUrl: null,
				},
			});
	}

	private getActiveRuntimeSocket(): RuntimeSocketConnection | null {
		if (!this.runtimeConnectionId) {
			return null;
		}
		const connection = this.runtimeConnections.get(this.runtimeConnectionId);
		if (!connection) {
			return null;
		}
		if (connection.socket.readyState !== WebSocket.OPEN) {
			return null;
		}
		if (!connection.attachment.registeredAt) {
			return null;
		}
		return connection;
	}

	private reconcileRuntimeConnections() {
		const candidates = [...this.runtimeConnections.values()].sort(
			(left, right) =>
				compareRuntimeAttachments(left.attachment, right.attachment)
		);
		if (candidates.length === 0) {
			this.runtimeConnectionId = null;
			return;
		}

		const winner = candidates[0] ?? null;
		for (const connection of candidates.slice(1)) {
			this.runtimeConnections.delete(connection.attachment.connectionId);
			connection.socket.close(1012, "Superseded by another runtime socket");
		}

		if (!winner?.attachment.registeredAt) {
			this.runtimeConnectionId = null;
			return;
		}

		this.runtimeConnectionId = winner.attachment.connectionId;
	}

	private rejectPendingProbeRequests(reason: string) {
		for (const [commandId, pending] of this.pendingProbeRequests.entries()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
			this.pendingProbeRequests.delete(commandId);
			this.pendingRuntimeCommands.delete(commandId);
		}
	}

	private clearPendingCommandsForTurn(turnId: string) {
		for (const [commandId, metadata] of this.pendingRuntimeCommands.entries()) {
			if ("turnId" in metadata && metadata.turnId === turnId) {
				this.pendingRuntimeCommands.delete(commandId);
			}
		}
	}

	private sendToRuntime(
		message:
			| RuntimeStartTurnMessage
			| RuntimeCancelTurnMessage
			| RuntimeProbeAgentsMessage,
		metadata: RuntimeCommandMetadata
	) {
		const activeRuntime = this.getActiveRuntimeSocket();
		if (!activeRuntime) {
			throw new Error("Sandbox runtime is not connected");
		}

		log.info(
			{
				actorId: this.actorId,
				connectionId: activeRuntime.attachment.connectionId,
				commandId: metadata.commandId,
				commandType: metadata.type,
				sessionId: "sessionId" in metadata ? metadata.sessionId : null,
				turnId: "turnId" in metadata ? metadata.turnId : null,
			},
			"sending command to runtime websocket"
		);

		this.pendingRuntimeCommands.set(metadata.commandId, metadata);
		const request =
			message.type === "start_turn"
				? activeRuntime.client.startTurn(message)
				: message.type === "cancel_turn"
					? activeRuntime.client.cancelTurn(message)
					: activeRuntime.client.probeAgents(message);

		request.catch((error) => {
			this.pendingRuntimeCommands.delete(metadata.commandId);
			log.warn(
				{
					actorId: this.actorId,
					commandId: metadata.commandId,
					commandType: metadata.type,
					sessionId: "sessionId" in metadata ? metadata.sessionId : null,
					turnId: "turnId" in metadata ? metadata.turnId : null,
					error: error instanceof Error ? error.message : String(error),
				},
				"runtime websocket command promise rejected"
			);
			if (metadata.type === "probe_agents") {
				const pending = this.pendingProbeRequests.get(metadata.commandId);
				if (pending) {
					clearTimeout(pending.timer);
					this.pendingProbeRequests.delete(metadata.commandId);
					pending.reject(error);
				}
				return;
			}

			ingestRuntimeCommandRejected(
				this.createContext(undefined, nanoid()),
				{
					type: "command_rejected",
					commandId: metadata.commandId,
					reason:
						error instanceof Error
							? error.message
							: "Runtime command dispatch failed",
				},
				metadata
			);
		});
	}

	private async requestRuntimeProbe(): Promise<AgentProbeResponse> {
		if (!this.stateData.binding) {
			return emptyAgentProbeResponse("not_installed");
		}
		if (!this.getActiveRuntimeSocket()) {
			return emptyAgentProbeResponse("error");
		}

		const commandId = nanoid();
		const response = await new Promise<AgentProbeResponse>(
			(resolve, reject) => {
				const timer = setTimeout(() => {
					this.pendingProbeRequests.delete(commandId);
					this.pendingRuntimeCommands.delete(commandId);
					reject(new Error("Timed out waiting for runtime probe result"));
				}, RUNTIME_PROBE_TIMEOUT_MS);

				this.pendingProbeRequests.set(commandId, {
					resolve,
					reject,
					timer,
				});
				try {
					this.sendToRuntime(
						{
							type: "probe_agents",
							commandId,
							ids: acpAgents
								.filter((agent) => agent.runtimeCommand)
								.map((agent) => agent.id),
						},
						{
							type: "probe_agents",
							commandId,
						}
					);
				} catch (error) {
					clearTimeout(timer);
					this.pendingProbeRequests.delete(commandId);
					this.pendingRuntimeCommands.delete(commandId);
					reject(error);
				}
			}
		).catch((error) => {
			console.error("Failed to fetch agent probe state", error);
			return emptyAgentProbeResponse("error");
		});

		return response;
	}

	private async syncSandboxBinding(
		ctx: SpaceRuntimeContext,
		binding: SandboxBinding | null
	): Promise<boolean> {
		if (sameBinding(this.stateData.binding, binding)) {
			return false;
		}

		await resetTerminal(ctx);
		await this.persistBinding(binding);
		this.vars.sandbox = null;
		this.vars.sandboxPromise = null;
		this.vars.lastSandboxKeepAliveAt = 0;

		return true;
	}

	private handleBrowserSocketUpgrade(request: Request): Response {
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
			subscriptions: [],
		};

		server.serializeAttachment(attachment);
		this.ctx.acceptWebSocket(server, [BROWSER_SOCKET_TAG]);
		this.browserConnections.set(
			connectionId,
			this.createBrowserConnection(server, connectionId)
		);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	private handleRuntimeSocketUpgrade(request: Request): Response {
		const runtimeAuth = parseRuntimeAuthHeader(
			request.headers.get(SPACE_RUNTIME_AUTH_HEADER)
		);
		if (!runtimeAuth) {
			return new Response("Unauthorized", { status: 401 });
		}

		this.spaceSlug = request.headers.get(SPACE_SLUG_HEADER) ?? this.spaceSlug;
		this.key[0] = this.spaceSlug;

		// biome-ignore lint/correctness/noUndeclaredVariables: Cloudflare Workers exposes WebSocketPair globally.
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const connectionId = nanoid();
		const attachment: RuntimeSocketAttachment = {
			connectionId,
			connectedAt: Date.now(),
			registeredAt: null,
			lastSeenAt: null,
			spaceSlug: this.spaceSlug,
			auth: runtimeAuth,
		};

		server.serializeAttachment(attachment);
		this.ctx.acceptWebSocket(server, [RUNTIME_SOCKET_TAG]);
		this.runtimeConnections.set(
			connectionId,
			this.createRuntimeSocketConnection(server, attachment)
		);

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

		return new Response("Not found", { status: 404 });
	}

	private async registerRuntimeConnection(
		ws: WebSocket,
		connection: RuntimeSocketConnection,
		input: RuntimeRegisterInput
	) {
		if (input.spaceSlug !== connection.attachment.spaceSlug) {
			throw new Error("Space slug mismatch");
		}
		if (
			input.sandboxId !== connection.attachment.auth.claims.sandboxId ||
			input.clientType !== connection.attachment.auth.claims.clientType
		) {
			throw new Error("Runtime auth mismatch");
		}

		const updatedAttachment: RuntimeSocketAttachment = {
			...connection.attachment,
			registeredAt: Date.now(),
			lastSeenAt: Date.now(),
		};
		ws.serializeAttachment(updatedAttachment);
		this.runtimeConnections.set(updatedAttachment.connectionId, {
			...connection,
			attachment: updatedAttachment,
		});
		this.reconcileRuntimeConnections();
		log.info(
			{
				actorId: this.actorId,
				connectionId: updatedAttachment.connectionId,
				spaceSlug: updatedAttachment.spaceSlug,
				sandboxId: input.sandboxId,
				connectedAt: updatedAttachment.connectedAt,
				registeredAt: updatedAttachment.registeredAt,
			},
			"registered runtime websocket connection"
		);

		const ctx = this.createContext(undefined, nanoid());
		await this.syncSandboxBinding(ctx, {
			sandboxId: input.sandboxId,
		}).catch((error) => {
			console.warn("Failed to sync binding from runtime register", error);
		});

		if (this.runtimeConnectionId !== updatedAttachment.connectionId) {
			throw new Error("Superseded by another runtime socket");
		}

		return {
			connectionId: updatedAttachment.connectionId,
			connectedAt: updatedAttachment.connectedAt,
		};
	}

	private async handleRuntimeCommandRejected(
		message: RuntimeCommandRejectedMessage
	): Promise<void> {
		const metadata = this.pendingRuntimeCommands.get(message.commandId) ?? null;
		this.pendingRuntimeCommands.delete(message.commandId);
		log.warn(
			{
				actorId: this.actorId,
				commandId: message.commandId,
				commandType: metadata?.type ?? null,
				sessionId:
					metadata && "sessionId" in metadata ? metadata.sessionId : null,
				turnId: metadata && "turnId" in metadata ? metadata.turnId : null,
				reason: message.reason,
			},
			"handling runtime command rejection"
		);

		if (metadata?.type === "probe_agents") {
			const pending = this.pendingProbeRequests.get(message.commandId);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingProbeRequests.delete(message.commandId);
				pending.reject(new Error(message.reason));
			}
			return;
		}

		if (metadata?.type === "start_turn" || metadata?.type === "cancel_turn") {
			await ingestRuntimeCommandRejected(
				this.createContext(undefined, nanoid()),
				message,
				metadata
			);
		}
	}

	private handleRuntimeProbeResult(message: RuntimeProbeResultMessage): void {
		const pending = this.pendingProbeRequests.get(message.commandId);
		this.pendingRuntimeCommands.delete(message.commandId);
		if (!pending) {
			log.warn(
				{
					actorId: this.actorId,
					commandId: message.commandId,
				},
				"dropping runtime probe result with no pending request"
			);
			return;
		}

		log.info(
			{
				actorId: this.actorId,
				commandId: message.commandId,
				agentCount: message.agents.length,
			},
			"resolved runtime probe result"
		);
		clearTimeout(pending.timer);
		this.pendingProbeRequests.delete(message.commandId);
		pending.resolve({
			probedAt: message.probedAt,
			agents: message.agents,
		});
	}

	private async markRuntimeDisconnected(
		reason: string,
		options?: { connectionId?: string }
	): Promise<void> {
		log.warn(
			{
				actorId: this.actorId,
				connectionId: options?.connectionId ?? null,
				reason,
			},
			"runtime websocket disconnected"
		);
		if (options?.connectionId) {
			this.runtimeConnections.delete(options.connectionId);
			if (this.runtimeConnectionId !== options.connectionId) {
				this.reconcileRuntimeConnections();
				return;
			}
		}

		this.runtimeConnectionId = null;
		this.reconcileRuntimeConnections();
		if (this.runtimeConnectionId) {
			return;
		}
		this.rejectPendingProbeRequests(`Sandbox runtime disconnected: ${reason}`);
		this.pendingRuntimeCommands.clear();
		await failRunningSessionsForRuntimeDisconnect(
			this.createContext(undefined, nanoid()),
			reason
		);
	}

	async fetch(request: Request): Promise<Response> {
		await this.ready;
		const url = new URL(request.url);

		if (url.pathname === "/socket") {
			return this.handleBrowserSocketUpgrade(request);
		}

		if (url.pathname === "/runtime/socket") {
			return this.handleRuntimeSocketUpgrade(request);
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
		const browserAttachment =
			ws.deserializeAttachment() as BrowserSocketAttachment | null;
		if (browserAttachment && "jwtPayload" in browserAttachment.auth) {
			await this.browserRPCHandler.message(ws, message, {
				context: {
					authState: browserAttachment.auth,
					connectionId: browserAttachment.connectionId,
				},
			});
			return;
		}

		const runtimeAttachment =
			ws.deserializeAttachment() as RuntimeSocketAttachment | null;
		if (!runtimeAttachment) {
			ws.close(4401, "Missing connection attachment");
			return;
		}

		const connection = this.runtimeConnections.get(
			runtimeAttachment.connectionId
		);
		if (!connection) {
			ws.close(4401, "Missing runtime connection");
			return;
		}

		const rawMessage =
			typeof message === "string" ? message : new TextDecoder().decode(message);
		if (rawMessage === RUNTIME_HEARTBEAT_ACK_FRAME) {
			return;
		}

		const updatedAttachment: RuntimeSocketAttachment = {
			...connection.attachment,
			lastSeenAt: Date.now(),
		};
		ws.serializeAttachment(updatedAttachment);
		const updatedConnection: RuntimeSocketConnection = {
			...connection,
			attachment: updatedAttachment,
		};
		this.runtimeConnections.set(
			updatedAttachment.connectionId,
			updatedConnection
		);
		updatedConnection.peer.notifyMessage(message);
		if (!isORPCRequestFrame(message)) {
			return;
		}

		await this.runtimeIngressRPCHandler.message(ws, message, {
			context: {
				connectionId: updatedAttachment.connectionId,
				connection: updatedConnection,
			},
		});
	}

	webSocketClose(
		ws: WebSocket,
		_code: number,
		reason: string,
		_wasClean: boolean
	): void {
		const attachment = ws.deserializeAttachment() as
			| BrowserSocketAttachment
			| RuntimeSocketAttachment
			| null;
		if (!attachment) {
			return;
		}

		if ("jwtPayload" in attachment.auth) {
			this.browserConnections.delete(attachment.connectionId);
			this.browserRPCHandler.close(ws);
			return;
		}

		const connection = this.runtimeConnections.get(attachment.connectionId);
		log.warn(
			{
				actorId: this.actorId,
				connectionId: attachment.connectionId,
				code: _code,
				reason,
			},
			"runtime websocket closed"
		);
		connection?.peer.notifyClose();
		this.runtimeIngressRPCHandler.close(ws);

		this.ctx.waitUntil(
			this.markRuntimeDisconnected(reason || "socket closed", {
				connectionId: attachment.connectionId,
			})
		);
	}

	webSocketError(ws: WebSocket, error: unknown): void {
		log.error(
			{
				actorId: this.actorId,
				error: error instanceof Error ? error.message : String(error),
			},
			"space websocket error"
		);
		const attachment = ws.deserializeAttachment() as
			| BrowserSocketAttachment
			| RuntimeSocketAttachment
			| null;
		if (!(attachment && "claims" in attachment.auth)) {
			return;
		}
		this.runtimeConnections.get(attachment.connectionId)?.peer.notifyClose();
		this.runtimeIngressRPCHandler.close(ws);
		this.ctx.waitUntil(
			this.markRuntimeDisconnected(
				error instanceof Error ? error.message : "socket error",
				{
					connectionId: attachment.connectionId,
				}
			)
		);
	}
}

export type { SessionRow } from "./db/schema";
