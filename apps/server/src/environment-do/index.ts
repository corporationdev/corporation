import { DurableObject } from "cloudflare:workers";
import type { RequestPermissionOutcome } from "@agentclientprotocol/sdk";
import type { RuntimeAccessTokenClaims } from "@corporation/contracts/runtime-auth";
import { createLogger } from "@corporation/logger";

const RUNTIME_SOCKET_TAG = "runtime";
const SPACE_RUNTIME_AUTH_HEADER = "x-space-runtime-auth";
const RUNTIME_REQUEST_TIMEOUT_MS = 30_000;

const log = createLogger("environment-do");

type RuntimeConnectionAuthState = {
	authToken: string;
	claims: RuntimeAccessTokenClaims;
};

type RuntimeSocketAttachment = {
	connectionId: string;
	connectedAt: number;
	lastSeenAt: number | null;
	auth: RuntimeConnectionAuthState;
};

export type RuntimeConnectionSnapshot = {
	connectionId: string;
	connectedAt: number;
	lastSeenAt: number | null;
	userId: string;
	clientId: string;
};

export type EnvironmentDoRuntimeConnectionsSnapshot = {
	activeConnection: RuntimeConnectionSnapshot | null;
	activeConnectionId: string | null;
	connected: boolean;
	connectionCount: number;
	connections: RuntimeConnectionSnapshot[];
};

export type EnvironmentStreamOffset = "-1" | "now" | `${number}`;

export type EnvironmentStreamSubscriber = Readonly<{
	requesterId: string;
}>;

export type EnvironmentStreamSubscriptionSnapshot = Readonly<{
	requesterId: string;
	stream: string;
}>;

export type EnvironmentRpcErrorCode =
	| "runtime_connection_closed"
	| "runtime_connection_errored"
	| "runtime_connection_superseded"
	| "runtime_not_connected"
	| "runtime_request_already_pending"
	| "runtime_request_send_failed"
	| "runtime_request_timed_out";

export type EnvironmentRpcError = Readonly<{
	code: EnvironmentRpcErrorCode;
	message: string;
}>;

export type EnvironmentRpcResult<T> =
	| Readonly<{
			ok: true;
			value: T;
	  }>
	| Readonly<{
			ok: false;
			error: EnvironmentRpcError;
	  }>;

export type EnvironmentRuntimeSession = Readonly<{
	sessionId: string;
	activeTurnId: string | null;
	agent: string;
	cwd: string;
	model?: string;
	mode?: string;
	configOptions: Readonly<Record<string, string>>;
}>;

export type EnvironmentRuntimeCommand =
	| {
			type: "create_session";
			requestId: string;
			input: {
				sessionId: string;
				agent: string;
				cwd: string;
				model?: string;
				mode?: string;
				configOptions?: Record<string, string>;
			};
	  }
	| {
			type: "prompt";
			requestId: string;
			input: {
				sessionId: string;
				prompt: Array<{
					type: "text";
					text: string;
				}>;
				model?: string;
				mode?: string;
				configOptions?: Record<string, string>;
			};
	  }
	| {
			type: "abort";
			requestId: string;
			input: {
				sessionId: string;
			};
	  }
	| {
			type: "respond_to_permission";
			requestId: string;
			input: {
				requestId: string;
				outcome: RequestPermissionOutcome;
			};
	  }
	| {
			type: "get_session";
			requestId: string;
			input: {
				sessionId: string;
			};
	  };

export type EnvironmentRuntimeCommandResponse =
	| {
			type: "response";
			requestId: string;
			ok: true;
			result:
				| { session: EnvironmentRuntimeSession }
				| { turnId: string }
				| { aborted: boolean }
				| { handled: boolean }
				| { session: EnvironmentRuntimeSession | null };
	  }
	| {
			type: "response";
			requestId: string;
			ok: false;
			error: string;
	  };

export type EnvironmentSubscribeStreamInput = Readonly<{
	offset: EnvironmentStreamOffset;
	stream: string;
	subscriber: EnvironmentStreamSubscriber;
}>;

export type EnvironmentUnsubscribeStreamInput = Readonly<{
	stream: string;
}>;

type RuntimeHelloMessage = {
	type: "hello";
	runtime: "sandbox-runtime";
};

type PendingRuntimeRequest = {
	connectionId: string;
	resolve: (
		result: EnvironmentRpcResult<{
			response: EnvironmentRuntimeCommandResponse;
		}>
	) => void;
	timeout: ReturnType<typeof setTimeout>;
};

function okResult<T>(value: T): EnvironmentRpcResult<T> {
	return {
		ok: true,
		value,
	};
}

function errorResult(
	code: EnvironmentRpcErrorCode,
	message: string
): EnvironmentRpcResult<never> {
	return {
		ok: false,
		error: {
			code,
			message,
		},
	};
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

function compareRuntimeAttachments(
	left: RuntimeSocketAttachment,
	right: RuntimeSocketAttachment
): number {
	if (left.connectedAt !== right.connectedAt) {
		return right.connectedAt - left.connectedAt;
	}
	return right.connectionId.localeCompare(left.connectionId);
}

function parseRuntimeHelloMessage(
	message: string | ArrayBuffer
): RuntimeHelloMessage | null {
	try {
		const payload =
			typeof message === "string"
				? message
				: new TextDecoder().decode(new Uint8Array(message));
		const parsed = JSON.parse(payload) as Record<string, unknown>;
		if (parsed.type === "hello" && parsed.runtime === "sandbox-runtime") {
			return {
				type: "hello",
				runtime: "sandbox-runtime",
			};
		}
		return null;
	} catch {
		return null;
	}
}

function parseRuntimeResponseMessage(
	message: string | ArrayBuffer
): EnvironmentRuntimeCommandResponse | null {
	try {
		const payload =
			typeof message === "string"
				? message
				: new TextDecoder().decode(new Uint8Array(message));
		const parsed = JSON.parse(payload) as Record<string, unknown>;
		if (
			parsed.type !== "response" ||
			typeof parsed.requestId !== "string" ||
			typeof parsed.ok !== "boolean"
		) {
			return null;
		}

		if (parsed.ok) {
			return {
				type: "response",
				requestId: parsed.requestId,
				ok: true,
				result: parsed.result as EnvironmentRuntimeCommandResponse extends {
					ok: true;
					result: infer Result;
				}
					? Result
					: never,
			};
		}

		if (typeof parsed.error !== "string") {
			return null;
		}

		return {
			type: "response",
			requestId: parsed.requestId,
			ok: false,
			error: parsed.error,
		};
	} catch {
		return null;
	}
}

export class EnvironmentDurableObject extends DurableObject<Env> {
	private activeRuntimeConnectionId: string | null = null;
	private readonly pendingRuntimeRequests = new Map<
		string,
		PendingRuntimeRequest
	>();
	private readonly streamSubscribers = new Map<
		string,
		EnvironmentStreamSubscriber
	>();
	private readonly runtimeConnections = new Map<
		string,
		RuntimeSocketAttachment
	>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.rebuildConnectionsFromHibernation();
	}

	private rebuildConnectionsFromHibernation() {
		this.runtimeConnections.clear();
		this.activeRuntimeConnectionId = null;
		const sockets = this.ctx
			.getWebSockets(RUNTIME_SOCKET_TAG)
			.map((socket) => ({
				socket,
				attachment:
					socket.deserializeAttachment() as RuntimeSocketAttachment | null,
			}))
			.filter(
				(
					entry
				): entry is {
					socket: WebSocket;
					attachment: RuntimeSocketAttachment;
				} => entry.attachment !== null
			)
			.sort((left, right) =>
				compareRuntimeAttachments(left.attachment, right.attachment)
			);

		const active = sockets[0];
		if (!active) {
			return;
		}

		this.activeRuntimeConnectionId = active.attachment.connectionId;
		this.runtimeConnections.set(
			active.attachment.connectionId,
			active.attachment
		);

		for (const entry of sockets.slice(1)) {
			entry.socket.close(1012, "Superseded by newer runtime connection");
		}
	}

	private toRuntimeConnectionSnapshot(
		attachment: RuntimeSocketAttachment
	): RuntimeConnectionSnapshot {
		return {
			connectionId: attachment.connectionId,
			connectedAt: attachment.connectedAt,
			lastSeenAt: attachment.lastSeenAt,
			userId: attachment.auth.claims.sub,
			clientId: attachment.auth.claims.sandboxId,
		};
	}

	private closeSupersededRuntimeSockets(activeConnectionId: string): void {
		for (const socket of this.ctx.getWebSockets(RUNTIME_SOCKET_TAG)) {
			const attachment =
				socket.deserializeAttachment() as RuntimeSocketAttachment | null;
			if (!(attachment && attachment.connectionId !== activeConnectionId)) {
				continue;
			}

			this.rejectPendingRuntimeRequestsForConnection(
				attachment.connectionId,
				{
					code: "runtime_connection_superseded",
					message: "Runtime connection was superseded",
				}
			);
			this.runtimeConnections.delete(attachment.connectionId);
			socket.close(1012, "Superseded by newer runtime connection");
		}
	}

	private getActiveRuntimeSocket(): {
		socket: WebSocket;
		attachment: RuntimeSocketAttachment;
	} | null {
		const activeConnectionId = this.activeRuntimeConnectionId;
		if (!activeConnectionId) {
			return null;
		}

		for (const socket of this.ctx.getWebSockets(RUNTIME_SOCKET_TAG)) {
			const attachment =
				socket.deserializeAttachment() as RuntimeSocketAttachment | null;
			if (attachment?.connectionId === activeConnectionId) {
				return {
					socket,
					attachment,
				};
			}
		}

		this.rebuildConnectionsFromHibernation();
		return null;
	}

	private rejectPendingRuntimeRequestsForConnection(
		connectionId: string,
		error: EnvironmentRpcError
	): void {
		for (const [requestId, pending] of this.pendingRuntimeRequests) {
			if (pending.connectionId !== connectionId) {
				continue;
			}

			clearTimeout(pending.timeout);
			this.pendingRuntimeRequests.delete(requestId);
			pending.resolve({
				ok: false,
				error,
			});
		}
	}

	private hasConnectedRuntimeState(): boolean {
		return this.activeRuntimeConnectionId !== null;
	}

	private buildRuntimeConnectionsSnapshot(): EnvironmentDoRuntimeConnectionsSnapshot {
		const connections = [...this.runtimeConnections.values()]
			.sort(compareRuntimeAttachments)
			.map((attachment) => this.toRuntimeConnectionSnapshot(attachment));
		const activeConnectionAttachment =
			(this.activeRuntimeConnectionId
				? (this.runtimeConnections.get(this.activeRuntimeConnectionId) ?? null)
				: null) ?? null;

		return {
			activeConnection: activeConnectionAttachment
				? this.toRuntimeConnectionSnapshot(activeConnectionAttachment)
				: null,
			activeConnectionId: this.activeRuntimeConnectionId,
			connected: activeConnectionAttachment !== null,
			connectionCount: connections.length,
			connections,
		};
	}

	private handleRuntimeSocketUpgrade(request: Request): Response {
		const runtimeAuth = parseRuntimeAuthHeader(
			request.headers.get(SPACE_RUNTIME_AUTH_HEADER)
		);
		if (!runtimeAuth) {
			return new Response("Unauthorized", { status: 401 });
		}

		// biome-ignore lint/correctness/noUndeclaredVariables: Cloudflare Workers exposes WebSocketPair globally.
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const connectedAt = Date.now();
		const attachment: RuntimeSocketAttachment = {
			connectionId: crypto.randomUUID(),
			connectedAt,
			lastSeenAt: connectedAt,
			auth: runtimeAuth,
		};

		server.serializeAttachment(attachment);
		this.ctx.acceptWebSocket(server, [RUNTIME_SOCKET_TAG]);
		this.activeRuntimeConnectionId = attachment.connectionId;
		this.runtimeConnections.clear();
		this.runtimeConnections.set(attachment.connectionId, attachment);
		this.closeSupersededRuntimeSockets(attachment.connectionId);

		log.info(
			{
				actorId: this.ctx.id.toString(),
				connectionId: attachment.connectionId,
				userId: runtimeAuth.claims.sub,
				sandboxId: runtimeAuth.claims.sandboxId,
			},
			"accepted runtime websocket"
		);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	fetch(request: Request): Response {
		const url = new URL(request.url);
		if (url.pathname === "/runtime/socket") {
			return this.handleRuntimeSocketUpgrade(request);
		}
		return new Response("Not found", { status: 404 });
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		const attachment =
			ws.deserializeAttachment() as RuntimeSocketAttachment | null;
		if (!attachment) {
			ws.close(4401, "Missing connection attachment");
			return;
		}

		const nextAttachment = {
			...attachment,
			lastSeenAt: Date.now(),
		};
		ws.serializeAttachment(nextAttachment);
		this.runtimeConnections.set(attachment.connectionId, nextAttachment);

		const hello = parseRuntimeHelloMessage(message);
		if (hello) {
			ws.send(
				JSON.stringify({
					type: "hello_ack",
					connectionId: attachment.connectionId,
					connectedAt: attachment.connectedAt,
				})
			);
			return;
		}

		const response = parseRuntimeResponseMessage(message);
		if (!response) {
			return;
		}

		const pending = this.pendingRuntimeRequests.get(response.requestId);
		if (!(pending && pending.connectionId === attachment.connectionId)) {
			return;
		}

		clearTimeout(pending.timeout);
		this.pendingRuntimeRequests.delete(response.requestId);
		pending.resolve(
			okResult({
				response,
			})
		);
	}

	webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean
	): void {
		const attachment =
			ws.deserializeAttachment() as RuntimeSocketAttachment | null;
		if (!attachment) {
			return;
		}

		this.runtimeConnections.delete(attachment.connectionId);
		this.rejectPendingRuntimeRequestsForConnection(
			attachment.connectionId,
			{
				code: "runtime_connection_closed",
				message: "Runtime connection closed while request was in flight",
			}
		);
		if (this.activeRuntimeConnectionId === attachment.connectionId) {
			this.rebuildConnectionsFromHibernation();
		}
		log.info(
			{
				actorId: this.ctx.id.toString(),
				connectionId: attachment.connectionId,
				code,
				reason,
			},
			"runtime websocket closed"
		);
	}

	webSocketError(ws: WebSocket, error: unknown): void {
		const attachment =
			ws.deserializeAttachment() as RuntimeSocketAttachment | null;
		if (attachment) {
			this.runtimeConnections.delete(attachment.connectionId);
			this.rejectPendingRuntimeRequestsForConnection(
				attachment.connectionId,
				{
					code: "runtime_connection_errored",
					message: "Runtime connection errored while request was in flight",
				}
			);
			if (this.activeRuntimeConnectionId === attachment.connectionId) {
				this.rebuildConnectionsFromHibernation();
			}
		}
		log.error(
			{
				actorId: this.ctx.id.toString(),
				connectionId: attachment?.connectionId ?? null,
				error: error instanceof Error ? error.message : String(error),
			},
			"runtime websocket error"
		);
	}

	hasConnectedRuntime(): EnvironmentRpcResult<{ connected: boolean }> {
		return okResult({
			connected: this.hasConnectedRuntimeState(),
		});
	}

	getRuntimeConnectionsSnapshot(): EnvironmentRpcResult<{
		snapshot: EnvironmentDoRuntimeConnectionsSnapshot;
	}> {
		return okResult({
			snapshot: this.buildRuntimeConnectionsSnapshot(),
		});
	}

	getStreamSubscriptionsSnapshot(): EnvironmentRpcResult<{
		subscriptions: EnvironmentStreamSubscriptionSnapshot[];
	}> {
		return okResult({
			subscriptions: [...this.streamSubscribers.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([stream, subscriber]) => ({
					stream,
					requesterId: subscriber.requesterId,
				})),
		});
	}

	async sendRuntimeCommand(
		command: EnvironmentRuntimeCommand
	): Promise<
		EnvironmentRpcResult<{
			response: EnvironmentRuntimeCommandResponse;
		}>
	> {
		if (this.pendingRuntimeRequests.has(command.requestId)) {
			return errorResult(
				"runtime_request_already_pending",
				`Runtime request ${command.requestId} is already pending`
			);
		}

		const activeRuntime = this.getActiveRuntimeSocket();
		if (!activeRuntime) {
			return errorResult("runtime_not_connected", "Runtime is not connected");
		}

		return await new Promise<
			EnvironmentRpcResult<{
				response: EnvironmentRuntimeCommandResponse;
			}>
		>((resolve) => {
				const timeout = setTimeout(() => {
					this.pendingRuntimeRequests.delete(command.requestId);
					resolve(
						errorResult(
							"runtime_request_timed_out",
							`Timed out waiting for runtime response to ${command.requestId}`
						)
					);
				}, RUNTIME_REQUEST_TIMEOUT_MS);

				this.pendingRuntimeRequests.set(command.requestId, {
					connectionId: activeRuntime.attachment.connectionId,
					resolve,
					timeout,
				});

				try {
					activeRuntime.socket.send(JSON.stringify(command));
				} catch (error) {
					clearTimeout(timeout);
					this.pendingRuntimeRequests.delete(command.requestId);
					resolve(
						errorResult(
							"runtime_request_send_failed",
							error instanceof Error ? error.message : String(error)
						)
					);
				}
			}
		);
	}

	subscribeStream(
		input: EnvironmentSubscribeStreamInput
	): EnvironmentRpcResult<{}> {
		const activeRuntime = this.getActiveRuntimeSocket();
		if (!activeRuntime) {
			return errorResult("runtime_not_connected", "Runtime is not connected");
		}

		activeRuntime.socket.send(
			JSON.stringify({
				type: "subscribe_stream",
				stream: input.stream,
				offset: input.offset,
			})
		);
		this.streamSubscribers.set(input.stream, input.subscriber);
		return okResult({});
	}

	unsubscribeStream(
		input: EnvironmentUnsubscribeStreamInput
	): EnvironmentRpcResult<{}> {
		this.streamSubscribers.delete(input.stream);
		return okResult({});
	}
}
