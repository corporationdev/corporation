import type { RequestPermissionOutcome } from "@agentclientprotocol/sdk";
import type { RuntimeEvent, TurnStopReason } from "./runtime-events";

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

export type SessionStaticConfig = {
	agent: string;
	cwd: string;
};

export type SessionDynamicConfig = {
	modelId?: string;
	modeId?: string;
	configOptions?: Record<string, string>;
};

export type CreateSessionInput = {
	sessionId: SessionId;
	staticConfig: SessionStaticConfig;
	dynamicConfig: SessionDynamicConfig;
};

export type StartTurnInput = {
	sessionId: SessionId;
	prompt: PromptPart[];
	dynamicConfig?: SessionDynamicConfig;
};

export type ResolvedStartTurnInput = {
	sessionId: SessionId;
	turnId: TurnId;
	prompt: PromptPart[];
	dynamicConfig: SessionDynamicConfig;
};

export type EventSink = (event: RuntimeEvent) => void;

export type RespondToPermissionRequestInput = {
	requestId: string;
	outcome: RequestPermissionOutcome;
};

export type RunTurnResult = {
	stopReason?: TurnStopReason;
};

export type AgentDriver = {
	createSession?(input: CreateSessionInput): Promise<void>;
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
	staticConfig: Readonly<SessionStaticConfig>;
	dynamicConfig: Readonly<SessionDynamicConfig>;
}>;

export type RuntimeTurn = Readonly<TurnState>;

export type { RuntimeEvent, TurnStopReason } from "./runtime-events";
export type {
	RuntimeWebSocketTransport,
	WebSocketLike,
	WebSocketLikeFactory,
} from "./websocket-runtime-transport";
export type RuntimeEventListener = (event: RuntimeEvent) => void;

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

	private readonly emit = (event: RuntimeEvent): void => {
		for (const listener of this.listeners) {
			listener(event);
		}
	};

	async createSession(input: CreateSessionInput): Promise<RuntimeSession> {
		if (this.sessions.has(input.sessionId)) {
			throw new Error(`Session ${input.sessionId} already exists`);
		}

		const createSessionInput: CreateSessionInput = {
			sessionId: input.sessionId,
			staticConfig: cloneStaticConfig(input.staticConfig),
			dynamicConfig: cloneDynamicConfig(input.dynamicConfig),
		};
		await this.driver.createSession?.(createSessionInput);

		const session: SessionState = {
			sessionId: input.sessionId,
			activeTurnId: null,
			staticConfig: cloneStaticConfig(createSessionInput.staticConfig),
			dynamicConfig: cloneDynamicConfig(createSessionInput.dynamicConfig),
		};
		this.sessions.set(input.sessionId, session);
		return this.getSession(input.sessionId) as RuntimeSession;
	}

	async startTurn(input: StartTurnInput): Promise<TurnId> {
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

		const configDiff = getConfigDiff(
			session.dynamicConfig,
			input.dynamicConfig
		);

		const turnState: TurnState = {
			turnId,
			sessionId: input.sessionId,
			status: "running",
		};
		this.turns.set(turnId, turnState);
		session.activeTurnId = turnId;
		this.emit({
			type: "turn.started",
			sessionId: input.sessionId,
			turnId,
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
					type: "turn.completed",
					sessionId: input.sessionId,
					turnId,
					...(runResult?.stopReason
						? { stopReason: runResult.stopReason }
						: {}),
				});
			}
		} catch (error) {
			if (turnState.status !== "cancelled") {
				turnState.status = "failed";
				this.emit({
					type: "turn.failed",
					sessionId: input.sessionId,
					turnId,
					error: toErrorMessage(error),
				});
				throw error;
			}
		} finally {
			session.activeTurnId = null;
		}
		return turnId;
	}

	async cancelTurn(turnId: TurnId): Promise<boolean> {
		const turnState = this.turns.get(turnId);
		if (!turnState || turnState.status !== "running") {
			return false;
		}

		await this.driver.cancel?.(turnId);
		turnState.status = "cancelled";
		this.emit({
			type: "turn.cancelled",
			sessionId: turnState.sessionId,
			turnId,
		});
		return true;
	}

	async respondToPermissionRequest(
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
			staticConfig: cloneStaticConfig(session.staticConfig),
			dynamicConfig: cloneDynamicConfig(session.dynamicConfig),
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
			type: "output.delta",
			sessionId: input.sessionId,
			turnId: input.turnId,
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
