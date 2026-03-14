import type {
	RequestPermissionOutcome,
	StopReason,
} from "@agentclientprotocol/sdk";
import type { SessionEvent } from "@tendril/contracts/session-event";

export type SessionId = string;
export type TurnId = string;

export type TurnStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type PromptPart = {
	type: "text";
	text: string;
};

// --- Driver SPI types (used by AgentDriver implementations) ---

export type SessionStaticConfig = {
	agent: string;
	cwd: string;
};

export type SessionDynamicConfig = {
	modelId?: string;
	modeId?: string;
	configOptions?: Record<string, string>;
};

export type DriverCreateSessionInput = {
	sessionId: SessionId;
	staticConfig: SessionStaticConfig;
	dynamicConfig: SessionDynamicConfig;
};

export type ResolvedStartTurnInput = {
	sessionId: SessionId;
	turnId: TurnId;
	prompt: PromptPart[];
	dynamicConfig: SessionDynamicConfig;
};

export type EventSink = (event: SessionEvent) => void;

export type RespondToPermissionRequestInput = {
	requestId: string;
	outcome: RequestPermissionOutcome;
};

export type RunTurnResult = {
	stopReason?: StopReason;
};

export type AgentDriver = {
	createSession?(input: DriverCreateSessionInput): Promise<void>;
	updateSessionConfig?(
		sessionId: SessionId,
		dynamicConfig: SessionDynamicConfig
	): Promise<void>;
	run(
		input: ResolvedStartTurnInput,
		emit: EventSink
	): Promise<RunTurnResult | undefined>;
	cancel?(turnId: TurnId): Promise<void>;
	respondToPermissionRequest?(
		input: RespondToPermissionRequestInput
	): Promise<boolean>;
};

// --- Public API types (used by RuntimeEngine consumers) ---

export type CreateSessionInput = {
	sessionId: SessionId;
	agent: string;
	cwd: string;
	model?: string;
	mode?: string;
	configOptions?: Record<string, string>;
};

export type PromptInput = {
	sessionId: SessionId;
	prompt: PromptPart[];
	model?: string;
	mode?: string;
	configOptions?: Record<string, string>;
};

type SessionState = {
	sessionId: SessionId;
	activeTurnId: TurnId | null;
	staticConfig: SessionStaticConfig;
	dynamicConfig: SessionDynamicConfig;
};

type TurnState = {
	turnId: TurnId;
	sessionId: SessionId;
	status: TurnStatus;
};

export type RuntimeSession = Readonly<{
	sessionId: SessionId;
	activeTurnId: TurnId | null;
	agent: string;
	cwd: string;
	model?: string;
	mode?: string;
	configOptions: Readonly<Record<string, string>>;
}>;

export type RuntimeTurn = Readonly<TurnState>;

export type { SessionEvent } from "@tendril/contracts/session-event";
export type {
	RuntimeWebSocketTransport,
	WebSocketLike,
	WebSocketLikeFactory,
} from "./websocket-runtime-transport";
export type RuntimeEventListener = (event: SessionEvent) => void;

function getPromptText(prompt: PromptPart[]): string | null {
	const text = prompt
		.map((part) => part.text)
		.join("")
		.trim();
	return text.length > 0 ? text : null;
}

function getConfigDiff(
	current: SessionDynamicConfig,
	incoming: SessionDynamicConfig | undefined
): SessionDynamicConfig | null {
	if (!incoming) {
		return null;
	}

	const diff: SessionDynamicConfig = {};
	if (incoming.modelId !== undefined && incoming.modelId !== current.modelId) {
		diff.modelId = incoming.modelId;
	}
	if (incoming.modeId !== undefined && incoming.modeId !== current.modeId) {
		diff.modeId = incoming.modeId;
	}
	if (incoming.configOptions) {
		const changedOptions: Record<string, string> = {};
		for (const [key, value] of Object.entries(incoming.configOptions)) {
			if (value !== current.configOptions?.[key]) {
				changedOptions[key] = value;
			}
		}
		if (Object.keys(changedOptions).length > 0) {
			diff.configOptions = changedOptions;
		}
	}

	if (
		diff.modelId === undefined &&
		diff.modeId === undefined &&
		diff.configOptions === undefined
	) {
		return null;
	}

	return diff;
}

function cloneStaticConfig(config: SessionStaticConfig): SessionStaticConfig {
	return { ...config };
}

function cloneDynamicConfig(
	config: SessionDynamicConfig
): SessionDynamicConfig {
	return {
		...config,
		...(config.configOptions
			? { configOptions: { ...config.configOptions } }
			: {}),
	};
}

function mergeDynamicConfig(
	current: SessionDynamicConfig,
	next: SessionDynamicConfig
): SessionDynamicConfig {
	return {
		...current,
		...next,
		...(current.configOptions || next.configOptions
			? {
					configOptions: {
						...(current.configOptions ?? {}),
						...(next.configOptions ?? {}),
					},
				}
			: {}),
	};
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class RuntimeEngine {
	private readonly sessions = new Map<SessionId, SessionState>();
	private readonly turns = new Map<TurnId, TurnState>();
	private readonly listeners = new Set<RuntimeEventListener>();
	private readonly driver: AgentDriver;

	constructor(driver: AgentDriver, emit?: EventSink) {
		this.driver = driver;
		if (emit) {
			this.listeners.add(emit);
		}
	}

	subscribe(listener: RuntimeEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private readonly emit = (event: SessionEvent): void => {
		console.log("[engine] emit:", event.kind);
		for (const listener of this.listeners) {
			listener(event);
		}
	};

	async createSession(input: CreateSessionInput): Promise<RuntimeSession> {
		console.log(
			"[engine] createSession:",
			input.sessionId,
			"cwd:",
			input.cwd,
			"agent:",
			input.agent
		);
		if (this.sessions.has(input.sessionId)) {
			throw new Error(`Session ${input.sessionId} already exists`);
		}

		const staticConfig: SessionStaticConfig = {
			agent: input.agent,
			cwd: input.cwd,
		};
		const dynamicConfig: SessionDynamicConfig = {
			...(input.model !== undefined ? { modelId: input.model } : {}),
			...(input.mode !== undefined ? { modeId: input.mode } : {}),
			...(input.configOptions !== undefined
				? { configOptions: { ...input.configOptions } }
				: {}),
		};

		const driverInput: DriverCreateSessionInput = {
			sessionId: input.sessionId,
			staticConfig: cloneStaticConfig(staticConfig),
			dynamicConfig: cloneDynamicConfig(dynamicConfig),
		};
		await this.driver.createSession?.(driverInput);

		const session: SessionState = {
			sessionId: input.sessionId,
			activeTurnId: null,
			staticConfig: cloneStaticConfig(staticConfig),
			dynamicConfig: cloneDynamicConfig(dynamicConfig),
		};
		this.sessions.set(input.sessionId, session);
		return this.getSession(input.sessionId) as RuntimeSession;
	}

	async prompt(input: PromptInput): Promise<TurnId> {
		const session = this.sessions.get(input.sessionId);
		if (!session) {
			throw new Error(`Session ${input.sessionId} does not exist`);
		}
		if (session.activeTurnId) {
			throw new Error(
				`Session ${input.sessionId} already has active turn ${session.activeTurnId}`
			);
		}

		const turnId: TurnId = crypto.randomUUID();

		const incomingConfig: SessionDynamicConfig = {
			...(input.model !== undefined ? { modelId: input.model } : {}),
			...(input.mode !== undefined ? { modeId: input.mode } : {}),
			...(input.configOptions !== undefined
				? { configOptions: { ...input.configOptions } }
				: {}),
		};
		const configDiff = getConfigDiff(session.dynamicConfig, incomingConfig);

		const turnState: TurnState = {
			turnId,
			sessionId: input.sessionId,
			status: "running",
		};
		this.turns.set(turnId, turnState);
		session.activeTurnId = turnId;
		const promptText = getPromptText(input.prompt);
		if (promptText) {
			this.emit({
				kind: "text_delta",
				sessionId: input.sessionId,
				channel: "user",
				content: {
					type: "text",
					text: promptText,
				},
			});
		}
		this.emit({
			kind: "status",
			sessionId: input.sessionId,
			status: "running",
		});

		try {
			if (configDiff) {
				await this.driver.updateSessionConfig?.(input.sessionId, configDiff);
				session.dynamicConfig = mergeDynamicConfig(
					session.dynamicConfig,
					configDiff
				);
			}

			const runResult = await this.driver.run(
				{
					sessionId: input.sessionId,
					turnId,
					prompt: input.prompt,
					dynamicConfig: configDiff ?? {},
				},
				this.emit
			);
			if (turnState.status !== "cancelled") {
				turnState.status = "completed";
				this.emit({
					kind: "status",
					sessionId: input.sessionId,
					status: "idle",
					...(runResult?.stopReason
						? { stopReason: runResult.stopReason }
						: {}),
				});
			}
		} catch (error) {
			if (turnState.status !== "cancelled") {
				turnState.status = "failed";
				this.emit({
					kind: "status",
					sessionId: input.sessionId,
					status: "error",
					error: toErrorMessage(error),
				});
				throw error;
			}
		} finally {
			session.activeTurnId = null;
		}
		return turnId;
	}

	async abort(sessionId: SessionId): Promise<boolean> {
		const session = this.sessions.get(sessionId);
		if (!session?.activeTurnId) {
			return false;
		}

		const turnId = session.activeTurnId;
		const turnState = this.turns.get(turnId);
		if (!turnState || turnState.status !== "running") {
			return false;
		}

		await this.driver.cancel?.(turnId);
		turnState.status = "cancelled";
		this.emit({
			kind: "status",
			sessionId,
			status: "idle",
		});
		return true;
	}

	async respondToPermission(
		input: RespondToPermissionRequestInput
	): Promise<boolean> {
		return (await this.driver.respondToPermissionRequest?.(input)) ?? false;
	}

	getTurn(turnId: TurnId): RuntimeTurn | undefined {
		const turn = this.turns.get(turnId);
		if (!turn) {
			return undefined;
		}

		return { ...turn };
	}

	getSession(sessionId: SessionId): RuntimeSession | undefined {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return undefined;
		}

		return {
			sessionId: session.sessionId,
			activeTurnId: session.activeTurnId,
			agent: session.staticConfig.agent,
			cwd: session.staticConfig.cwd,
			...(session.dynamicConfig.modelId !== undefined
				? { model: session.dynamicConfig.modelId }
				: {}),
			...(session.dynamicConfig.modeId !== undefined
				? { mode: session.dynamicConfig.modeId }
				: {}),
			configOptions: { ...(session.dynamicConfig.configOptions ?? {}) },
		};
	}

	getActiveTurnId(sessionId: SessionId): TurnId | null {
		return this.sessions.get(sessionId)?.activeTurnId ?? null;
	}
}

export const noopDriver: AgentDriver = {
	async updateSessionConfig() {
		await Promise.resolve();
	},
	async run(input, emit) {
		emit({
			kind: "text_delta",
			sessionId: input.sessionId,
			channel: "assistant",
			content: {
				type: "text",
				text: "noop driver ran",
			},
		});
		await Promise.resolve();
		return {
			stopReason: "end_turn",
		};
	},
};
