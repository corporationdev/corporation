import type { SessionEvent } from "@corporation/contracts/sandbox-do";
import { Effect } from "effect";
import { getLatestVerifiedAuthToken } from "./auth-state";
import { type CallbackDeliveryError, toCallbackDeliveryError } from "./errors";
import {
	CALLBACK_MAX_ATTEMPTS,
	CALLBACK_TIMEOUT_MS,
	EVENT_BATCH_MAX_DELAY_MS,
	EVENT_BATCH_MAX_SIZE,
	formatError,
	postJsonWithRetry,
} from "./helpers";
import { log } from "./logging";
import type { RuntimeTurnEvent, TurnEventCallback } from "./turn-events";

const RIVET_CONN_PARAMS_HEADER = "x-rivet-conn-params";

export type HttpTurnEventCallbackInput = {
	turnId: string;
	sessionId: string;
	callbackUrl: string;
	callbackToken: string;
};

export function makeHttpTurnEventCallback(
	input: HttpTurnEventCallbackInput
): Effect.Effect<TurnEventCallback> {
	return Effect.sync(() => {
		let sequence = 0;
		let callbackChain = Promise.resolve();
		let callbackDeliveryBroken = false;
		let callbackDeliveryError: unknown = null;
		let pendingEventBatch: SessionEvent[] = [];
		let pendingEventFlushTimer: ReturnType<typeof setTimeout> | null = null;

		const clearPendingEventFlushTimer = () => {
			if (!pendingEventFlushTimer) {
				return;
			}
			clearTimeout(pendingEventFlushTimer);
			pendingEventFlushTimer = null;
		};

		const sendCallback = (
			kind: "events" | "completed" | "failed",
			extra: Record<string, unknown> = {},
			options: { force?: boolean } = {}
		): Promise<void> => {
			if (callbackDeliveryBroken && !options.force) {
				return Promise.reject(
					toCallbackDeliveryError(
						"Callback delivery unavailable after prior failure",
						callbackDeliveryError
					)
				);
			}

			sequence += 1;
			const payload = {
				turnId: input.turnId,
				sessionId: input.sessionId,
				token: input.callbackToken,
				sequence,
				kind,
				timestamp: Date.now(),
				...extra,
			};

			callbackChain = callbackChain
				.catch(() => undefined)
				.then(async () => {
					if (callbackDeliveryBroken && !options.force) {
						throw toCallbackDeliveryError(
							"Callback delivery unavailable after prior failure",
							callbackDeliveryError
						);
					}

					const runtimeAuth = getLatestVerifiedAuthToken();
					if (!runtimeAuth) {
						throw toCallbackDeliveryError(
							"Callback delivery unavailable without a verified runtime auth token"
						);
					}

					try {
						await postJsonWithRetry(
							input.callbackUrl,
							{ args: [payload] },
							CALLBACK_TIMEOUT_MS,
							CALLBACK_MAX_ATTEMPTS,
							{
								[RIVET_CONN_PARAMS_HEADER]: JSON.stringify({
									authToken: runtimeAuth.token,
								}),
							}
						);
					} catch (error) {
						if (!callbackDeliveryBroken) {
							callbackDeliveryBroken = true;
							callbackDeliveryError = error;
							log(
								"error",
								"Callback delivery failed; halting event callbacks",
								{
									turnId: input.turnId,
									sequence,
									error: formatError(error),
								}
							);
						}
						throw toCallbackDeliveryError("Callback delivery failed", error);
					}
				});

			return callbackChain;
		};

		const flushEventBatch = (options: { force?: boolean } = {}) => {
			clearPendingEventFlushTimer();
			if (pendingEventBatch.length === 0) {
				return Promise.resolve();
			}

			const events = pendingEventBatch;
			pendingEventBatch = [];
			return sendCallback("events", { events }, options);
		};

		const scheduleEventBatchFlush = () => {
			if (pendingEventFlushTimer || pendingEventBatch.length === 0) {
				return;
			}
			pendingEventFlushTimer = setTimeout(() => {
				pendingEventFlushTimer = null;
				flushEventBatch().catch((error) => {
					log("error", "Failed to flush events callback batch", {
						turnId: input.turnId,
						error: formatError(error),
					});
				});
			}, EVENT_BATCH_MAX_DELAY_MS);
		};

		const callback: TurnEventCallback = (event: RuntimeTurnEvent) =>
			Effect.tryPromise({
				try: async () => {
					if (event._tag === "SessionEvent") {
						pendingEventBatch.push(event.event);
						if (pendingEventBatch.length >= EVENT_BATCH_MAX_SIZE) {
							await flushEventBatch();
							return;
						}
						scheduleEventBatchFlush();
						return;
					}

					if (event._tag === "Completed") {
						log("info", "HTTP callback received completed event", {
							turnId: input.turnId,
							sessionId: input.sessionId,
							pendingEvents: pendingEventBatch.length,
						});
						await flushEventBatch();
						if (callbackDeliveryBroken) {
							throw toCallbackDeliveryError(
								"Callback delivery failed before completion",
								callbackDeliveryError
							);
						}
						log("info", "Sending completed callback payload", {
							turnId: input.turnId,
							sessionId: input.sessionId,
							sequence: sequence + 1,
						});
						await sendCallback("completed");
						log("info", "Completed callback payload delivered", {
							turnId: input.turnId,
							sessionId: input.sessionId,
							sequence,
						});
						return;
					}

					await flushEventBatch({ force: true }).catch(() => undefined);
					await sendCallback("failed", { error: event.error }, { force: true });
				},
				catch: (cause): CallbackDeliveryError =>
					cause instanceof Error && "_tag" in cause
						? (cause as CallbackDeliveryError)
						: toCallbackDeliveryError("HTTP turn event callback failed", cause),
			});

		return callback;
	});
}
