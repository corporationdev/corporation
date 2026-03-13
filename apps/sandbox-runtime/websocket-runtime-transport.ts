/* global WebSocket */

import type { RuntimeEngine } from "./index";
import type {
	RuntimeWebSocketCommand,
	RuntimeWebSocketOutgoingMessage,
} from "./runtime-websocket-protocol";
import { runtimeWebSocketCommandSchema } from "./runtime-websocket-protocol";

const SOCKET_OPEN = 1;

type SocketMessageEvent = {
	data: string | ArrayBuffer | ArrayBufferView<ArrayBufferLike>;
};

export type WebSocketLike = {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(
		type: "message",
		listener: (event: SocketMessageEvent) => void
	): void;
	addEventListener(
		type: "close" | "error",
		listener: (event: Event) => void
	): void;
};

export type WebSocketLikeFactory = (url: string) => WebSocketLike;

export type RuntimeWebSocketTransport = {
	start(): Promise<void>;
	close(): Promise<void>;
};

export function createWebSocketRuntimeTransport(options: {
	url: string;
	runtime: RuntimeEngine;
	createSocket?: WebSocketLikeFactory;
}): RuntimeWebSocketTransport {
	const createSocket =
		options.createSocket ?? ((url) => new WebSocket(url) as WebSocketLike);
	let socket: WebSocketLike | null = null;
	let unsubscribe: (() => void) | null = null;
	let commandQueue = Promise.resolve();

	const send = (message: RuntimeWebSocketOutgoingMessage): void => {
		if (!(socket && socket.readyState === SOCKET_OPEN)) {
			return;
		}
		socket.send(JSON.stringify(message));
	};

	const handleCommand = async (
		command: RuntimeWebSocketCommand
	): Promise<void> => {
		try {
			switch (command.type) {
				case "create_session":
					send({
						type: "response",
						requestId: command.requestId,
						ok: true,
						result: {
							session: await options.runtime.createSession(command.input),
						},
					});
					return;
				case "start_turn":
					send({
						type: "response",
						requestId: command.requestId,
						ok: true,
						result: {
							turnId: await options.runtime.startTurn(command.input),
						},
					});
					return;
				case "cancel_turn":
					send({
						type: "response",
						requestId: command.requestId,
						ok: true,
						result: {
							cancelled: await options.runtime.cancelTurn(command.input.turnId),
						},
					});
					return;
				case "respond_to_permission_request":
					send({
						type: "response",
						requestId: command.requestId,
						ok: true,
						result: {
							handled: await options.runtime.respondToPermissionRequest(
								command.input
							),
						},
					});
					return;
				case "get_session":
					send({
						type: "response",
						requestId: command.requestId,
						ok: true,
						result: {
							session:
								options.runtime.getSession(command.input.sessionId) ?? null,
						},
					});
					return;
				case "get_turn":
					send({
						type: "response",
						requestId: command.requestId,
						ok: true,
						result: {
							turn: options.runtime.getTurn(command.input.turnId) ?? null,
						},
					});
					return;
				default: {
					const exhaustiveCheck: never = command;
					throw new Error(
						`Unsupported websocket runtime command: ${JSON.stringify(exhaustiveCheck)}`
					);
				}
			}
		} catch (error) {
			send({
				type: "response",
				requestId: command.requestId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	return {
		start(): Promise<void> {
			if (socket) {
				return Promise.resolve();
			}

			socket = createSocket(options.url);
			unsubscribe = options.runtime.subscribe((event) => {
				send({
					type: "runtime_event",
					event,
				});
			});

			socket.addEventListener("message", (event) => {
				const payload =
					typeof event.data === "string"
						? event.data
						: new TextDecoder().decode(event.data as ArrayBuffer);
				const parsed = runtimeWebSocketCommandSchema.safeParse(
					JSON.parse(payload)
				);
				if (!parsed.success) {
					return;
				}
				commandQueue = commandQueue
					.then(() => handleCommand(parsed.data))
					.catch(() => undefined);
			});

			const cleanup = () => {
				unsubscribe?.();
				unsubscribe = null;
				socket = null;
			};

			socket.addEventListener("close", cleanup);
			socket.addEventListener("error", cleanup);
			return Promise.resolve();
		},

		close(): Promise<void> {
			unsubscribe?.();
			unsubscribe = null;
			const current = socket;
			socket = null;
			current?.close();
			return Promise.resolve();
		},
	};
}
