import type {
	AgentProbeRequestBody,
	AgentProbeResponse,
	TurnRunnerError,
} from "@corporation/contracts/sandbox-do";
import { Effect, Fiber, Layer, ServiceMap } from "effect";
import { isAuthRequiredError } from "./probe-service";
import { ProbeService } from "./probe-service";
import { SessionRegistry } from "./session-registry";
import {
	type RuntimeActionError as RuntimeActionErrorType,
	TurnConflictError,
} from "./errors";
import { formatError } from "./helpers";
import { log } from "./logging";
import type { StartTurnRequest } from "./turn-events";

export type RuntimeActionsShape = {
	startTurn: (
		request: StartTurnRequest
	) => Effect.Effect<void, TurnConflictError | RuntimeActionErrorType>;
	cancelTurn: (turnId: string) => Effect.Effect<boolean>;
	probeAgents: (
		request: AgentProbeRequestBody
	) => Effect.Effect<AgentProbeResponse, RuntimeActionErrorType>;
};

export class RuntimeActions extends ServiceMap.Service<
	RuntimeActions,
	RuntimeActionsShape
>()("sandbox-runtime/RuntimeActions") {}

function toTurnRunnerError(error: unknown): TurnRunnerError {
	const formatted = formatError(error);
	return {
		name: formatted.name,
		message: formatted.message,
		stack: formatted.stack ?? null,
	};
}

export const RuntimeActionsLive = Layer.effect(RuntimeActions)(
	Effect.gen(function*() {
		const registry = yield* SessionRegistry;
		const probeService = yield* ProbeService;

		const service: RuntimeActionsShape = {
			startTurn: (request) =>
				Effect.gen(function*() {
					yield* registry.reserveTurn(request);

					const child = Effect.gen(function*() {
						try {
							const handle = yield* registry.getOrCreateSessionHandle(request);
							yield* handle.runTurn(request);
						} catch (error) {
							if (isAuthRequiredError(error)) {
								yield* registry.clearCachedVerifiedProbe(request.agent);
							}

							yield* request
								.onEvent({
										_tag: "Failed",
										error: toTurnRunnerError(error),
									})
									.pipe(
										Effect.catchIf(
											(_error): _error is import("./errors").CallbackDeliveryError => true,
											() => Effect.succeed(undefined)
										)
									);

							log("error", "Turn failed", {
								turnId: request.turnId,
								error: formatError(error),
							});
						} finally {
							yield* registry.releaseTurn(request.turnId, request.sessionId);
						}
						});

						const fiber = yield* child.pipe(Effect.forkDetach);
						yield* registry.attachTurnFiber(request.turnId, fiber);
					}),
			cancelTurn: (turnId) =>
				Effect.gen(function*() {
					const sessionId = yield* registry.getTurnSessionId(turnId);
					if (!sessionId) {
						return false;
					}

					const handle = yield* registry.getSessionHandle(sessionId);
					if (handle) {
						yield* handle.cancelActiveTurn;
						log("info", "Sent session/cancel to agent", { turnId, sessionId });
					}

					const fiber = yield* registry.getTurnFiber(turnId);
					if (fiber) {
						yield* Fiber.interrupt(fiber);
					}

					yield* registry.releaseTurn(turnId, sessionId);

					return true;
				}),
			probeAgents: (request) => probeService.probeAgents(request),
		};

		return service;
	})
);
