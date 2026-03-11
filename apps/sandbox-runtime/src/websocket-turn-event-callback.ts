import { Effect } from "effect";
import { type CallbackDeliveryError, toCallbackDeliveryError } from "./errors";
import { EVENT_BATCH_MAX_DELAY_MS, EVENT_BATCH_MAX_SIZE } from "./helpers";
import { log } from "./logging";
import { RuntimeTransport } from "./runtime-transport";
import type { RuntimeTurnEvent, TurnEventCallback } from "./turn-events";

export type WebSocketTurnEventCallbackInput = {
	turnId: string;
	sessionId: string;
};

export function makeWebSocketTurnEventCallback(
	input: WebSocketTurnEventCallbackInput
): Effect.Effect<TurnEventCallback, never, RuntimeTransport> {
	return Effect.gen(function* () {
		const transport = yield* RuntimeTransport;
		let pendingEventBatch: import("@corporation/contracts/sandbox-do").SessionEvent[] =
			[];
		let pendingEventFlushTimer: ReturnType<typeof setTimeout> | null = null;

		const clearPendingEventFlushTimer = () => {
			if (!pendingEventFlushTimer) {
				return;
			}
			clearTimeout(pendingEventFlushTimer);
			pendingEventFlushTimer = null;
		};

		const flushEventBatch = () =>
			Effect.tryPromise({
				try: async () => {
					clearPendingEventFlushTimer();
					if (pendingEventBatch.length === 0) {
						return;
					}

					const events = pendingEventBatch;
					pendingEventBatch = [];
					await Effect.runPromise(
						transport.send({
							type: "session_event_batch",
							turnId: input.turnId,
							sessionId: input.sessionId,
							events,
						})
					);
				},
				catch: (cause): CallbackDeliveryError =>
					toCallbackDeliveryError(
						"Failed to flush websocket turn event batch",
						cause
					),
			});

		const scheduleEventBatchFlush = () => {
			if (pendingEventFlushTimer || pendingEventBatch.length === 0) {
				return;
			}
			pendingEventFlushTimer = setTimeout(() => {
				pendingEventFlushTimer = null;
				Effect.runPromise(
					flushEventBatch().pipe(
						Effect.catchIf(
							(_error): _error is CallbackDeliveryError => true,
							(error) => {
								log("error", "Failed to flush websocket turn event batch", {
									turnId: input.turnId,
									error,
								});
								return Effect.void;
							}
						)
					)
				).catch((error) => {
					log("error", "Failed to run websocket event batch flush", {
						turnId: input.turnId,
						error,
					});
				});
			}, EVENT_BATCH_MAX_DELAY_MS);
		};

		const callback: TurnEventCallback = (event: RuntimeTurnEvent) =>
			Effect.gen(function* () {
				if (event._tag === "SessionEvent") {
					pendingEventBatch.push(event.event);
					if (pendingEventBatch.length >= EVENT_BATCH_MAX_SIZE) {
						yield* flushEventBatch();
						return;
					}
					scheduleEventBatchFlush();
					return;
				}

				yield* flushEventBatch();
				if (event._tag === "Completed") {
					yield* transport
						.send({
							type: "turn_completed",
							turnId: input.turnId,
							sessionId: input.sessionId,
						})
						.pipe(
							Effect.mapError((error) =>
								toCallbackDeliveryError(
									"Failed to send websocket turn completion",
									error
								)
							)
						);
					return;
				}

				yield* transport
					.send({
						type: "turn_failed",
						turnId: input.turnId,
						sessionId: input.sessionId,
						error: event.error,
					})
					.pipe(
						Effect.mapError((error) =>
							toCallbackDeliveryError(
								"Failed to send websocket turn failure",
								error
							)
						)
					);
			});

		return callback;
	});
}
