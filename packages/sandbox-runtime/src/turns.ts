import crypto from "node:crypto";
import type {
	PromptRequestBody,
	SessionEvent,
} from "@corporation/shared/session-protocol";
import { turnRunnerCallbackPayloadSchema } from "@corporation/shared/session-protocol";
import {
	CALLBACK_MAX_ATTEMPTS,
	CALLBACK_TIMEOUT_MS,
	EVENT_BATCH_MAX_DELAY_MS,
	EVENT_BATCH_MAX_SIZE,
	formatError,
	postJsonWithRetry,
} from "./helpers";
import { log } from "./logging";
import {
	bootstrapSessionBridge,
	getSessionBridge,
	maybeHandlePermissionRequest,
	maybeSetModel,
	type SessionBridge,
	sessionBridges,
} from "./session-bridge";
import {
	type StdioBridge,
	spawnStdioBridge,
	stdioRequest,
	teardownBridge,
} from "./stdio-bridge";

// ---------------------------------------------------------------------------
// Turn reservation state
// ---------------------------------------------------------------------------

export const activeTurns = new Map<string, string>(); // turnId -> sessionId
export const activeSessionTurns = new Map<string, string>(); // sessionId -> turnId

export function releaseTurnReservation(
	turnId: string,
	sessionId: string
): void {
	if (activeTurns.get(turnId) === sessionId) {
		activeTurns.delete(turnId);
	}
	if (activeSessionTurns.get(sessionId) === turnId) {
		activeSessionTurns.delete(sessionId);
	}
}

export function hasTurnReservation(turnId: string, sessionId: string): boolean {
	return (
		activeTurns.get(turnId) === sessionId &&
		activeSessionTurns.get(sessionId) === turnId
	);
}

function ensureTurnReservation(turnId: string, sessionId: string): boolean {
	if (hasTurnReservation(turnId, sessionId)) {
		return true;
	}
	log("warn", "Skipping executeTurn without matching reservation", {
		turnId,
		sessionId,
	});
	releaseTurnReservation(turnId, sessionId);
	return false;
}

// ---------------------------------------------------------------------------
// Bridge initialization (lives here to avoid circular deps with session-bridge)
// ---------------------------------------------------------------------------

async function initBridge(
	sessionId: string,
	agent: string,
	cwd: string,
	modelId: string | undefined,
	queueEnvelopeEvent: (
		envelope: Record<string, unknown>,
		direction: "inbound" | "outbound"
	) => void,
	pendingTurnId: string
): Promise<SessionBridge> {
	log("info", "Spawning new agent subprocess", { agent, sessionId });

	const sessionBridge: SessionBridge = {
		bridge: null as unknown as StdioBridge,
		agentSessionId: "",
		agent,
		cwd,
		modelId,
		activeTurnId: pendingTurnId,
		onEvent: queueEnvelopeEvent,
	};

	const bridge = spawnStdioBridge(
		agent,
		(envelope) => {
			maybeHandlePermissionRequest(bridge, envelope);
		},
		(envelope, direction) => {
			sessionBridge.onEvent?.(envelope, direction);
		}
	);
	sessionBridge.bridge = bridge;
	let bootstrapComplete = false;
	try {
		sessionBridge.agentSessionId = await bootstrapSessionBridge(
			bridge,
			sessionId,
			agent,
			cwd,
			modelId
		);
		if (!hasTurnReservation(pendingTurnId, sessionId)) {
			throw new Error(
				`Turn reservation for ${pendingTurnId} was released before bridge bootstrap completed`
			);
		}

		sessionBridges.set(sessionId, sessionBridge);
		bootstrapComplete = true;
		return sessionBridge;
	} finally {
		if (!bootstrapComplete) {
			teardownBridge(bridge, {
				agent,
				sessionId,
				reason: "initBridge bootstrap failed before sessionBridges.set",
			});
			sessionBridge.bridge = null as unknown as StdioBridge;
		}
	}
}

async function getOrInitSessionBridgeForTurn(params: {
	turnId: string;
	sessionId: string;
	agent: string;
	cwd: string;
	modelId: string | undefined;
	queueEnvelopeEvent: (
		envelope: Record<string, unknown>,
		direction: "inbound" | "outbound"
	) => void;
}): Promise<SessionBridge> {
	const { turnId, sessionId, agent, cwd, modelId, queueEnvelopeEvent } = params;

	const sessionBridge = getSessionBridge(sessionId);
	if (!sessionBridge) {
		return initBridge(
			sessionId,
			agent,
			cwd,
			modelId,
			queueEnvelopeEvent,
			turnId
		);
	}

	if (sessionBridge.agent !== agent) {
		throw new Error(
			`Cannot reuse session ${sessionId}: agent changed from "${sessionBridge.agent}" to "${agent}"`
		);
	}
	if (sessionBridge.cwd !== cwd) {
		throw new Error(
			`Cannot reuse session ${sessionId}: cwd changed from "${sessionBridge.cwd}" to "${cwd}"`
		);
	}

	await maybeSetModel(sessionBridge, modelId);

	log("info", "Reusing existing session bridge", {
		sessionId,
		agentSessionId: sessionBridge.agentSessionId,
	});
	if (sessionBridge.activeTurnId && sessionBridge.activeTurnId !== turnId) {
		throw new Error(
			`Session ${sessionId} is already reserved for turn ${sessionBridge.activeTurnId}`
		);
	}
	sessionBridge.activeTurnId = turnId;
	sessionBridge.onEvent = queueEnvelopeEvent;
	return sessionBridge;
}

// ---------------------------------------------------------------------------
// Callback dispatcher
// ---------------------------------------------------------------------------

function createTurnCallbackDispatcher(params: {
	turnId: string;
	sessionId: string;
	callbackToken: string;
	callbackUrl: string;
	connectionId: string;
}): {
	queueEnvelopeEvent: (
		envelope: Record<string, unknown>,
		direction: "inbound" | "outbound"
	) => void;
	finalizeSuccess: () => Promise<void>;
	finalizeFailure: (error: unknown) => Promise<void>;
	cleanup: () => void;
} {
	const { turnId, sessionId, callbackToken, callbackUrl, connectionId } =
		params;
	let eventIndex = 0;
	let sequence = 0;
	let callbackChain = Promise.resolve();
	let callbackDeliveryBroken = false;
	let callbackDeliveryError: unknown = null;
	let droppedEventCallbacks = 0;
	let hasLoggedDroppedEvents = false;
	let pendingEventBatch: SessionEvent[] = [];
	let pendingEventFlushTimer: ReturnType<typeof setTimeout> | null = null;

	const logEventBatchFlushError = (error: unknown): void => {
		log("error", "Failed to flush events callback batch", {
			turnId,
			error: formatError(error),
		});
	};

	const sendCallback = (
		kind: string,
		extra: Record<string, unknown> = {},
		options: { force?: boolean } = {}
	): Promise<void> => {
		if (callbackDeliveryBroken && !options.force) {
			return Promise.reject(
				new Error("Callback delivery unavailable after prior failure")
			);
		}

		sequence += 1;
		const payload = turnRunnerCallbackPayloadSchema.parse({
			turnId,
			sessionId,
			token: callbackToken,
			sequence,
			kind,
			timestamp: Date.now(),
			...extra,
		});

		callbackChain = callbackChain
			.catch(() => undefined)
			.then(async () => {
				if (callbackDeliveryBroken && !options.force) {
					throw new Error("Callback delivery unavailable after prior failure");
				}
				try {
					await postJsonWithRetry(
						callbackUrl,
						{ args: [payload] },
						CALLBACK_TIMEOUT_MS,
						CALLBACK_MAX_ATTEMPTS
					);
				} catch (error) {
					if (!callbackDeliveryBroken) {
						callbackDeliveryBroken = true;
						callbackDeliveryError = error;
						log("error", "Callback delivery failed; halting event callbacks", {
							turnId,
							sequence,
							error: formatError(error),
						});
					}
					throw error;
				}
			});

		return callbackChain;
	};

	const logDroppedEvents = () => {
		if (hasLoggedDroppedEvents) {
			return;
		}
		hasLoggedDroppedEvents = true;
		log("warn", "Dropping events callbacks after callback delivery failure", {
			turnId,
			droppedEventCallbacks,
		});
	};

	const clearPendingEventFlushTimer = () => {
		if (!pendingEventFlushTimer) {
			return;
		}
		clearTimeout(pendingEventFlushTimer);
		pendingEventFlushTimer = null;
	};

	const flushEventBatch = (
		options: { force?: boolean } = {}
	): Promise<void> => {
		clearPendingEventFlushTimer();
		if (pendingEventBatch.length === 0) {
			return Promise.resolve();
		}

		const events = pendingEventBatch;
		pendingEventBatch = [];

		if (callbackDeliveryBroken && !options.force) {
			droppedEventCallbacks += events.length;
			logDroppedEvents();
			return Promise.resolve();
		}

		return sendCallback("events", { events }, options);
	};

	const scheduleEventBatchFlush = (): void => {
		if (pendingEventFlushTimer || pendingEventBatch.length === 0) {
			return;
		}
		pendingEventFlushTimer = setTimeout(() => {
			pendingEventFlushTimer = null;
			flushEventBatch().catch(logEventBatchFlushError);
		}, EVENT_BATCH_MAX_DELAY_MS);
	};

	const queueEnvelopeEvent = (
		envelope: Record<string, unknown>,
		direction: "inbound" | "outbound"
	): void => {
		if (callbackDeliveryBroken) {
			droppedEventCallbacks += 1;
			logDroppedEvents();
			return;
		}

		eventIndex += 1;
		const event: SessionEvent = {
			id: crypto.randomUUID(),
			eventIndex,
			sessionId,
			createdAt: Date.now(),
			connectionId,
			sender: direction === "outbound" ? "client" : "agent",
			payload: envelope,
		};
		pendingEventBatch.push(event);
		if (pendingEventBatch.length >= EVENT_BATCH_MAX_SIZE) {
			flushEventBatch().catch(logEventBatchFlushError);
			return;
		}
		scheduleEventBatchFlush();
	};

	const finalizeSuccess = async (): Promise<void> => {
		await flushEventBatch();
		if (callbackDeliveryBroken) {
			throw new Error(
				`Callback delivery failed before completion: ${
					callbackDeliveryError instanceof Error
						? callbackDeliveryError.message
						: String(callbackDeliveryError)
				}`
			);
		}
		await sendCallback("completed");
		await callbackChain.catch(() => undefined);
	};

	const finalizeFailure = async (error: unknown): Promise<void> => {
		await flushEventBatch({ force: true }).catch(logEventBatchFlushError);
		await sendCallback(
			"failed",
			{ error: formatError(error) },
			{ force: true }
		).catch((callbackError) => {
			log("error", "Failed to deliver terminal failed callback", {
				turnId,
				error: formatError(callbackError),
			});
		});
		await callbackChain.catch(() => undefined);
	};

	const cleanup = (): void => {
		clearPendingEventFlushTimer();
		pendingEventBatch = [];
	};

	return {
		queueEnvelopeEvent,
		finalizeSuccess,
		finalizeFailure,
		cleanup,
	};
}

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

export async function executeTurn(params: PromptRequestBody): Promise<void> {
	const {
		turnId,
		sessionId,
		agent,
		modelId,
		prompt,
		cwd,
		callbackUrl,
		callbackToken,
	} = params;

	log("info", "executeTurn started", {
		turnId,
		sessionId,
		agent,
		modelId,
		cwd,
		callbackUrl,
	});
	if (!ensureTurnReservation(turnId, sessionId)) {
		return;
	}

	const callbacks = createTurnCallbackDispatcher({
		turnId,
		sessionId,
		callbackToken,
		callbackUrl,
		connectionId: `sandbox-runtime-${turnId}-${crypto.randomUUID()}`,
	});
	let sessionBridge: SessionBridge | null = null;

	try {
		sessionBridge = await getOrInitSessionBridgeForTurn({
			turnId,
			sessionId,
			agent,
			cwd,
			modelId,
			queueEnvelopeEvent: callbacks.queueEnvelopeEvent,
		});

		const promptResult = await stdioRequest(
			sessionBridge.bridge,
			"session/prompt",
			{
				sessionId: sessionBridge.agentSessionId,
				prompt,
			}
		);

		if ("error" in promptResult) {
			throw new Error(`Prompt ACP error: ${JSON.stringify(promptResult)}`);
		}

		await callbacks.finalizeSuccess();
	} catch (error) {
		await callbacks.finalizeFailure(error);
		log("error", "Turn failed", { turnId, error: formatError(error) });
	} finally {
		callbacks.cleanup();
		if (sessionBridge) {
			if (sessionBridge.activeTurnId === turnId) {
				sessionBridge.activeTurnId = null;
			}
			sessionBridge.onEvent = null;
		}
		releaseTurnReservation(turnId, sessionId);
	}
}
