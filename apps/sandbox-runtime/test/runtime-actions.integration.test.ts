import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { resolve } from "node:path";
import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import type { AcpEnvelope } from "@corporation/contracts/sandbox-do";
import { Effect, Exit, Layer, Scope, ServiceMap } from "effect";
import {
	type AcpBridge,
	AcpBridgeFactory,
	type AcpBridgeFactoryShape,
} from "../src/acp-bridge";
import { isAgentInstalled } from "../src/agents";
import { toAcpBridgeError, toCallbackDeliveryError } from "../src/errors";
import {
	ProbeService,
	ProbeServiceLive,
	type ProbeServiceShape,
} from "../src/probe-service";
import { RuntimeActions, RuntimeActionsLive } from "../src/runtime-actions";
import { runtimeLayer } from "../src/runtime-layer";
import { makeSessionHandle } from "../src/session-handle";
import { SessionRegistry, SessionRegistryLive } from "../src/session-registry";
import type { RuntimeTurnEvent, StartTurnRequest } from "../src/turn-events";

const AGENT_ID = "claude-acp";
const TEST_CWD = resolve(import.meta.dir, "..");
const describeIf = isAgentInstalled(AGENT_ID) ? describe : describe.skip;

type SessionRegistryTestShape = {
	getOrCreateSessionHandle: (
		request: StartTurnRequest
	) => Effect.Effect<any, any, any>;
	getSessionHandle: (sessionId: string) => Effect.Effect<{
		agentSessionId: string;
		agent: string;
		cwd: string;
	} | null>;
	getTurnSessionId: (turnId: string) => Effect.Effect<string | null>;
};

type RuntimeActionsShape = {
	startTurn: (request: StartTurnRequest) => Effect.Effect<any, any, any>;
	cancelTurn: (turnId: string) => Effect.Effect<boolean, any, any>;
	probeAgents: (body: {
		ids?: string[];
		cwd?: string;
	}) => Effect.Effect<any, any, any>;
};

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.runPromise(effect as Effect.Effect<A, E, never>);

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

function waitFor<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

async function eventually<T>(
	read: () => Promise<T>,
	predicate: (value: T) => boolean,
	options: { timeoutMs?: number; intervalMs?: number; label: string }
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const intervalMs = options.intervalMs ?? 50;
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		const value = await read();
		if (predicate(value)) {
			return value;
		}
		await Bun.sleep(intervalMs);
	}

	throw new Error(`${options.label} timed out after ${timeoutMs}ms`);
}

function createNoopTurn(
	overrides?: Partial<StartTurnRequest>
): StartTurnRequest {
	return {
		turnId: `turn-${crypto.randomUUID()}`,
		sessionId: `session-${crypto.randomUUID()}`,
		agent: AGENT_ID,
		cwd: TEST_CWD,
		prompt: [{ type: "text", text: "Reply with OK." }],
		onEvent: () => Effect.succeed(undefined),
		...overrides,
	};
}

function createEventCollector(options?: { blockFirstSessionEvent?: boolean }) {
	const events: RuntimeTurnEvent[] = [];
	const firstSessionEvent =
		deferred<Extract<RuntimeTurnEvent, { _tag: "SessionEvent" }>>();
	const terminalEvent =
		deferred<Extract<RuntimeTurnEvent, { _tag: "Completed" | "Failed" }>>();
	const unblockFirstSessionEvent = deferred<void>();
	let sawFirstSessionEvent = false;

	return {
		events,
		onEvent: (event: RuntimeTurnEvent) =>
			Effect.tryPromise({
				try: async () => {
					events.push(event);

					if (event._tag === "SessionEvent" && !sawFirstSessionEvent) {
						sawFirstSessionEvent = true;
						firstSessionEvent.resolve(event);
						if (options?.blockFirstSessionEvent) {
							await unblockFirstSessionEvent.promise;
						}
					}

					if (event._tag === "Completed" || event._tag === "Failed") {
						terminalEvent.resolve(event);
					}
				},
				catch: (cause) =>
					toCallbackDeliveryError("Test event collector failed", cause),
			}),
		releaseFirstSessionEvent: () => {
			unblockFirstSessionEvent.resolve();
		},
		waitForFirstSessionEvent: (timeoutMs = 5000) =>
			waitFor(firstSessionEvent.promise, timeoutMs, "first session event"),
		waitForTerminalEvent: (timeoutMs = 5000) =>
			waitFor(terminalEvent.promise, timeoutMs, "terminal runtime event"),
	};
}

function outboundEnvelope(
	method: string,
	id = `${method}-${crypto.randomUUID()}`
): AcpEnvelope {
	return {
		jsonrpc: "2.0",
		id,
		method,
		params: {},
	};
}

function inboundEnvelope(id: string): AcpEnvelope {
	return {
		jsonrpc: "2.0",
		id,
		result: { ok: true },
	};
}

function createScriptedBridgeFactory(options?: {
	onPrompt?: (bridge: {
		emitSessionEventPair: () => void;
		resolvePrompt: () => void;
		waitForPrompt: Promise<void>;
		cancelCount: number;
	}) => Promise<void> | void;
}) {
	const bridges: Array<{
		cancelCount: number;
		promptCallCount: number;
		waitForPrompt: Promise<void>;
		resolvePrompt: () => void;
		emitSessionEventPair: () => void;
	}> = [];

	const factory: AcpBridgeFactoryShape = {
		make: () =>
			Effect.sync(() => {
				let sink:
					| ((envelope: AcpEnvelope, direction: "inbound" | "outbound") => void)
					| null = null;
				const promptStarted = deferred<void>();
				const promptFinished = deferred<void>();
				const promptRequestId = `${AGENT_METHODS.session_prompt}-${crypto.randomUUID()}`;

				const bridgeState = {
					cancelCount: 0,
					promptCallCount: 0,
					waitForPrompt: promptStarted.promise,
					resolvePrompt: () => promptFinished.resolve(),
					emitSessionEventPair: () => {
						sink?.(
							outboundEnvelope(AGENT_METHODS.session_prompt, promptRequestId),
							"outbound"
						);
						sink?.(inboundEnvelope(promptRequestId), "inbound");
					},
				};
				bridges.push(bridgeState);

				const bridge: AcpBridge = {
					request: (method) =>
						Effect.tryPromise({
							try: async () => {
								if (method === "initialize") {
									return {
										agentCapabilities: { loadSession: true },
									} as never;
								}
								if (method === "session/new") {
									return {
										sessionId: `agent-session-${bridges.length}`,
										configOptions: [],
										models: { currentModelId: "default" },
									} as never;
								}
								if (
									method === AGENT_METHODS.session_set_mode ||
									method === AGENT_METHODS.session_set_model
								) {
									return {} as never;
								}
								if (method === AGENT_METHODS.session_prompt) {
									bridgeState.promptCallCount += 1;
									promptStarted.resolve();
									if (options?.onPrompt) {
										await options.onPrompt(bridgeState);
									} else {
										bridgeState.emitSessionEventPair();
										bridgeState.resolvePrompt();
									}
									await promptFinished.promise;
									return {} as never;
								}

								throw new Error(
									`Unexpected ACP request method: ${String(method)}`
								);
							},
							catch: (cause) =>
								toAcpBridgeError(
									`Fake bridge request failed: ${String(method)}`,
									cause
								),
						}),
					write: (envelope) =>
						Effect.sync(() => {
							if (
								"method" in envelope &&
								envelope.method === AGENT_METHODS.session_cancel
							) {
								bridgeState.cancelCount += 1;
								bridgeState.resolvePrompt();
							}
						}).pipe(
							Effect.mapError((cause) =>
								toAcpBridgeError("Fake bridge write failed", cause)
							)
						),
					interrupt: Effect.succeed(undefined),
					isAlive: Effect.succeed(true),
					setEnvelopeSink: (nextSink) =>
						Effect.sync(() => {
							sink = nextSink;
						}),
				};

				return bridge;
			}),
	};

	return { factory, bridges };
}

describeIf("runtime actions integration", () => {
	let probeScope: Scope.Closeable | null = null;
	let probeRuntimeActions: RuntimeActionsShape;

	beforeAll(async () => {
		process.env.SANDBOX_RUNTIME_DISABLE_SESSION_MCP = "1";

		const probeLayer = await run(Scope.make());
		probeScope = probeLayer;
		const services = await run(Layer.buildWithScope(runtimeLayer, probeLayer));
		probeRuntimeActions = ServiceMap.get(
			services,
			RuntimeActions
		) as RuntimeActionsShape;

		await run(
			probeRuntimeActions.probeAgents({ ids: [AGENT_ID], cwd: TEST_CWD })
		);
	});

	afterAll(async () => {
		if (!probeScope) {
			return;
		}
		await run(Scope.close(probeScope, Exit.void));
	});

	test("probes claude-acp successfully with an explicit cwd", async () => {
		const probe = (await run(
			probeRuntimeActions.probeAgents({ ids: [AGENT_ID], cwd: TEST_CWD })
		)) as {
			agents: Array<{ id: string; status: string }>;
		};
		expect(probe.agents).toHaveLength(1);
		expect(probe.agents[0]?.id).toBe(AGENT_ID);
		expect(probe.agents[0]?.status).toBe("verified");
	});

	test("session handle drains delayed session events before emitting completed", async () => {
		const collector = createEventCollector({ blockFirstSessionEvent: true });
		const { factory } = createScriptedBridgeFactory({
			onPrompt: (bridge) => {
				bridge.emitSessionEventPair();
				bridge.resolvePrompt();
			},
		});

		const scope = await run(Scope.make());
		try {
			const handle = await run(
				makeSessionHandle({
					bridgeFactory: factory,
					sessionId: `session-handle-${crypto.randomUUID()}`,
					agent: AGENT_ID,
					cwd: TEST_CWD,
					modelId: undefined,
					previousAgentSessionId: null,
				}).pipe(Scope.provide(scope))
			);

			const runTurn = run(
				handle.runTurn(
					createNoopTurn({
						sessionId: `session-handle-${crypto.randomUUID()}`,
						onEvent: collector.onEvent,
					})
				)
			);

			await collector.waitForFirstSessionEvent();
			collector.releaseFirstSessionEvent();
			await runTurn;

			const terminal = await collector.waitForTerminalEvent();
			expect(terminal._tag).toBe("Completed");

			const sessionEvents = collector.events.filter(
				(event): event is Extract<RuntimeTurnEvent, { _tag: "SessionEvent" }> =>
					event._tag === "SessionEvent"
			);
			expect(sessionEvents.length).toBe(2);
			expect(sessionEvents[0]?.event.eventIndex).toBe(1);
			expect(sessionEvents[1]?.event.eventIndex).toBe(2);
		} finally {
			await run(Scope.close(scope, Exit.void));
		}
	});

	test("session registry reuses a live handle and rejects cwd mismatches", async () => {
		const { factory, bridges } = createScriptedBridgeFactory();
		const scope = await run(Scope.make());
		try {
			const bridgeLayer = Layer.succeed(AcpBridgeFactory)(factory);
			const services = await run(
				Layer.buildWithScope(
					SessionRegistryLive.pipe(Layer.provide(bridgeLayer)),
					scope
				)
			);
			const registry = ServiceMap.get(
				services,
				SessionRegistry
			) as unknown as SessionRegistryTestShape;

			const firstRequest = createNoopTurn({ sessionId: "shared-session" });
			const firstHandle = await run(
				registry.getSessionHandle("shared-session")
			);
			expect(firstHandle).toBeNull();

			const createdHandle = (await run(
				registry.getOrCreateSessionHandle(firstRequest)
			)) as {
				agentSessionId: string;
			};
			expect(createdHandle.agentSessionId).toBe("agent-session-1");
			expect(bridges).toHaveLength(1);

			const reusedHandle = (await run(
				registry.getOrCreateSessionHandle(
					createNoopTurn({
						turnId: "turn-reuse",
						sessionId: "shared-session",
					})
				)
			)) as {
				agentSessionId: string;
			};
			expect(reusedHandle.agentSessionId).toBe(createdHandle.agentSessionId);
			expect(bridges).toHaveLength(1);

			await expect(
				run(
					registry.getOrCreateSessionHandle(
						createNoopTurn({
							turnId: "turn-mismatch",
							sessionId: "shared-session",
							cwd: `${TEST_CWD}/other`,
						})
					)
				)
			).rejects.toMatchObject({ _tag: "RuntimeActionError" });
		} finally {
			await run(Scope.close(scope, Exit.void));
		}
	});

	test("runtime actions cancel an active turn and release the session", async () => {
		const { factory, bridges } = createScriptedBridgeFactory({
			onPrompt: (bridge) => {
				bridge.emitSessionEventPair();
				if (bridge.cancelCount > 0) {
					bridge.resolvePrompt();
				}
			},
		});
		const scope = await run(Scope.make());
		try {
			const bridgeLayer = Layer.succeed(AcpBridgeFactory)(factory);
			const sessionRegistryLayer = SessionRegistryLive.pipe(
				Layer.provide(bridgeLayer)
			);
			const probeStubLayer = Layer.succeed(ProbeService)({
				probeAgents: () =>
					Effect.succeed({
						probedAt: Date.now(),
						agents: [],
					}),
			} satisfies ProbeServiceShape);
			const runtimeLayer = Layer.mergeAll(
				sessionRegistryLayer,
				probeStubLayer,
				RuntimeActionsLive.pipe(
					Layer.provide(Layer.mergeAll(sessionRegistryLayer, probeStubLayer))
				)
			);
			const services = await run(Layer.buildWithScope(runtimeLayer, scope));
			const runtimeActions = ServiceMap.get(
				services,
				RuntimeActions
			) as RuntimeActionsShape;
			const registry = ServiceMap.get(
				services,
				SessionRegistry
			) as unknown as SessionRegistryTestShape;

			const sessionId = "cancel-session";
			const turnId = "cancel-turn";
			const collector = createEventCollector();

			await run(
				runtimeActions.startTurn(
					createNoopTurn({
						turnId,
						sessionId,
						onEvent: collector.onEvent,
					})
				)
			);

			const activeBridge = await eventually(
				async () => bridges[0] ?? null,
				(value) => value !== null,
				{ label: "bridge creation" }
			);
			if (!activeBridge) {
				throw new Error("bridge creation returned null");
			}
			await activeBridge.waitForPrompt;
			expect(await run(runtimeActions.cancelTurn(turnId))).toBe(true);
			expect(activeBridge.cancelCount).toBe(1);

			await eventually(
				() => run(registry.getTurnSessionId(turnId)),
				(value) => value === null,
				{ label: "cancelled turn release" }
			);

			bridges[0]?.resolvePrompt();
			await run(
				runtimeActions.startTurn(
					createNoopTurn({
						turnId: "cancel-turn-replacement",
						sessionId,
						onEvent: () => Effect.succeed(undefined),
					})
				)
			);
		} finally {
			await run(Scope.close(scope, Exit.void));
		}
	});
});

test("probe service maps ACP authentication failures to requires_auth", async () => {
	const { factory } = createScriptedBridgeFactory({
		onPrompt: () => {
			throw new Error("ACP error (-32000): Authentication required");
		},
	});
	const scope = await run(Scope.make());
	try {
		const bridgeLayer = Layer.succeed(AcpBridgeFactory)(factory);
		const sessionRegistryLayer = SessionRegistryLive.pipe(
			Layer.provide(bridgeLayer)
		);
		const probeLayer = ProbeServiceLive.pipe(
			Layer.provide(Layer.mergeAll(bridgeLayer, sessionRegistryLayer))
		);
		const services = await run(Layer.buildWithScope(probeLayer, scope));
		const probeService = ServiceMap.get(
			services,
			ProbeService
		) as ProbeServiceShape;

		const probe = (await run(
			probeService.probeAgents({ ids: [AGENT_ID], cwd: TEST_CWD })
		)) as {
			agents: Array<{ id: string; status: string; error: string | null }>;
		};
		const agent = probe.agents[0];
		expect(agent?.id).toBe(AGENT_ID);
		expect(agent?.status).toBe("requires_auth");
		expect(agent?.error).not.toContain("Cause([Fail");
	} finally {
		await run(Scope.close(scope, Exit.void));
	}
});
