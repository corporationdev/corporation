/* global WebSocket */

import {
	environmentRuntimeCommandSchema as runtimeWebSocketCommandSchema,
	environmentRuntimeHelloAckSchema as runtimeWebSocketHelloAckSchema,
	environmentRuntimeSubscribeStreamSchema as runtimeWebSocketSubscribeStreamSchema,
} from "@corporation/contracts/environment-runtime";
import type {
	EnvironmentRuntimeCommand as RuntimeWebSocketCommand,
	EnvironmentRuntimeOutgoingMessage as RuntimeWebSocketOutgoingMessage,
	EnvironmentRuntimeSubscribeStream as RuntimeWebSocketSubscribeStream,
} from "@corporation/contracts/environment-runtime";
import type { RuntimeEngine } from "./index";
import {
	getCommandId,
	type RuntimeMessageStore,
} from "./runtime-message-store";

const SOCKET_OPEN = 1;

type SocketMessageEvent = {
	data: string | ArrayBuffer | ArrayBufferView<ArrayBufferLike>;
};

export type WebSocketLike = {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open", listener: (event: Event) => void): void;
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
	store: RuntimeMessageStore;
	url: string;
	runtime: RuntimeEngine;
	createSocket?: WebSocketLikeFactory;
	reconnectDelayMs?: number;
}): RuntimeWebSocketTransport {
	const createSocket =
		options.createSocket ?? ((url) => new WebSocket(url) as WebSocketLike);
	const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
	let socket: WebSocketLike | null = null;
	let socketReady = false;
	let stopped = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let unsubscribe: (() => void) | null = null;
	let commandQueue = Promise.resolve();
	let activeCommandId: string | undefined;
	let started = false;

	const send = (message: RuntimeWebSocketOutgoingMessage): void => {
		if (!(socket && socket.readyState === SOCKET_OPEN && socketReady)) {
			return;
		}
		socket.send(JSON.stringify(message));
	};

	const sendStreamItems = (input: {
		items: ReturnType<RuntimeMessageStore["appendEvent"]>[];
		stream: string;
		streamClosed?: boolean;
		upToDate: boolean;
	}): void => {
		const nextOffset =
			input.items.at(-1)?.offset ??
			options.store.getCurrentOffset(input.stream);
		send({
			type: "stream_items",
			stream: input.stream,
			items: input.items.map((item) => ({
				offset: item.offset,
				eventId: item.eventId,
				commandId: item.commandId,
				createdAt: item.createdAt,
				event: item.event,
			})),
			nextOffset,
			upToDate: input.upToDate,
			streamClosed: input.streamClosed ?? false,
		});
	};

	const sendStoredEvent = (
		event: ReturnType<RuntimeMessageStore["appendEvent"]>
	): void => {
		send({
			type: "stream_items",
			stream: event.streamKey,
			items: [
				{
					offset: event.offset,
					eventId: event.eventId,
					commandId: event.commandId,
					createdAt: event.createdAt,
					event: event.event,
				},
			],
			nextOffset: event.offset,
			upToDate: true,
			streamClosed: false,
		});
	};

	const sendDuplicateResponse = (command: RuntimeWebSocketCommand): boolean => {
		const duplicateState = options.store.beginCommand(command);
		if (duplicateState.kind === "new") {
			return false;
		}

		if (
			duplicateState.receipt.status === "completed" &&
			duplicateState.receipt.result
		) {
			send({
				type: "response",
				requestId: command.requestId,
				ok: true,
				result: duplicateState.receipt.result as Exclude<
					RuntimeWebSocketOutgoingMessage,
					{ type: "stream_items" | "hello" }
				> extends { type: "response"; ok: true; result: infer Result }
					? Result
					: never,
			});
			return true;
		}

		if (duplicateState.receipt.status === "failed") {
			send({
				type: "response",
				requestId: command.requestId,
				ok: false,
				error:
					duplicateState.receipt.error ??
					`Command ${command.requestId} failed previously`,
			});
			return true;
		}

		send({
			type: "response",
			requestId: command.requestId,
			ok: false,
			error: `Command ${command.requestId} is already in progress`,
		});
		return true;
	};

	const handleCommand = async (
		command: RuntimeWebSocketCommand
	): Promise<void> => {
		if (sendDuplicateResponse(command)) {
			return;
		}

		const commandId = getCommandId(command);
		activeCommandId = commandId;

		try {
			switch (command.type) {
				case "create_session": {
					const result = {
						session: await options.runtime.createSession(command.input),
					};
					options.store.completeCommand(commandId, result);
					send({
						type: "response",
						requestId: command.requestId,
						ok: true,
						result,
					});
					return;
				}
				case "prompt": {
					const result = {
						turnId: await options.runtime.prompt(command.input),
					};
					options.store.completeCommand(commandId, result);
					send({
						type: "response",
						requestId: command.requestId,
						ok: true,
						result,
					});
					return;
				}
				case "abort": {
					const result = {
						aborted: await options.runtime.abort(command.input.sessionId),
					};
					options.store.completeCommand(commandId, result);
					send({
						type: "response",
						requestId: command.requestId,
						ok: true,
						result,
					});
					return;
				}
				case "respond_to_permission": {
					const result = {
						handled: await options.runtime.respondToPermission(command.input),
					};
					options.store.completeCommand(commandId, result);
					send({
						type: "response",
						requestId: command.requestId,
						ok: true,
						result,
					});
					return;
				}
				default: {
					const exhaustiveCheck: never = command;
					throw new Error(
						`Unsupported websocket runtime command: ${JSON.stringify(exhaustiveCheck)}`
					);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.store.failCommand(commandId, message);
			send({
				type: "response",
				requestId: command.requestId,
				ok: false,
				error: message,
			});
		} finally {
			if (activeCommandId === commandId) {
				activeCommandId = undefined;
			}
		}
	};

	const handleSubscribeStream = (
		message: RuntimeWebSocketSubscribeStream
	): void => {
		const items = options.store.getEventsAfterOffset({
			streamKey: message.stream,
			offset: message.offset,
		});
		sendStreamItems({
			stream: message.stream,
			items,
			upToDate: true,
			streamClosed: false,
		});
	};

	const clearReconnectTimer = (): void => {
		if (!reconnectTimer) {
			return;
		}
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	};

	const scheduleReconnect = (): void => {
		if (stopped || reconnectTimer || socket) {
			return;
		}
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			void connectSocket();
		}, reconnectDelayMs);
	};

	const cleanupSocket = (currentSocket: WebSocketLike): void => {
		if (socket !== currentSocket) {
			return;
		}
		socket = null;
		socketReady = false;
		if (started) {
			scheduleReconnect();
		}
	};

	const connectSocket = (): Promise<void> => {
		const currentSocket = createSocket(options.url);
		socket = currentSocket;
		socketReady = false;

		return new Promise<void>((resolve, reject) => {
			let settled = false;
			let helloAckReceived = false;

			const finish = (callback: () => void) => {
				if (settled) {
					return;
				}
				settled = true;
				callback();
			};

			const sendHello = () => {
				if (!(socket === currentSocket && currentSocket.readyState === SOCKET_OPEN)) {
					return;
				}
				currentSocket.send(
					JSON.stringify({
						type: "hello",
						runtime: "sandbox-runtime",
					})
				);
			};

			currentSocket.addEventListener("message", (event) => {
				if (socket !== currentSocket) {
					return;
				}

				const payload =
					typeof event.data === "string"
						? event.data
						: new TextDecoder().decode(event.data as ArrayBuffer);
				const message = JSON.parse(payload) as unknown;
				const helloAck = runtimeWebSocketHelloAckSchema.safeParse(message);
				if (helloAck.success) {
					helloAckReceived = true;
					socketReady = true;
					started = true;
					finish(resolve);
					return;
				}
				const subscribeStream =
					runtimeWebSocketSubscribeStreamSchema.safeParse(message);
				if (subscribeStream.success) {
					handleSubscribeStream(subscribeStream.data);
					return;
				}
				const parsed = runtimeWebSocketCommandSchema.safeParse(message);
				if (!parsed.success) {
					return;
				}
				commandQueue = commandQueue
					.then(() => handleCommand(parsed.data))
					.catch(() => undefined);
			});

			currentSocket.addEventListener("close", () => {
				const shouldReject = !started && !helloAckReceived;
				cleanupSocket(currentSocket);
				if (shouldReject) {
					finish(() =>
						reject(
							new Error("WebSocket closed before hello acknowledgement")
						)
					);
				}
			});

			currentSocket.addEventListener("error", () => {
				const shouldReject = !started && !helloAckReceived;
				cleanupSocket(currentSocket);
				if (shouldReject) {
					finish(() => reject(new Error("WebSocket connection failed")));
				}
			});

			if (currentSocket.readyState === SOCKET_OPEN) {
				sendHello();
				return;
			}

			currentSocket.addEventListener("open", () => {
				if (socket !== currentSocket) {
					return;
				}
				sendHello();
			});
		});
	};

	return {
		start(): Promise<void> {
			if (socket) {
				return Promise.resolve();
			}
			stopped = false;
			clearReconnectTimer();
			unsubscribe ??= options.runtime.subscribe((event) => {
				sendStoredEvent(
					options.store.appendEvent({
						commandId: activeCommandId,
						event,
					})
				);
			});
			return connectSocket();
		},

		close(): Promise<void> {
			stopped = true;
			clearReconnectTimer();
			const current = socket;
			socket = null;
			socketReady = false;
			unsubscribe?.();
			unsubscribe = null;
			current?.close();
			return Promise.resolve();
		},
	};
}
