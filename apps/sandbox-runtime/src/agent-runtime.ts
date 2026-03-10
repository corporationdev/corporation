import crypto from "node:crypto";
import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import type {
	AcpEnvelope,
	AgentProbeAgent,
	AgentProbeRequestBody,
	AgentProbeResponse,
	PromptRequestBody,
	SessionEvent,
} from "@corporation/contracts/sandbox-do";
import { turnRunnerCallbackPayloadSchema } from "@corporation/contracts/sandbox-do";
import { getLatestVerifiedAuthToken } from "./auth-state";
import { isAuthRequiredError, probeAgents } from "./agent-probe";
import {
	ACP_PROTOCOL_VERSION,
	CALLBACK_MAX_ATTEMPTS,
	CALLBACK_TIMEOUT_MS,
	EVENT_BATCH_MAX_DELAY_MS,
	EVENT_BATCH_MAX_SIZE,
	formatError,
	pickPermissionOption,
	postJsonWithRetry,
} from "./helpers";
import { log } from "./logging";
import {
	sessionCancelEnvelopeSchema,
	sessionRequestPermissionEnvelopeSchema,
	sessionRequestPermissionResponseEnvelopeSchema,
} from "./schemas";
import {
	type StdioBridge,
	spawnStdioBridge,
	stdioRequest,
	stdioWrite,
	teardownBridge,
} from "./stdio-bridge";

const RIVET_CONN_PARAMS_HEADER = "x-rivet-conn-params";

type SessionBridge = {
	bridge: StdioBridge;
	agentSessionId: string;
	agent: string;
	cwd: string;
	modelId: string | undefined;
	activeTurnId: string | null;
	onEvent:
		| ((envelope: AcpEnvelope, direction: "inbound" | "outbound") => void)
		| null;
};

type VerifiedProbeEntry = {
	verifiedAt: number;
};

// ---------------------------------------------------------------------------
// Standalone helpers (no class state needed)
// ---------------------------------------------------------------------------

function maybeHandlePermissionRequest(
	bridge: StdioBridge,
	envelope: AcpEnvelope
): void {
	if (!("method" in envelope)) {
		return;
	}

	if (envelope.method !== CLIENT_METHODS.session_request_permission) {
		return;
	}

	const requestResult =
		sessionRequestPermissionEnvelopeSchema.safeParse(envelope);
	if (!requestResult.success) {
		return;
	}

	const options = requestResult.data.params.options;
	const selected = pickPermissionOption(options);

	const response = sessionRequestPermissionResponseEnvelopeSchema.parse({
		jsonrpc: "2.0",
		id: requestResult.data.id,
		result: {
			outcome: selected
				? { outcome: "selected", optionId: selected.optionId }
				: { outcome: "cancelled" },
		},
	});
	stdioWrite(bridge, response);
}

function isUnsupportedMethodError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return msg.includes("(-32601)");
}

function buildDesktopMcpServers() {
	return [
		{
			name: "desktop",
			command: "bun",
			args: ["/usr/local/bin/sandbox-runtime.js", "mcp", "desktop"],
			env: [],
		},
	];
}

async function setModelOrThrow(
	bridge: StdioBridge,
	agentSessionId: string,
	modelId: string
): Promise<void> {
	try {
		await stdioRequest(bridge, AGENT_METHODS.session_set_model, {
			sessionId: agentSessionId,
			modelId,
		});
	} catch (error) {
		if (isUnsupportedMethodError(error)) {
			log("warn", "session/set_model not supported by agent, skipping", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		throw error;
	}
}

function createTurnCallbackDispatcher(params: {
	turnId: string;
	sessionId: string;
	callbackToken: string;
	callbackUrl: string;
	connectionId: string;
}): {
	queueEnvelopeEvent: (
		envelope: AcpEnvelope,
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
				const runtimeAuth = getLatestVerifiedAuthToken();
				if (!runtimeAuth) {
					throw new Error(
						"Callback delivery unavailable without a verified runtime auth token"
					);
				}
				try {
					await postJsonWithRetry(
						callbackUrl,
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
		envelope: AcpEnvelope,
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
// AgentRuntime class
// ---------------------------------------------------------------------------

export class AgentRuntime {
	private readonly activeTurns = new Map<string, string>();
	private readonly activeSessionTurns = new Map<string, string>();
	private readonly sessionBridges = new Map<string, SessionBridge>();
	private readonly previousAgentSessionIds = new Map<string, string>();
	private readonly verifiedProbeByAgent = new Map<string, VerifiedProbeEntry>();
	private readonly inFlightProbeByAgent = new Map<
		string,
		Promise<AgentProbeAgent>
	>();

	// -- Public API ----------------------------------------------------------

	reserveTurn(body: PromptRequestBody): { error: string } | null {
		if (this.activeTurns.has(body.turnId)) {
			return { error: "Turn already in progress" };
		}
		if (this.activeSessionTurns.has(body.sessionId)) {
			return { error: "Session already has an active turn" };
		}

		const existingBridge = this.getSessionBridge(body.sessionId);
		if (existingBridge?.activeTurnId) {
			return { error: "Session already has an active turn" };
		}

		this.activeTurns.set(body.turnId, body.sessionId);
		this.activeSessionTurns.set(body.sessionId, body.turnId);
		if (existingBridge) {
			existingBridge.activeTurnId = body.turnId;
		}

		return null;
	}

	probeAgents(body: AgentProbeRequestBody): Promise<AgentProbeResponse> {
		return probeAgents(body, {
			verifiedProbeByAgent: this.verifiedProbeByAgent,
			inFlightProbeByAgent: this.inFlightProbeByAgent,
		});
	}

	async executeTurn({
		turnId,
		sessionId,
		agent,
		modelId,
		prompt,
		cwd,
		callbackUrl,
		callbackToken,
	}: PromptRequestBody): Promise<void> {
		log("info", "executeTurn started", {
			turnId,
			sessionId,
			agent,
			modelId,
			cwd,
			callbackUrl,
		});
		if (!this.ensureTurnReservation(turnId, sessionId)) {
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
			sessionBridge = await this.getOrInitSessionBridgeForTurn({
				turnId,
				sessionId,
				agent,
				cwd,
				modelId,
				queueEnvelopeEvent: callbacks.queueEnvelopeEvent,
			});

			await stdioRequest(sessionBridge.bridge, AGENT_METHODS.session_prompt, {
				sessionId: sessionBridge.agentSessionId,
				prompt,
			});

			await callbacks.finalizeSuccess();
		} catch (error) {
			if (isAuthRequiredError(error)) {
				this.clearCachedVerifiedProbe(agent);
			}
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
			this.releaseTurnReservation(turnId, sessionId);
		}
	}

	cancelTurn(turnId: string): boolean {
		const sessionId = this.activeTurns.get(turnId);
		if (sessionId === undefined) {
			return false;
		}

		const sessionBridge = this.getSessionBridge(sessionId);
		if (sessionBridge) {
			const cancelEnvelope = sessionCancelEnvelopeSchema.parse({
				jsonrpc: "2.0",
				method: AGENT_METHODS.session_cancel,
				params: { sessionId: sessionBridge.agentSessionId },
			});
			stdioWrite(sessionBridge.bridge, cancelEnvelope);
			log("info", "Sent session/cancel to agent", { turnId, sessionId });
		}

		return true;
	}

	// -- Turn reservation ----------------------------------------------------

	private releaseTurnReservation(turnId: string, sessionId: string): void {
		if (this.activeTurns.get(turnId) === sessionId) {
			this.activeTurns.delete(turnId);
		}
		if (this.activeSessionTurns.get(sessionId) === turnId) {
			this.activeSessionTurns.delete(sessionId);
		}
	}

	private hasTurnReservation(turnId: string, sessionId: string): boolean {
		return (
			this.activeTurns.get(turnId) === sessionId &&
			this.activeSessionTurns.get(sessionId) === turnId
		);
	}

	private ensureTurnReservation(turnId: string, sessionId: string): boolean {
		if (this.hasTurnReservation(turnId, sessionId)) {
			return true;
		}
		log("warn", "Skipping executeTurn without matching reservation", {
			turnId,
			sessionId,
		});
		this.releaseTurnReservation(turnId, sessionId);
		return false;
	}

	// -- Session bridge management -------------------------------------------

	private getSessionBridge(sessionId: string): SessionBridge | null {
		const existing = this.sessionBridges.get(sessionId);
		if (!existing || existing.bridge.dead) {
			if (existing) {
				log("info", "Session bridge dead, discarding", {
					sessionId,
					exitCode: existing.bridge.proc.exitCode,
				});
				this.previousAgentSessionIds.set(sessionId, existing.agentSessionId);
				this.sessionBridges.delete(sessionId);
			}
			return null;
		}
		return existing;
	}

	private clearCachedVerifiedProbe(agent: string): void {
		this.verifiedProbeByAgent.delete(agent);
	}

	private async bootstrapSessionBridge(
		bridge: StdioBridge,
		sessionId: string,
		agent: string,
		cwd: string,
		modelId: string | undefined
	): Promise<string> {
		await new Promise((r) => setTimeout(r, 250));
		if (bridge.proc.exitCode !== null) {
			throw new Error(
				`Agent ${agent} exited immediately with code ${bridge.proc.exitCode}`
			);
		}

		const initResult = await stdioRequest<"initialize">(bridge, "initialize", {
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientInfo: { name: "sandbox-runtime", version: "v1" },
		});
		log("info", "ACP initialize result ", {
			sessionId,
			agent,
			initResult: JSON.stringify(initResult),
		});

		const supportsLoad = initResult.agentCapabilities?.loadSession === true;
		const previousAgentSessionId = this.previousAgentSessionIds.get(sessionId);

		let agentSessionId: string | null = null;

		if (supportsLoad && previousAgentSessionId) {
			try {
				await stdioRequest<"session/load">(bridge, "session/load", {
					sessionId: previousAgentSessionId,
					cwd,
					mcpServers: [
						{
							name: "desktop",
							command: "bun",
							args: ["/usr/local/bin/sandbox-runtime.js", "mcp", "desktop"],
							env: [],
						},
					],
				});
				agentSessionId = previousAgentSessionId;
				log("info", "session/load succeeded", {
					sessionId,
					agentSessionId,
				});
			} catch (error) {
				log("warn", "session/load failed, falling back to session/new", {
					sessionId,
					previousAgentSessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		if (!agentSessionId) {
			const mcpServers = buildDesktopMcpServers();
			log("info", "Sending session/new with mcpServers", {
				sessionId,
				cwd,
				mcpServers,
			});
			const sessionResult = await stdioRequest<"session/new">(
				bridge,
				"session/new",
				{
					cwd,
					mcpServers,
				}
			);
			log("info", "session/new result", {
				sessionId,
				sessionResult: JSON.stringify(sessionResult),
			});
			agentSessionId = sessionResult.sessionId;
			if (!agentSessionId) {
				throw new Error("session/new did not return a sessionId");
			}
		}

		this.previousAgentSessionIds.delete(sessionId);

		try {
			await stdioRequest(bridge, AGENT_METHODS.session_set_mode, {
				sessionId: agentSessionId,
				modeId: "bypassPermissions",
			});
			log("info", "Set bypassPermissions mode", {
				sessionId,
				agentSessionId,
			});
		} catch (error) {
			log("warn", "Failed to set bypassPermissions mode", {
				sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		if (modelId) {
			await setModelOrThrow(bridge, agentSessionId, modelId);
		}

		return agentSessionId;
	}

	private async maybeSetModel(
		sessionBridge: SessionBridge,
		modelId: string | undefined
	): Promise<void> {
		if (sessionBridge.modelId === modelId) {
			return;
		}
		if (modelId) {
			await setModelOrThrow(
				sessionBridge.bridge,
				sessionBridge.agentSessionId,
				modelId
			);
		}
		sessionBridge.modelId = modelId;
	}

	private async initBridge(
		sessionId: string,
		agent: string,
		cwd: string,
		modelId: string | undefined,
		queueEnvelopeEvent: (
			envelope: AcpEnvelope,
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
			sessionBridge.agentSessionId = await this.bootstrapSessionBridge(
				bridge,
				sessionId,
				agent,
				cwd,
				modelId
			);
			if (!this.hasTurnReservation(pendingTurnId, sessionId)) {
				throw new Error(
					`Turn reservation for ${pendingTurnId} was released before bridge bootstrap completed`
				);
			}

			this.sessionBridges.set(sessionId, sessionBridge);
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

	private async getOrInitSessionBridgeForTurn(params: {
		turnId: string;
		sessionId: string;
		agent: string;
		cwd: string;
		modelId: string | undefined;
		queueEnvelopeEvent: (
			envelope: AcpEnvelope,
			direction: "inbound" | "outbound"
		) => void;
	}): Promise<SessionBridge> {
		const { turnId, sessionId, agent, cwd, modelId, queueEnvelopeEvent } =
			params;

		const sessionBridge = this.getSessionBridge(sessionId);
		if (!sessionBridge) {
			return this.initBridge(
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

		await this.maybeSetModel(sessionBridge, modelId);

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
}
