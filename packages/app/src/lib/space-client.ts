import type {
	SpaceSocketEventMessage,
	SpaceSocketEventName,
	SpaceSocketServerMessage,
} from "@corporation/contracts/browser-do";
import { spaceSocketServerMessageSchema } from "@corporation/contracts/browser-do";
import { env } from "@corporation/env/web";
import { nanoid } from "nanoid";
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
	private readonly pending = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (reason: unknown) => void;
		}
	>();
	private readonly statusListeners = new Set<() => void>();
	private readonly authToken: string;
	private socket: WebSocket | null = null;
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
			this.setStatus("connected");
		});

		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") {
				return;
			}
			this.handleMessage(event.data);
		});

		socket.addEventListener("close", () => {
			const pending = [...this.pending.values()];
			this.pending.clear();
			for (const entry of pending) {
				entry.reject(new Error("Space socket disconnected"));
			}
			this.socket = null;
			this.setStatus("disconnected");
			this.scheduleReconnect();
		});

		socket.addEventListener("error", () => {
			socket.close();
		});
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

	private handleMessage(raw: string) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		const message = spaceSocketServerMessageSchema.safeParse(parsed) as
			| { success: true; data: SpaceSocketServerMessage }
			| { success: false };
		if (!message.success) {
			return;
		}

		if (message.data.type === "rpc_result") {
			const pending = this.pending.get(message.data.id);
			if (!pending) {
				return;
			}
			this.pending.delete(message.data.id);
			if (message.data.ok) {
				pending.resolve(message.data.result);
			} else {
				pending.reject(new Error(message.data.error.message));
			}
			return;
		}

		this.handleEvent(message.data);
	}

	private handleEvent(message: SpaceSocketEventMessage) {
		const listeners = this.listeners.get(message.event);
		if (!listeners) {
			return;
		}
		for (const listener of listeners) {
			listener(message.payload);
		}
	}

	async call<T>(method: string, ...args: unknown[]): Promise<T> {
		const socket = this.socket;
		if (!(socket && this.status === "connected")) {
			throw new Error("Space connection unavailable");
		}
		const id = nanoid();
		const promise = new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
			});
		});
		socket.send(
			JSON.stringify({
				type: "rpc",
				id,
				method,
				args,
			})
		);
		return await promise;
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
	}
}

export type SpaceConnection = {
	syncSandboxBinding: (
		binding: {
			sandboxId: string;
			agentUrl: string;
		} | null
	) => Promise<boolean>;
	listSessions: () => Promise<unknown>;
	sendMessage: (
		sessionId: string,
		content: string,
		agent: string,
		modelId: string
	) => Promise<void>;
	cancelSession: (sessionId: string) => Promise<void>;
	getAgentProbeState: () => Promise<unknown>;
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
			syncSandboxBinding: (binding) =>
				client.call<boolean>("syncSandboxBinding", binding),
			listSessions: () => client.call("listSessions"),
			sendMessage: (sessionId, content, agent, modelId) =>
				client.call("sendMessage", sessionId, content, agent, modelId),
			cancelSession: (sessionId) => client.call("cancelSession", sessionId),
			getAgentProbeState: () => client.call("getAgentProbeState"),
			runCommand: (command, background) =>
				client.call("runCommand", command, background ?? false),
			input: (data) => client.call("input", data),
			resize: (cols, rows) => client.call("resize", cols, rows),
			getTerminalSnapshot: () => client.call("getTerminalSnapshot"),
			getDesktopStreamUrl: () => client.call("getDesktopStreamUrl"),
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
