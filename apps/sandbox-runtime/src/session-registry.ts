import type { AgentProbeAgent } from "@corporation/contracts/sandbox-do";
import { Effect, Exit, Fiber, Layer, Ref, Scope, ServiceMap } from "effect";
import { AcpBridgeFactory } from "./acp-bridge";
import {
	type RuntimeActionError,
	SessionReuseError,
	TurnConflictError,
	toRuntimeActionError,
} from "./errors";
import { log } from "./logging";
import { makeSessionHandle, type SessionHandle } from "./session-handle";
import type { StartTurnRequest } from "./turn-events";

type VerifiedProbeEntry = {
	verifiedAt: number;
};

type ManagedSessionHandle = {
	handle: SessionHandle;
	scope: Scope.Closeable;
};

type SessionRegistryState = {
	activeTurns: Map<string, string>;
	activeSessionTurns: Map<string, string>;
	activeTurnFibers: Map<string, Fiber.Fiber<void, unknown>>;
	sessionHandles: Map<string, ManagedSessionHandle>;
	previousAgentSessionIds: Map<string, string>;
	verifiedProbeByAgent: Map<string, VerifiedProbeEntry>;
	inFlightProbeByAgent: Map<string, Promise<AgentProbeAgent>>;
};

type SessionRegistryShape = {
	reserveTurn: (
		request: StartTurnRequest
	) => Effect.Effect<void, TurnConflictError>;
	releaseTurn: (turnId: string, sessionId: string) => Effect.Effect<void>;
	attachTurnFiber: (
		turnId: string,
		fiber: Fiber.Fiber<void, unknown>
	) => Effect.Effect<void>;
	getTurnFiber: (
		turnId: string
	) => Effect.Effect<Fiber.Fiber<void, unknown> | null>;
	getTurnSessionId: (turnId: string) => Effect.Effect<string | null>;
	getOrCreateSessionHandle: (
		request: StartTurnRequest
	) => Effect.Effect<SessionHandle, SessionReuseError | RuntimeActionError>;
	getSessionHandle: (sessionId: string) => Effect.Effect<SessionHandle | null>;
	clearCachedVerifiedProbe: (agent: string) => Effect.Effect<void>;
	getVerifiedProbeEntry: (
		agent: string
	) => Effect.Effect<VerifiedProbeEntry | null>;
	setVerifiedProbeEntry: (
		agent: string,
		entry: VerifiedProbeEntry | null
	) => Effect.Effect<void>;
	getInFlightProbe: (
		agent: string
	) => Effect.Effect<Promise<AgentProbeAgent> | null>;
	setInFlightProbe: (
		agent: string,
		promise: Promise<AgentProbeAgent> | null
	) => Effect.Effect<void>;
	interruptAllTurns: () => Effect.Effect<void>;
};

export class SessionRegistry extends ServiceMap.Service<
	SessionRegistry,
	SessionRegistryShape
>()("sandbox-runtime/SessionRegistry") {}

function emptyState(): SessionRegistryState {
	return {
		activeTurns: new Map(),
		activeSessionTurns: new Map(),
		activeTurnFibers: new Map(),
		sessionHandles: new Map(),
		previousAgentSessionIds: new Map(),
		verifiedProbeByAgent: new Map(),
		inFlightProbeByAgent: new Map(),
	};
}

export const SessionRegistryLive = Layer.effect(SessionRegistry)(
	Effect.gen(function* () {
		const bridgeFactory = yield* AcpBridgeFactory;
		const stateRef = yield* Ref.make(emptyState());

		const discardDeadHandle = (sessionId: string) =>
			Effect.gen(function* () {
				const managedHandle = yield* Ref.modify(stateRef, (state) => {
					const nextSessionHandles = new Map(state.sessionHandles);
					const nextPreviousAgentSessionIds = new Map(
						state.previousAgentSessionIds
					);
					const existing = state.sessionHandles.get(sessionId) ?? null;
					if (existing) {
						nextSessionHandles.delete(sessionId);
						nextPreviousAgentSessionIds.set(
							sessionId,
							existing.handle.agentSessionId
						);
					}

					return [
						existing,
						{
							...state,
							sessionHandles: nextSessionHandles,
							previousAgentSessionIds: nextPreviousAgentSessionIds,
						},
					] as const;
				});

				if (!managedHandle) {
					return;
				}

				yield* Scope.close(managedHandle.scope, Exit.void);
				log("info", "Session bridge dead, discarding", { sessionId });
			});

		const registry: SessionRegistryShape = {
			reserveTurn: (request) =>
				Effect.gen(function* () {
					const hasConflict = yield* Ref.modify(stateRef, (state) => {
						if (state.activeTurns.has(request.turnId)) {
							return [
								new TurnConflictError({
									error: "Turn already in progress",
								}),
								state,
							] as const;
						}
						if (state.activeSessionTurns.has(request.sessionId)) {
							return [
								new TurnConflictError({
									error: "Session already has an active turn",
								}),
								state,
							] as const;
						}

						const nextActiveTurns = new Map(state.activeTurns);
						const nextActiveSessionTurns = new Map(state.activeSessionTurns);
						nextActiveTurns.set(request.turnId, request.sessionId);
						nextActiveSessionTurns.set(request.sessionId, request.turnId);

						return [
							null,
							{
								...state,
								activeTurns: nextActiveTurns,
								activeSessionTurns: nextActiveSessionTurns,
							},
						] as const;
					});

					if (hasConflict) {
						return yield* Effect.fail(hasConflict);
					}
				}),
			releaseTurn: (turnId, sessionId) =>
				Ref.update(stateRef, (state) => {
					const nextActiveTurns = new Map(state.activeTurns);
					const nextActiveSessionTurns = new Map(state.activeSessionTurns);
					const nextActiveTurnFibers = new Map(state.activeTurnFibers);
					if (nextActiveTurns.get(turnId) === sessionId) {
						nextActiveTurns.delete(turnId);
					}
					if (nextActiveSessionTurns.get(sessionId) === turnId) {
						nextActiveSessionTurns.delete(sessionId);
					}
					nextActiveTurnFibers.delete(turnId);
					return {
						...state,
						activeTurns: nextActiveTurns,
						activeSessionTurns: nextActiveSessionTurns,
						activeTurnFibers: nextActiveTurnFibers,
					};
				}),
			attachTurnFiber: (turnId, fiber) =>
				Ref.update(stateRef, (state) => {
					const nextActiveTurnFibers = new Map(state.activeTurnFibers);
					nextActiveTurnFibers.set(turnId, fiber);
					return {
						...state,
						activeTurnFibers: nextActiveTurnFibers,
					};
				}),
			getTurnFiber: (turnId) =>
				Ref.get(stateRef).pipe(
					Effect.map((state) => state.activeTurnFibers.get(turnId) ?? null)
				),
			getTurnSessionId: (turnId) =>
				Ref.get(stateRef).pipe(
					Effect.map((state) => state.activeTurns.get(turnId) ?? null)
				),
			getSessionHandle: (sessionId) =>
				Effect.gen(function* () {
					const managedHandle = yield* Ref.get(stateRef).pipe(
						Effect.map((state) => state.sessionHandles.get(sessionId) ?? null)
					);
					if (!managedHandle) {
						return null;
					}

					const alive = yield* managedHandle.handle.isAlive;
					if (!alive) {
						yield* discardDeadHandle(sessionId);
						return null;
					}

					return managedHandle.handle;
				}),
			getOrCreateSessionHandle: (request) =>
				Effect.gen(function* () {
					const existing = yield* registry.getSessionHandle(request.sessionId);
					if (existing) {
						if (existing.agent !== request.agent) {
							return yield* Effect.fail(
								new SessionReuseError({
									message: `Cannot reuse session ${request.sessionId}: agent changed from "${existing.agent}" to "${request.agent}"`,
								})
							);
						}
						if (existing.cwd !== request.cwd) {
							return yield* Effect.fail(
								new SessionReuseError({
									message: `Cannot reuse session ${request.sessionId}: cwd changed from "${existing.cwd}" to "${request.cwd}"`,
								})
							);
						}
						return existing;
					}

					const previousAgentSessionId = yield* Ref.modify(
						stateRef,
						(state) => {
							const nextPreviousAgentSessionIds = new Map(
								state.previousAgentSessionIds
							);
							const previous =
								nextPreviousAgentSessionIds.get(request.sessionId) ?? null;
							nextPreviousAgentSessionIds.delete(request.sessionId);
							return [
								previous,
								{
									...state,
									previousAgentSessionIds: nextPreviousAgentSessionIds,
								},
							] as const;
						}
					);

					const scope = yield* Scope.make();
					const handle = yield* makeSessionHandle({
						bridgeFactory,
						sessionId: request.sessionId,
						agent: request.agent,
						cwd: request.cwd,
						modelId: request.modelId,
						previousAgentSessionId,
					}).pipe(Scope.provide(scope));

					yield* Ref.update(stateRef, (state) => {
						const nextSessionHandles = new Map(state.sessionHandles);
						nextSessionHandles.set(request.sessionId, { handle, scope });
						return { ...state, sessionHandles: nextSessionHandles };
					});

					return handle;
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.fail(
							toRuntimeActionError(
								`Failed to get or create session handle for ${request.sessionId}`,
								cause
							)
						)
					)
				),
			clearCachedVerifiedProbe: (agent) =>
				Ref.update(stateRef, (state) => {
					const nextVerifiedProbeByAgent = new Map(state.verifiedProbeByAgent);
					nextVerifiedProbeByAgent.delete(agent);
					return { ...state, verifiedProbeByAgent: nextVerifiedProbeByAgent };
				}),
			getVerifiedProbeEntry: (agent) =>
				Ref.get(stateRef).pipe(
					Effect.map((state) => state.verifiedProbeByAgent.get(agent) ?? null)
				),
			setVerifiedProbeEntry: (agent, entry) =>
				Ref.update(stateRef, (state) => {
					const nextVerifiedProbeByAgent = new Map(state.verifiedProbeByAgent);
					if (entry) {
						nextVerifiedProbeByAgent.set(agent, entry);
					} else {
						nextVerifiedProbeByAgent.delete(agent);
					}
					return { ...state, verifiedProbeByAgent: nextVerifiedProbeByAgent };
				}),
			getInFlightProbe: (agent) =>
				Ref.get(stateRef).pipe(
					Effect.map((state) => state.inFlightProbeByAgent.get(agent) ?? null)
				),
			setInFlightProbe: (agent, promise) =>
				Ref.update(stateRef, (state) => {
					const nextInFlightProbeByAgent = new Map(state.inFlightProbeByAgent);
					if (promise) {
						nextInFlightProbeByAgent.set(agent, promise);
					} else {
						nextInFlightProbeByAgent.delete(agent);
					}
					return { ...state, inFlightProbeByAgent: nextInFlightProbeByAgent };
				}),
			interruptAllTurns: () =>
				Effect.gen(function* () {
					const fibers = yield* Ref.modify(stateRef, (state) => {
						return [
							Array.from(state.activeTurnFibers.values()),
							{
								...state,
								activeTurns: new Map(),
								activeSessionTurns: new Map(),
								activeTurnFibers: new Map(),
							},
						] as const;
					});

					for (const fiber of fibers) {
						yield* Fiber.interrupt(fiber);
					}
				}),
		};

		return registry;
	})
);
