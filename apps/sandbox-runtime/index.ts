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

export type RuntimeEvent =
	| { type: "turn.started"; sessionId: SessionId; turnId: TurnId }
	| {
			type: "turn.progress";
			sessionId: SessionId;
			turnId: TurnId;
			message: string;
	  }
	| { type: "turn.completed"; sessionId: SessionId; turnId: TurnId }
	| {
			type: "turn.failed";
			sessionId: SessionId;
			turnId: TurnId;
			error: string;
	  }
	| { type: "turn.cancelled"; sessionId: SessionId; turnId: TurnId };

export type EventSink = (event: RuntimeEvent) => void;

export type AgentDriver = {
	createSession?(input: CreateSessionInput): Promise<void>;
	run(input: ResolvedStartTurnInput, emit: EventSink): Promise<void>;
	cancel?(turnId: TurnId): Promise<void>;
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

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class RuntimeEngine {
	private readonly sessions = new Map<SessionId, SessionState>();
	private readonly turns = new Map<TurnId, TurnState>();
	private readonly driver: AgentDriver;
	private readonly emit: EventSink;

	constructor(driver: AgentDriver, emit: EventSink) {
		this.driver = driver;
		this.emit = emit;
	}

	async createSession(input: CreateSessionInput): Promise<RuntimeSession> {
		if (this.sessions.has(input.sessionId)) {
			throw new Error(`Session ${input.sessionId} already exists`);
		}

		await this.driver.createSession?.(input);

		const session: SessionState = {
			sessionId: input.sessionId,
			activeTurnId: null,
			staticConfig: input.staticConfig,
			dynamicConfig: input.dynamicConfig,
		};
		this.sessions.set(input.sessionId, session);
		return session;
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
		if (configDiff) {
			session.dynamicConfig = {
				...session.dynamicConfig,
				...input.dynamicConfig,
			};
		}

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
			await this.driver.run(
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
			staticConfig: session.staticConfig,
			dynamicConfig: session.dynamicConfig,
		};
	}

	getActiveTurnId(sessionId: SessionId): TurnId | null {
		return this.sessions.get(sessionId)?.activeTurnId ?? null;
	}
}

export const noopDriver: AgentDriver = {
	async run(input, emit) {
		emit({
			type: "turn.progress",
			sessionId: input.sessionId,
			turnId: input.turnId,
			message: "noop driver ran",
		});
		await Promise.resolve();
	},
};
