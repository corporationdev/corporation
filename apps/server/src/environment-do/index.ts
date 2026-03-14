import { DurableObject } from "cloudflare:workers";
import type {
	EnvironmentRpcResult,
	EnvironmentUnsubscribeStreamInput,
} from "@corporation/contracts/environment-do";
import type {
	EnvironmentRuntimeCommand,
	EnvironmentRuntimeCommandResponse,
	EnvironmentRuntimeStreamItemsMessage,
} from "@corporation/contracts/environment-runtime";
import { createLogger } from "@corporation/logger";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import bundledMigrations from "./db/migrations";
import { schema } from "./db/schema";
import {
	compareRuntimeAttachments,
	parseRuntimeHelloMessage,
	parseRuntimeResponseMessage,
	parseRuntimeStreamItemsMessage,
} from "./protocol";
import { RuntimeCommandRouter } from "./runtime-command-router";
import { forwardStreamItemsToSubscriber } from "./stream-delivery";
import { StreamSubscriptions } from "./stream-subscriptions";
import { EnvironmentSubscriptionStore } from "./subscription-store";
import type {
	EnvironmentDoCallbackBindings,
	EnvironmentDoRuntimeConnectionsSnapshot,
	EnvironmentStreamSubscriptionSnapshot,
	EnvironmentSubscribeStreamInput,
	RuntimeConnectionAuthState,
	RuntimeConnectionSnapshot,
	RuntimeSocketAttachment,
} from "./types";

const RUNTIME_SOCKET_TAG = "runtime";
const SPACE_RUNTIME_AUTH_HEADER = "x-space-runtime-auth";

const log = createLogger("environment-do");

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

export type {
	EnvironmentDoRuntimeConnectionsSnapshot,
	EnvironmentStreamSubscriber,
	EnvironmentStreamSubscriptionSnapshot,
	EnvironmentSubscribeStreamInput,
	RuntimeConnectionSnapshot,
} from "./types";

export class EnvironmentDurableObject extends DurableObject<Env> {
	private activeRuntimeConnectionId: string | null = null;
	private readonly commandRouter = new RuntimeCommandRouter();
	private readonly ready: Promise<void>;
	private readonly runtimeConnections = new Map<
		string,
		RuntimeSocketAttachment
	>();
	private readonly streamSubscriptions = new StreamSubscriptions();
	private subscriptionStore!: EnvironmentSubscriptionStore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ready = this.initialize();
		ctx.blockConcurrencyWhile(async () => {
			await this.ready;
		});
	}

	private async notifyConvexEnvironmentConnected(claims: {
		sub: string;
		clientId: string;
	}): Promise<void> {
		const convexSiteUrl = (
			this.env as unknown as Record<string, string>
		).CORPORATION_CONVEX_SITE_URL?.trim();
		const apiKey = (
			this.env as unknown as Record<string, string>
		).CORPORATION_INTERNAL_API_KEY?.trim();
		if (!(convexSiteUrl && apiKey)) {
			log.warn(
				"Missing CORPORATION_CONVEX_SITE_URL or CORPORATION_INTERNAL_API_KEY, skipping environment connect notification"
			);
			return;
		}

		try {
			const response = await fetch(`${convexSiteUrl}/environments/connect`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					userId: claims.sub,
					clientId: claims.clientId,
					name: claims.clientId,
				}),
			});
			if (!response.ok) {
				log.warn(
					{ status: response.status },
					"environment connect notification failed"
				);
			}
		} catch (error) {
			log.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"environment connect notification error"
			);
		}
	}

	private async notifyConvexEnvironmentDisconnected(claims: {
		sub: string;
		clientId: string;
	}): Promise<void> {
		const convexSiteUrl = (
			this.env as unknown as Record<string, string>
		).CORPORATION_CONVEX_SITE_URL?.trim();
		const apiKey = (
			this.env as unknown as Record<string, string>
		).CORPORATION_INTERNAL_API_KEY?.trim();
		if (!(convexSiteUrl && apiKey)) {
			return;
		}

		try {
			const response = await fetch(`${convexSiteUrl}/environments/disconnect`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					userId: claims.sub,
					clientId: claims.clientId,
				}),
			});
			if (!response.ok) {
				log.warn(
					{ status: response.status },
					"environment disconnect notification failed"
				);
			}
		} catch (error) {
			log.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"environment disconnect notification error"
			);
		}
	}

	private async initialize(): Promise<void> {
		const db = drizzle(this.ctx.storage, { schema });
		await migrate(db, bundledMigrations);
		this.subscriptionStore = new EnvironmentSubscriptionStore(db);
		await this.restorePersistedState();
	}

	private clearStreamSubscriptions(): void {
		this.streamSubscriptions.clear();
	}

	private async restorePersistedSubscriptionsFromStore(): Promise<void> {
		this.streamSubscriptions.hydrate(await this.subscriptionStore.list());
	}

	private rebuildConnectionsFromHibernation(options?: {
		excludeConnectionId?: string;
	}): void {
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
				} =>
					entry.attachment !== null &&
					entry.attachment.connectionId !== options?.excludeConnectionId
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

	private sendSubscribeStreamToRuntime(input: {
		stream: string;
		offset: EnvironmentSubscribeStreamInput["offset"];
	}): void {
		const activeRuntime = this.getActiveRuntimeSocket();
		if (!activeRuntime) {
			return;
		}
		activeRuntime.socket.send(
			JSON.stringify({
				type: "subscribe_stream",
				stream: input.stream,
				offset: input.offset,
			})
		);
	}

	private resubscribePersistedStreamsIfRuntimeConnected(): void {
		if (this.activeRuntimeConnectionId === null) {
			return;
		}

		for (const entry of this.streamSubscriptions.list()) {
			this.sendSubscribeStreamToRuntime({
				stream: entry.stream,
				offset: entry.subscription.offset,
			});
		}
	}

	private async handleRuntimeStreamItems(
		message: EnvironmentRuntimeStreamItemsMessage
	): Promise<void> {
		const result = await forwardStreamItemsToSubscriber({
			actorId: this.ctx.id.toString(),
			bindings: this.env as unknown as EnvironmentDoCallbackBindings,
			log,
			message,
			subscription: this.streamSubscriptions.get(message.stream),
		});
		if (!(result && result.ok)) {
			return;
		}

		this.streamSubscriptions.ack({
			stream: message.stream,
			offset: result.value.committedOffset,
		});
		await this.subscriptionStore.updatePersistedOffset({
			stream: message.stream,
			offset: result.value.committedOffset,
		});
	}

	private async restorePersistedState(): Promise<void> {
		await this.restorePersistedSubscriptionsFromStore();
		this.rebuildConnectionsFromHibernation();
		this.resubscribePersistedStreamsIfRuntimeConnected();
	}

	private toRuntimeConnectionSnapshot(
		attachment: RuntimeSocketAttachment
	): RuntimeConnectionSnapshot {
		return {
			connectionId: attachment.connectionId,
			connectedAt: attachment.connectedAt,
			lastSeenAt: attachment.lastSeenAt,
			userId: attachment.auth.claims.sub,
			clientId: attachment.auth.claims.clientId,
		};
	}

	private closeSupersededRuntimeSockets(activeConnectionId: string): void {
		for (const socket of this.ctx.getWebSockets(RUNTIME_SOCKET_TAG)) {
			const attachment =
				socket.deserializeAttachment() as RuntimeSocketAttachment | null;
			if (!(attachment && attachment.connectionId !== activeConnectionId)) {
				continue;
			}

			this.commandRouter.rejectPendingForConnection(attachment.connectionId, {
				code: "runtime_connection_superseded",
				message: "Runtime connection was superseded",
			});
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

	private async handleRuntimeSocketUpgrade(
		request: Request
	): Promise<Response> {
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
		this.clearStreamSubscriptions();
		this.runtimeConnections.set(attachment.connectionId, attachment);
		this.closeSupersededRuntimeSockets(attachment.connectionId);
		await this.restorePersistedSubscriptionsFromStore();
		this.resubscribePersistedStreamsIfRuntimeConnected();

		log.info(
			{
				actorId: this.ctx.id.toString(),
				connectionId: attachment.connectionId,
				userId: runtimeAuth.claims.sub,
				clientId: runtimeAuth.claims.clientId,
			},
			"accepted runtime websocket"
		);

		void this.notifyConvexEnvironmentConnected(runtimeAuth.claims);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async fetch(request: Request): Promise<Response> {
		await this.ready;
		const url = new URL(request.url);
		if (url.pathname === "/runtime/socket") {
			return await this.handleRuntimeSocketUpgrade(request);
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

		if (parseRuntimeHelloMessage(message)) {
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
		if (response) {
			this.commandRouter.handleResponse({
				connectionId: attachment.connectionId,
				response,
			});
			return;
		}

		const streamItems = parseRuntimeStreamItemsMessage(message);
		if (!streamItems) {
			return;
		}

		void this.handleRuntimeStreamItems(streamItems);
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
		this.commandRouter.rejectPendingForConnection(attachment.connectionId, {
			code: "runtime_connection_closed",
			message: "Runtime connection closed while request was in flight",
		});
		if (this.activeRuntimeConnectionId === attachment.connectionId) {
			this.clearStreamSubscriptions();
			this.rebuildConnectionsFromHibernation({
				excludeConnectionId: attachment.connectionId,
			});
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

		if (this.runtimeConnections.size === 0) {
			void this.notifyConvexEnvironmentDisconnected(attachment.auth.claims);
		}
	}

	webSocketError(ws: WebSocket, error: unknown): void {
		const attachment =
			ws.deserializeAttachment() as RuntimeSocketAttachment | null;
		if (attachment) {
			this.runtimeConnections.delete(attachment.connectionId);
			this.commandRouter.rejectPendingForConnection(attachment.connectionId, {
				code: "runtime_connection_errored",
				message: "Runtime connection errored while request was in flight",
			});
			if (this.activeRuntimeConnectionId === attachment.connectionId) {
				this.clearStreamSubscriptions();
				this.rebuildConnectionsFromHibernation({
					excludeConnectionId: attachment.connectionId,
				});
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

		if (attachment && this.runtimeConnections.size === 0) {
			void this.notifyConvexEnvironmentDisconnected(attachment.auth.claims);
		}
	}

	async hasConnectedRuntime(): Promise<
		EnvironmentRpcResult<{ connected: boolean }>
	> {
		await this.ready;
		const activeConnectionId = this.activeRuntimeConnectionId;
		return {
			ok: true,
			value: {
				connected:
					activeConnectionId !== null &&
					this.runtimeConnections.has(activeConnectionId),
			},
		};
	}

	async getRuntimeConnectionsSnapshot(): Promise<
		EnvironmentRpcResult<{
			snapshot: EnvironmentDoRuntimeConnectionsSnapshot;
		}>
	> {
		await this.ready;
		return {
			ok: true,
			value: {
				snapshot: this.buildRuntimeConnectionsSnapshot(),
			},
		};
	}

	async getStreamSubscriptionsSnapshot(): Promise<
		EnvironmentRpcResult<{
			subscriptions: EnvironmentStreamSubscriptionSnapshot[];
		}>
	> {
		await this.ready;
		return {
			ok: true,
			value: {
				subscriptions: this.streamSubscriptions.getSnapshot(),
			},
		};
	}

	async sendRuntimeCommand(command: EnvironmentRuntimeCommand): Promise<
		EnvironmentRpcResult<{
			response: EnvironmentRuntimeCommandResponse;
		}>
	> {
		await this.ready;
		return this.commandRouter.sendCommand({
			command,
			getActiveRuntimeSocket: () => this.getActiveRuntimeSocket(),
		});
	}

	async subscribeStream(
		input: EnvironmentSubscribeStreamInput
	): Promise<EnvironmentRpcResult<{}>> {
		await this.ready;
		const result = this.streamSubscriptions.subscribe({
			activeRuntimeConnected: this.activeRuntimeConnectionId !== null,
			forwardToRuntime: ({ stream, offset }) =>
				this.sendSubscribeStreamToRuntime({ stream, offset }),
			subscription: input,
		});
		if (result.ok) {
			await this.subscriptionStore.upsert({
				stream: input.stream,
				lastPersistedOffset: input.offset,
				subscriber: input.subscriber,
			});
		}
		return result;
	}

	async unsubscribeStream(
		input: EnvironmentUnsubscribeStreamInput
	): Promise<EnvironmentRpcResult<{}>> {
		await this.ready;
		const result = this.streamSubscriptions.unsubscribe(input);
		if (result.ok) {
			await this.subscriptionStore.delete(input.stream);
		}
		return result;
	}
}
