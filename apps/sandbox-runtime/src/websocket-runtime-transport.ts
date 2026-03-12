/* global WebSocket */

import { runtimeControlContract } from "@corporation/contracts/orpc/runtime-control";
import type { runtimeIngressContract } from "@corporation/contracts/orpc/runtime-ingress";
import {
	type RuntimeCommandRejectedMessage,
	type RuntimeProbeResultMessage,
	runtimeClientTypeSchema,
} from "@corporation/contracts/sandbox-do";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import { Effect, Layer, Ref } from "effect";
import { RuntimeAuthState } from "./auth-state";
import {
	type RuntimeTransportUnavailableError,
	TurnConflictError,
	toRuntimeTransportUnavailableError,
} from "./errors";
import { log } from "./logging";
import { RuntimeActions } from "./runtime-actions";
import {
	RuntimeTransport,
	type RuntimeTransportMessage,
	type RuntimeTransportShape,
	type TransportStatus,
} from "./runtime-transport";
import { makeWebSocketTurnEventCallback } from "./websocket-turn-event-callback";

const HEARTBEAT_INTERVAL_MS = 30_000;
const REGISTER_PROTOCOL_VERSION = 1;
const CONNECT_TIMEOUT_MS = 15_000;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 15_000;
const HEARTBEAT_ACK_FRAME = JSON.stringify({ type: "heartbeat_ack" });

type SocketListener = Parameters<WebSocket["addEventListener"]>[1];
type SocketListenerOptions = Parameters<WebSocket["addEventListener"]>[2];
type ORPCFrameDirection = "request" | "response";

function getORPCFrameDirection(
	data: string | ArrayBufferLike | ArrayBufferView<ArrayBufferLike>
): ORPCFrameDirection | null {
	try {
		const bytes =
			typeof data === "string"
				? null
				: ArrayBuffer.isView(data)
					? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
					: new Uint8Array(data);
		const text =
			typeof data === "string" ? data : new TextDecoder().decode(bytes);
		const parsed = JSON.parse(text) as {
			p?: { u?: unknown };
		};
		return typeof parsed.p?.u === "string" ? "request" : "response";
	} catch {
		return null;
	}
}

class RuntimeWebSocketPeer {
	private readonly listeners = new Map<string, Set<SocketListener>>();
	private readonly direction: ORPCFrameDirection;
	private readonly socket: WebSocket;

	constructor(socket: WebSocket, direction: ORPCFrameDirection) {
		this.socket = socket;
		this.direction = direction;
		socket.addEventListener("open", (event) => this.emit("open", event));
		socket.addEventListener("close", (event) => this.emit("close", event));
		socket.addEventListener("error", (event) => this.emit("error", event));
		socket.addEventListener("message", (event) => {
			if (
				typeof event.data === "string" &&
				event.data === HEARTBEAT_ACK_FRAME
			) {
				return;
			}
			if (getORPCFrameDirection(event.data) !== this.direction) {
				return;
			}
			this.emit("message", event);
		});
	}

	addEventListener(
		type: string,
		listener: SocketListener,
		_options?: SocketListenerOptions
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

	send(data: string | ArrayBufferLike | ArrayBufferView<ArrayBufferLike>) {
		this.socket.send(
			data as string | ArrayBufferLike | Bun.ArrayBufferView<ArrayBufferLike>
		);
	}

	private emit(
		type: string,
		event:
			| {
					data?: string | ArrayBufferLike | ArrayBufferView<ArrayBufferLike>;
			  }
			| Event
	) {
		for (const listener of this.listeners.get(type) ?? []) {
			if (typeof listener === "function") {
				listener(event as Event);
				continue;
			}
			listener.handleEvent(event as Event);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeReconnectDelay(attempt: number): number {
	const exponential = Math.min(
		MAX_RECONNECT_DELAY_MS,
		BASE_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1)
	);
	const jitter = Math.floor(Math.random() * 250);
	return exponential + jitter;
}

function buildRegisterInput() {
	const spaceSlug = process.env.CORPORATION_SPACE_SLUG?.trim();
	const sandboxId = process.env.CORPORATION_SANDBOX_ID?.trim();
	if (!(spaceSlug && sandboxId)) {
		throw new Error(
			"Missing CORPORATION_SPACE_SLUG or CORPORATION_SANDBOX_ID env var"
		);
	}

	return {
		spaceSlug,
		sandboxId,
		clientType: runtimeClientTypeSchema.parse("sandbox_runtime"),
		protocolVersion: REGISTER_PROTOCOL_VERSION,
		capabilities: {
			sessionEventBatching: true,
			turnCancellation: true,
			agentProbing: true,
		},
	};
}

type RuntimeIngressClient = ContractRouterClient<typeof runtimeIngressContract>;

function createRuntimeIngressClient(
	socket: RuntimeWebSocketPeer
): RuntimeIngressClient {
	return createORPCClient(
		new RPCLink({
			websocket: socket,
		})
	);
}

export const WebSocketRuntimeTransportLive = Layer.effect(RuntimeTransport)(
	Effect.gen(function* () {
		const authState = yield* RuntimeAuthState;
		const runtimeActions = yield* RuntimeActions;
		const socketRef = yield* Ref.make<WebSocket | null>(null);
		const clientRef = yield* Ref.make<RuntimeIngressClient | null>(null);
		const statusRef = yield* Ref.make<TransportStatus>({
			state: "disconnected",
			reason: "initializing",
		});

		const setSocket = (socket: WebSocket | null) => Ref.set(socketRef, socket);
		const setClient = (client: RuntimeIngressClient | null) =>
			Ref.set(clientRef, client);
		const setStatus = (status: TransportStatus) => Ref.set(statusRef, status);

		const sendWithClient = (
			client: RuntimeIngressClient,
			message: RuntimeTransportMessage
		): Effect.Effect<void, RuntimeTransportUnavailableError> =>
			Effect.tryPromise({
				try: async () => {
					const logContext = {
						type: message.type,
						sessionId: "sessionId" in message ? message.sessionId : null,
						turnId: "turnId" in message ? message.turnId : null,
						commandId: "commandId" in message ? message.commandId : null,
						eventCount: "events" in message ? message.events.length : null,
					};
					log("info", "Sending runtime ingress message", logContext);
					switch (message.type) {
						case "session_event_batch":
							await client.pushSessionEventBatch(message);
							log(
								"info",
								"Sent runtime ingress session event batch",
								logContext
							);
							return;
						case "turn_completed":
							await client.completeTurn(message);
							log("info", "Sent runtime ingress turn completion", logContext);
							return;
						case "turn_failed":
							await client.failTurn(message);
							log("info", "Sent runtime ingress turn failure", logContext);
							return;
						case "probe_result":
							await client.probeResult(message as RuntimeProbeResultMessage);
							log("info", "Sent runtime ingress probe result", logContext);
							return;
						case "command_rejected":
							await client.commandRejected(
								message as RuntimeCommandRejectedMessage
							);
							log("info", "Sent runtime ingress command rejection", logContext);
							return;
						default:
							throw new Error("Unsupported runtime transport message");
					}
				},
				catch: (cause) =>
					toRuntimeTransportUnavailableError(
						"Runtime transport is not connected",
						cause
					),
			});

		const service: RuntimeTransportShape = {
			status: () => Ref.get(statusRef),
			send: (message) =>
				Effect.gen(function* () {
					const client = yield* Ref.get(clientRef);
					if (!client) {
						return yield* Effect.fail(
							toRuntimeTransportUnavailableError(
								"Runtime transport is not connected"
							)
						);
					}
					yield* sendWithClient(client, message);
				}),
		};

		const runtimeControlImplementer = implement(runtimeControlContract);
		const runtimeControlRouter = runtimeControlImplementer.router({
			startTurn: runtimeControlImplementer.startTurn.handler(
				async ({ input }) => {
					log("info", "Received runtime control startTurn", {
						commandId: input.commandId,
						turnId: input.turnId,
						sessionId: input.sessionId,
						agent: input.agent,
						modelId: input.modelId,
					});
					const onEvent = await Effect.runPromise(
						makeWebSocketTurnEventCallback({
							turnId: input.turnId,
							sessionId: input.sessionId,
						}).pipe(Effect.provideService(RuntimeTransport, service))
					);

					const result = await Effect.runPromise(
						runtimeActions
							.startTurn({
								turnId: input.turnId,
								sessionId: input.sessionId,
								agent: input.agent,
								cwd: input.cwd,
								modelId: input.modelId,
								prompt: input.prompt,
								onEvent,
							})
							.pipe(
								Effect.catchTag("TurnConflictError", (error) =>
									Effect.succeed(error)
								),
								Effect.catchTag("RuntimeActionError", (error) =>
									Effect.succeed(error)
								)
							)
					);

					if (
						result instanceof TurnConflictError ||
						(result && typeof result === "object" && "message" in result)
					) {
						await Effect.runPromise(
							service.send({
								type: "command_rejected",
								commandId: input.commandId,
								reason:
									"error" in result ? result.error : String(result.message),
							})
						).catch(() => undefined);
					}

					return null;
				}
			),
			cancelTurn: runtimeControlImplementer.cancelTurn.handler(
				async ({ input }) => {
					log("info", "Received runtime control cancelTurn", {
						commandId: input.commandId,
						turnId: input.turnId,
					});
					const cancelled = await Effect.runPromise(
						runtimeActions.cancelTurn(input.turnId)
					);
					if (!cancelled) {
						await Effect.runPromise(
							service.send({
								type: "command_rejected",
								commandId: input.commandId,
								reason: `Turn ${input.turnId} is not running`,
							})
						).catch(() => undefined);
					}
					return null;
				}
			),
			probeAgents: runtimeControlImplementer.probeAgents.handler(
				async ({ input }) => {
					log("info", "Received runtime control probeAgents", {
						commandId: input.commandId,
						agentCount: input.ids?.length ?? 0,
					});
					const response = await Effect.runPromise(
						runtimeActions.probeAgents({
							ids: input.ids,
							cwd: input.cwd,
						})
					);
					await Effect.runPromise(
						service.send({
							type: "probe_result",
							commandId: input.commandId,
							probedAt: response.probedAt,
							agents: response.agents,
						})
					).catch(() => undefined);
					return null;
				}
			),
		});

		const connectLoop = Effect.tryPromise({
			try: async () => {
				let attempt = 0;
				while (true) {
					attempt += 1;
					await Effect.runPromise(
						setStatus({
							state: "connecting",
						})
					);

					try {
						const session = await Effect.runPromise(authState.getSession());
						log("info", "Opening runtime websocket", {
							websocketUrl: session.websocketUrl,
							attempt,
						});
						const socket = await new Promise<WebSocket>((resolve, reject) => {
							const nextSocket = new WebSocket(session.websocketUrl);
							const timer = setTimeout(() => {
								nextSocket.close();
								reject(new Error("Timed out opening runtime websocket"));
							}, CONNECT_TIMEOUT_MS);

							nextSocket.addEventListener(
								"open",
								() => {
									clearTimeout(timer);
									resolve(nextSocket);
								},
								{ once: true }
							);
							nextSocket.addEventListener(
								"error",
								() => {
									clearTimeout(timer);
									reject(new Error("Runtime websocket failed to open"));
								},
								{ once: true }
							);
						});

						const ingressPeer = new RuntimeWebSocketPeer(socket, "response");
						const controlPeer = new RuntimeWebSocketPeer(socket, "request");
						const client = createRuntimeIngressClient(ingressPeer);
						const controlHandler = new RPCHandler(runtimeControlRouter);
						controlHandler.upgrade(controlPeer);
						log("info", "Runtime websocket opened", { attempt });

						await Effect.runPromise(setSocket(socket));
						await Effect.runPromise(setClient(client));

						const heartbeat = setInterval(() => {
							if (socket.readyState === WebSocket.OPEN) {
								socket.send(JSON.stringify({ type: "heartbeat" }));
							}
						}, HEARTBEAT_INTERVAL_MS);

						const register = buildRegisterInput();
						log("info", "Registering runtime websocket", register);
						const registered = await client.register(register);
						log("info", "Registered runtime websocket", registered);
						await Effect.runPromise(
							setStatus({
								state: "connected",
								connectedAt: registered.connectedAt,
							})
						);

						await new Promise<void>((resolve) => {
							socket.addEventListener(
								"close",
								() => {
									clearInterval(heartbeat);
									log("warn", "Runtime websocket closed", {
										attempt,
										readyState: socket.readyState,
									});
									resolve();
								},
								{ once: true }
							);
							socket.addEventListener(
								"error",
								() => {
									clearInterval(heartbeat);
									log("warn", "Runtime websocket emitted error event", {
										attempt,
									});
									resolve();
								},
								{ once: true }
							);
						});
					} catch (error) {
						log("warn", "Runtime websocket connection failed", {
							error: error instanceof Error ? error.message : String(error),
						});
					} finally {
						log("warn", "Resetting runtime websocket transport state", {
							attempt,
						});
						await Effect.runPromise(setSocket(null));
						await Effect.runPromise(setClient(null));
						await Effect.runPromise(
							setStatus({
								state: "disconnected",
								reason: "socket closed",
							})
						);
						await Effect.runPromise(runtimeActions.interruptAllTurns());
					}

					await sleep(computeReconnectDelay(attempt));
				}
			},
			catch: (cause) => cause,
		});

		yield* Effect.forkScoped(connectLoop);
		return service;
	})
);
