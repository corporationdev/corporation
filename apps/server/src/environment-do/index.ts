import { DurableObject } from "cloudflare:workers";
import type { RuntimeAccessTokenClaims } from "@corporation/contracts/runtime-auth";
import { createLogger } from "@corporation/logger";

const RUNTIME_SOCKET_TAG = "runtime";
const SPACE_RUNTIME_AUTH_HEADER = "x-space-runtime-auth";

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

type RuntimeHelloMessage = {
	type: "hello";
	runtime: "sandbox-runtime";
};

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

function compareRuntimeAttachments(left: RuntimeSocketAttachment, right: RuntimeSocketAttachment): number {
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
		if (
			parsed.type === "hello" &&
			parsed.runtime === "sandbox-runtime"
		) {
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

export class EnvironmentDurableObject extends DurableObject<Env> {
	private readonly ready: Promise<void>;
	private activeRuntimeConnectionId: string | null = null;
	private readonly runtimeConnections = new Map<string, RuntimeSocketAttachment>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ready = this.initialize();
		ctx.blockConcurrencyWhile(async () => {
			await this.ready;
		});
	}

	private async initialize(): Promise<void> {
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

			this.runtimeConnections.delete(attachment.connectionId);
			socket.close(1012, "Superseded by newer runtime connection");
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
				? this.runtimeConnections.get(this.activeRuntimeConnectionId) ?? null
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

	async fetch(request: Request): Promise<Response> {
		await this.ready;
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
		if (!hello) {
			return;
		}

		ws.send(
			JSON.stringify({
				type: "hello_ack",
				connectionId: attachment.connectionId,
				connectedAt: attachment.connectedAt,
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

	async hasConnectedRuntime(): Promise<boolean> {
		await this.ready;
		return this.hasConnectedRuntimeState();
	}

	async getRuntimeConnectionsSnapshot(): Promise<EnvironmentDoRuntimeConnectionsSnapshot> {
		await this.ready;
		return this.buildRuntimeConnectionsSnapshot();
	}
}
