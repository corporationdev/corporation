import crypto from "node:crypto";
import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import type { AcpEnvelope, SessionEvent } from "@corporation/contracts/sandbox-do";
import { Effect, Ref, Scope } from "effect";
import type { AcpBridgeFactoryShape } from "./acp-bridge";
import { setModelOrThrow, type AcpBridge } from "./acp-bridge";
import {
	RuntimeActionError,
	toRuntimeActionError,
} from "./errors";
import { ACP_PROTOCOL_VERSION } from "./helpers";
import { log } from "./logging";
import { buildSessionMcpServers } from "./mcp-tools";
import { sessionCancelEnvelopeSchema } from "./schemas";
import type { StartTurnRequest } from "./turn-events";

export type SessionHandle = {
	agent: string;
	cwd: string;
	agentSessionId: string;
	modelId: string | undefined;
	runTurn: (turn: StartTurnRequest) => Effect.Effect<void, RuntimeActionError>;
	cancelActiveTurn: Effect.Effect<boolean>;
	isAlive: Effect.Effect<boolean>;
};

type MakeSessionHandleParams = {
	bridgeFactory: AcpBridgeFactoryShape;
	sessionId: string;
	agent: string;
	cwd: string;
	modelId: string | undefined;
	previousAgentSessionId: string | null;
};

async function bootstrapSessionBridge(params: {
	bridge: AcpBridge;
	sessionId: string;
	agent: string;
	cwd: string;
	modelId: string | undefined;
	previousAgentSessionId: string | null;
}): Promise<string> {
	const { bridge, sessionId, agent, cwd, modelId, previousAgentSessionId } =
		params;

	await Effect.runPromise(Effect.sleep(250));

	const alive = await Effect.runPromise(bridge.isAlive);
	if (!alive) {
		throw new Error(`Agent ${agent} exited immediately during bootstrap`);
	}

	const initResult = await Effect.runPromise(
		bridge.request("initialize", {
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientInfo: { name: "sandbox-runtime", version: "v1" },
		})
	);

	const supportsLoad = initResult.agentCapabilities?.loadSession === true;
	let agentSessionId: string | null = null;

	if (supportsLoad && previousAgentSessionId) {
		try {
			await Effect.runPromise(
				bridge.request("session/load", {
					sessionId: previousAgentSessionId,
					cwd,
					mcpServers: buildSessionMcpServers(cwd),
				})
			);
			agentSessionId = previousAgentSessionId;
		} catch (error) {
			log("warn", "session/load failed, falling back to session/new", {
				sessionId,
				previousAgentSessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (!agentSessionId) {
		const sessionResult = await Effect.runPromise(
			bridge.request("session/new", {
				cwd,
				mcpServers: buildSessionMcpServers(cwd),
			})
		);
		agentSessionId = sessionResult.sessionId;
		if (!agentSessionId) {
			throw new Error("session/new did not return a sessionId");
		}
	}

	try {
		await Effect.runPromise(
			bridge.request(AGENT_METHODS.session_set_mode, {
				sessionId: agentSessionId,
				modeId: "bypassPermissions",
			})
		);
	} catch (error) {
		log("warn", "Failed to set bypassPermissions mode", {
			sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	if (modelId) {
		await Effect.runPromise(setModelOrThrow(bridge, agentSessionId, modelId));
	}

	return agentSessionId;
}

export function makeSessionHandle(
	params: MakeSessionHandleParams
): Effect.Effect<SessionHandle, RuntimeActionError, Scope.Scope> {
	return Effect.gen(function*() {
		const bridge = yield* params.bridgeFactory.make(params.agent);
		const activeTurnIdRef = yield* Ref.make<string | null>(null);
		const agentSessionId = yield* Effect.tryPromise({
			try: () => bootstrapSessionBridge({ bridge, ...params }),
			catch: (cause) =>
				toRuntimeActionError(
					`Failed to bootstrap session bridge for ${params.agent}`,
					cause
				),
		});

		const handle: SessionHandle = {
			agent: params.agent,
			cwd: params.cwd,
			agentSessionId,
			modelId: params.modelId,
			isAlive: bridge.isAlive,
			cancelActiveTurn: Effect.gen(function*() {
				const activeTurnId = yield* Ref.get(activeTurnIdRef);
				if (!activeTurnId) {
					return false;
				}
				const cancelEnvelope = sessionCancelEnvelopeSchema.parse({
					jsonrpc: "2.0",
					method: AGENT_METHODS.session_cancel,
					params: { sessionId: handle.agentSessionId },
				});
				yield* bridge.write(cancelEnvelope).pipe(
					Effect.catchIf(
						(_error): _error is import("./errors").AcpBridgeError => true,
						() => Effect.succeed(undefined)
					)
				);
				return true;
			}),
			runTurn: (turn) =>
				Effect.gen(function*() {
					const currentActiveTurnId = yield* Ref.get(activeTurnIdRef);
					if (currentActiveTurnId && currentActiveTurnId !== turn.turnId) {
						return yield* Effect.fail(
							toRuntimeActionError(
								`Session ${turn.sessionId} is already reserved for turn ${currentActiveTurnId}`
							)
						);
					}

					if (handle.modelId !== turn.modelId && turn.modelId) {
						yield* setModelOrThrow(bridge, handle.agentSessionId, turn.modelId).pipe(
							Effect.mapError((error) =>
								toRuntimeActionError(
									`Failed to set model for session ${turn.sessionId}`,
									error
								)
							)
						);
					}
					handle.modelId = turn.modelId;

					let eventIndex = 0;
					const connectionId = `sandbox-runtime-${turn.turnId}-${crypto.randomUUID()}`;
					let deliveryChain = Promise.resolve();
					let deliveryError: unknown = null;

					const queueSessionEventDelivery = (event: SessionEvent): void => {
						deliveryChain = deliveryChain
							.then(() =>
								Effect.runPromise(turn.onEvent({ _tag: "SessionEvent", event }))
							)
							.catch((error) => {
								if (!deliveryError) {
									deliveryError = error;
								}
								throw error;
							});
					};

					yield* Ref.set(activeTurnIdRef, turn.turnId);
					yield* bridge.setEnvelopeSink((envelope: AcpEnvelope, direction) => {
						eventIndex += 1;
						queueSessionEventDelivery({
							id: crypto.randomUUID(),
							eventIndex,
							sessionId: turn.sessionId,
							createdAt: Date.now(),
							connectionId,
							sender: direction === "outbound" ? "client" : "agent",
							payload: envelope,
						});
					});

					try {
						yield* bridge.request(AGENT_METHODS.session_prompt, {
							sessionId: handle.agentSessionId,
							prompt: turn.prompt,
						}).pipe(
							Effect.mapError((error) =>
								toRuntimeActionError(
									`Failed to execute prompt for session ${turn.sessionId}`,
									error
								)
							)
						);
						log("info", "Turn prompt completed, draining queued session events", {
							turnId: turn.turnId,
							sessionId: turn.sessionId,
							agentSessionId: handle.agentSessionId,
						});
						yield* Effect.tryPromise({
							try: () => deliveryChain,
							catch: (cause) => cause,
						}).pipe(
							Effect.mapError((error) =>
								toRuntimeActionError(
									`Failed delivering session events for ${turn.sessionId}`,
									error
								)
							)
						);
						if (deliveryError) {
							return yield* Effect.fail(
								toRuntimeActionError(
									`Failed delivering session events for ${turn.sessionId}`,
									deliveryError
								)
							);
						}
						log("info", "Delivering terminal completed event", {
							turnId: turn.turnId,
							sessionId: turn.sessionId,
							agentSessionId: handle.agentSessionId,
						});
						yield* turn.onEvent({ _tag: "Completed" }).pipe(
							Effect.mapError((error) =>
								toRuntimeActionError(
									`Failed delivering completion event for ${turn.sessionId}`,
									error
								)
							)
						);
						log("info", "Terminal completed event delivered", {
							turnId: turn.turnId,
							sessionId: turn.sessionId,
							agentSessionId: handle.agentSessionId,
						});
						} finally {
							yield* bridge.setEnvelopeSink(null);
							yield* Ref.set(activeTurnIdRef, null);
						}
					}),
			};

		return handle;
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.fail(
					toRuntimeActionError(
						`Failed to initialize session handle for ${params.sessionId}`,
						cause
					)
				)
			)
		);
	}
