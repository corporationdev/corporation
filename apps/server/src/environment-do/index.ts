import { DurableObject } from "cloudflare:workers";
import type { RuntimeAccessTokenClaims } from "@corporation/contracts/runtime-auth";
import { createLogger } from "@corporation/logger";

const RUNTIME_SOCKET_TAG = "runtime";
const SPACE_RUNTIME_AUTH_HEADER = "x-space-runtime-auth";
const TEST_DEBUG_HEADER = "x-corporation-test-debug";

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
	connectionCount: number;
	connections: RuntimeConnectionSnapshot[];
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

export class EnvironmentDurableObject extends DurableObject<Env> {
	private readonly ready: Promise<void>;
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

		for (const entry of sockets) {
			this.runtimeConnections.set(
				entry.attachment.connectionId,
				entry.attachment
			);
		}
	}

	getRuntimeConnectionsSnapshot(): EnvironmentDoRuntimeConnectionsSnapshot {
		const connections = [...this.runtimeConnections.values()]
			.sort(compareRuntimeAttachments)
			.map((attachment) => ({
				connectionId: attachment.connectionId,
				connectedAt: attachment.connectedAt,
				lastSeenAt: attachment.lastSeenAt,
				userId: attachment.auth.claims.sub,
				clientId: attachment.auth.claims.sandboxId,
			}));

		return {
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
		this.runtimeConnections.set(attachment.connectionId, attachment);

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

	private handleDebugRuntimeConnections(request: Request): Response {
		if (request.headers.get(TEST_DEBUG_HEADER) !== "1") {
			return new Response("Not found", { status: 404 });
		}

		return Response.json(this.getRuntimeConnectionsSnapshot());
	}

	async fetch(request: Request): Promise<Response> {
		await this.ready;
		const url = new URL(request.url);
		if (url.pathname === "/runtime/socket") {
			return this.handleRuntimeSocketUpgrade(request);
		}
		if (url.pathname === "/debug/runtime-connections") {
			return this.handleDebugRuntimeConnections(request);
		}
		return new Response("Not found", { status: 404 });
	}

	webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): void {
		const attachment =
			ws.deserializeAttachment() as RuntimeSocketAttachment | null;
		if (!attachment) {
			ws.close(4401, "Missing connection attachment");
			return;
		}

		ws.serializeAttachment({
			...attachment,
			lastSeenAt: Date.now(),
		});
		this.runtimeConnections.set(attachment.connectionId, {
			...attachment,
			lastSeenAt: Date.now(),
		});
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
}
