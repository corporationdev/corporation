import type {
	SessionRow,
	SpaceSocketEventName,
	TerminalOutputPayload,
} from "@corporation/contracts/browser-do";
import type { browserSpaceContract } from "@corporation/contracts/orpc/browser-space";
import type { AgentProbeResponse } from "@corporation/contracts/sandbox-do";
import { env } from "@corporation/env/web";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { toAbsoluteUrl } from "./url";

type Listener = (payload: unknown) => void;

function buildSocketUrl(spaceSlug: string, authToken: string): string {
	const baseUrl = new URL(toAbsoluteUrl(env.VITE_CORPORATION_SERVER_URL));
	baseUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
	baseUrl.pathname = `/api/spaces/${encodeURIComponent(spaceSlug)}/socket`;
	baseUrl.search = new URLSearchParams({ token: authToken }).toString();
	return baseUrl.toString();
}

class SpaceSocketClient {
	private readonly listeners = new Map<SpaceSocketEventName, Set<Listener>>();
	private readonly statusListeners = new Set<() => void>();
	private readonly authToken: string;
	private socket: WebSocket | null = null;
	private client: ContractRouterClient<typeof browserSpaceContract> | null =
		null;
	private disposed = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;
	private readonly spaceSlug: string;
	private status: "connecting" | "connected" | "disconnected" = "disconnected";

	constructor(spaceSlug: string, authToken: string) {
		this.spaceSlug = spaceSlug;
		this.authToken = authToken;
	}

	getStatus() {
		return this.status;
	}

	subscribeStatus(listener: () => void) {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	subscribe(eventName: SpaceSocketEventName, listener: Listener) {
		const listeners = this.listeners.get(eventName) ?? new Set<Listener>();
		listeners.add(listener);
		this.listeners.set(eventName, listeners);

		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) {
				this.listeners.delete(eventName);
			}
		};
	}

	private emitStatus() {
		for (const listener of this.statusListeners) {
			listener();
		}
	}

	private emitEvent(eventName: SpaceSocketEventName, payload: unknown) {
		for (const listener of this.listeners.get(eventName) ?? []) {
			listener(payload);
		}
	}

	private setStatus(status: "connecting" | "connected" | "disconnected") {
		if (this.status === status) {
			return;
		}
		this.status = status;
		this.emitStatus();
	}

	connect() {
		if (this.disposed || this.socket) {
			return;
		}

		this.setStatus("connecting");
		const socket = new WebSocket(
			buildSocketUrl(this.spaceSlug, this.authToken)
		);
		this.socket = socket;

		socket.addEventListener("open", () => {
			this.reconnectAttempt = 0;
			this.client = createORPCClient<
				ContractRouterClient<typeof browserSpaceContract>
			>(
				new RPCLink({
					websocket: socket,
				})
			);
			this.setStatus("connected");
			this.startSubscriptions(socket);
		});

		socket.addEventListener("close", () => {
			this.client = null;
			this.socket = null;
			this.setStatus("disconnected");
			this.scheduleReconnect();
		});

		socket.addEventListener("error", () => {
			socket.close();
		});
	}

	private startSubscriptions(socket: WebSocket) {
		const client = this.client;
		if (!client) {
			return;
		}

		this.consumeSubscription(
			socket,
			"sessions.changed",
			Promise.resolve(client.onSessionsChanged())
		);
		this.consumeSubscription(
			socket,
			"terminal.output",
			Promise.resolve(client.onTerminalOutput())
		);
	}

	private async consumeSubscription(
		socket: WebSocket,
		eventName: "sessions.changed" | "terminal.output",
		iteratorPromise: Promise<
			AsyncIterable<SessionRow[] | TerminalOutputPayload>
		>
	) {
		try {
			const iterator = await iteratorPromise;
			for await (const payload of iterator) {
				if (this.socket !== socket || this.disposed) {
					return;
				}
				this.emitEvent(eventName, payload);
			}
		} catch (error) {
			if (this.socket === socket && !this.disposed) {
				console.error(`Space subscription failed: ${eventName}`, error);
			}
		}
	}

	private scheduleReconnect() {
		if (this.disposed || this.reconnectTimer) {
			return;
		}
		const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 5000);
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	private getClient() {
		if (!(this.client && this.socket && this.status === "connected")) {
			throw new Error("Space connection unavailable");
		}
		return this.client;
	}

	dispose() {
		this.disposed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.socket) {
			this.socket.close(1000, "Disposed");
			this.socket = null;
		}
		this.client = null;
	}

	async syncSandboxBinding(
		binding: {
			sandboxId: string;
		} | null
	): Promise<boolean> {
		return await this.getClient().syncSandboxBinding({ binding });
	}

	async listSessions(): Promise<SessionRow[]> {
		return await this.getClient().listSessions();
	}

	async sendMessage(
		sessionId: string,
		content: string,
		agent: string,
		modelId: string
	): Promise<void> {
		await this.getClient().sendMessage({
			sessionId,
			content,
			agent,
			modelId,
		});
	}

	async cancelSession(sessionId: string): Promise<void> {
		await this.getClient().cancelSession({ sessionId });
	}

	async probeAgents(ids: string[]): Promise<AgentProbeResponse> {
		return await this.getClient().probeAgents({ ids });
	}

	async runCommand(command: string, background = false): Promise<void> {
		await this.getClient().runCommand({ command, background });
	}

	async input(data: number[]): Promise<void> {
		await this.getClient().input({ data });
	}

	async resize(cols: number, rows: number): Promise<void> {
		await this.getClient().resize({ cols, rows });
	}

	async getTerminalSnapshot(): Promise<boolean> {
		return await this.getClient().getTerminalSnapshot();
	}

	async getDesktopStreamUrl(): Promise<string> {
		return await this.getClient().getDesktopStreamUrl();
	}
}

export type SpaceConnection = {
	syncSandboxBinding: (
		binding: {
			sandboxId: string;
		} | null
	) => Promise<boolean>;
	listSessions: () => Promise<SessionRow[]>;
	sendMessage: (
		sessionId: string,
		content: string,
		agent: string,
		modelId: string
	) => Promise<void>;
	cancelSession: (sessionId: string) => Promise<void>;
	probeAgents: (ids: string[]) => Promise<AgentProbeResponse>;
	runCommand: (command: string, background?: boolean) => Promise<void>;
	input: (data: number[]) => Promise<void>;
	resize: (cols: number, rows: number) => Promise<void>;
	getTerminalSnapshot: () => Promise<boolean>;
	getDesktopStreamUrl: () => Promise<string>;
};

export type SpaceActor = {
	subscribe:
		| ((eventName: SpaceSocketEventName, listener: Listener) => () => void)
		| null;
	connStatus: "connecting" | "connected" | "disconnected";
	connection: SpaceConnection | null;
	opts: {
		key: string[];
	};
};

export function useSpaceEvent(
	actor: SpaceActor,
	eventName: SpaceSocketEventName,
	listener: Listener
) {
	useEffect(
		() => actor.subscribe?.(eventName, listener),
		[actor.subscribe, eventName, listener]
	);
}

export function useSpaceSocketClient(
	spaceSlug: string | undefined,
	authToken: string | undefined,
	enabled: boolean
): SpaceActor {
	const client = useMemo(() => {
		if (!(enabled && spaceSlug && authToken)) {
			return null;
		}
		return new SpaceSocketClient(spaceSlug, authToken);
	}, [authToken, enabled, spaceSlug]);

	useEffect(() => {
		if (!client) {
			return;
		}
		client.connect();
		return () => {
			client.dispose();
		};
	}, [client]);

	const status = useSyncExternalStore(
		(listener) => client?.subscribeStatus(listener) ?? (() => undefined),
		() => client?.getStatus() ?? "disconnected",
		() => client?.getStatus() ?? "disconnected"
	);

	const connection = useMemo<SpaceConnection | null>(() => {
		if (!(client && status === "connected")) {
			return null;
		}

		return {
			syncSandboxBinding: (binding) => client.syncSandboxBinding(binding),
			listSessions: () => client.listSessions(),
			sendMessage: (sessionId, content, agent, modelId) =>
				client.sendMessage(sessionId, content, agent, modelId),
			cancelSession: (sessionId) => client.cancelSession(sessionId),
			probeAgents: (ids) => client.probeAgents(ids),
			runCommand: (command, background) =>
				client.runCommand(command, background ?? false),
			input: (data) => client.input(data),
			resize: (cols, rows) => client.resize(cols, rows),
			getTerminalSnapshot: () => client.getTerminalSnapshot(),
			getDesktopStreamUrl: () => client.getDesktopStreamUrl(),
		};
	}, [client, status]);

	return {
		subscribe: client
			? (eventName, listener) => client.subscribe(eventName, listener)
			: null,
		connStatus: status,
		connection,
		opts: {
			key: spaceSlug ? [spaceSlug] : ["__disconnected__"],
		},
	};
}
