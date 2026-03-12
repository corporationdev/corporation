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

export type SessionConfig = {
	agent?: string;
	modelId?: string;
	modeId?: string;
	cwd?: string;
	configOptions?: Record<string, string>;
};

export type StartTurnInput = {
	sessionId: SessionId;
	turnId: TurnId;
	prompt: PromptPart[];
	configOverride?: SessionConfig;
};

export type EnsureSessionInput = {
	sessionId: SessionId;
	config: ResolvedSessionConfig;
};

export type SessionIdentity = {
	agent: string;
	cwd: string;
};

export type DynamicSessionConfig = {
	modelId?: string;
	modeId?: string;
	configOptions?: Record<string, string>;
};

export type ResolvedSessionConfig = SessionIdentity & DynamicSessionConfig;

export type ResolvedStartTurnInput = {
	sessionId: SessionId;
	turnId: TurnId;
	prompt: PromptPart[];
	dynamicConfig: DynamicSessionConfig;
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
	run(input: ResolvedStartTurnInput, emit: EventSink): Promise<void>;
	cancel?(turnId: TurnId): Promise<void>;
};

type SessionState = {
	sessionId: SessionId;
	activeTurnId: TurnId | null;
	config: SessionConfig | null;
};

type TurnState = {
	turnId: TurnId;
	sessionId: SessionId;
	status: TurnStatus;
};

export type RuntimeSession = Readonly<SessionState>;
export type RuntimeTurn = Readonly<TurnState>;

function mergeSessionConfig(
	current: SessionConfig | null,
	next: SessionConfig | undefined
): SessionConfig | null {
	if (!next) {
		return current;
	}

	return {
		...(current ?? {}),
		...next,
	};
}

function resolveSessionConfig(
	config: SessionConfig | null
): ResolvedSessionConfig | null {
	if (!(config?.agent && config.cwd)) {
		return null;
	}

	return {
		agent: config.agent,
		cwd: config.cwd,
		...(config.modelId ? { modelId: config.modelId } : {}),
		...(config.modeId ? { modeId: config.modeId } : {}),
		...(config.configOptions ? { configOptions: config.configOptions } : {}),
	};
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

	private createSession(input: EnsureSessionInput): SessionState {
		const session: SessionState = {
			sessionId: input.sessionId,
			activeTurnId: null,
			config: { ...input.config },
		};
		this.sessions.set(input.sessionId, session);
		return session;
	}

	ensureSession(input: EnsureSessionInput): RuntimeSession {
		const existing = this.sessions.get(input.sessionId);
		if (!existing) {
			return this.getSession(
				this.createSession(input).sessionId
			) as RuntimeSession;
		}

		existing.config = {
			...input.config,
		};
		return this.getSession(input.sessionId) as RuntimeSession;
	}

	async startTurn(input: StartTurnInput): Promise<void> {
		const session = this.sessions.get(input.sessionId);
		if (!session) {
			throw new Error(`Session ${input.sessionId} does not exist`);
		}
		if (session.activeTurnId) {
			throw new Error(
				`Session ${input.sessionId} already has active turn ${session.activeTurnId}`
			);
		}

		const nextConfig = mergeSessionConfig(session.config, input.configOverride);
		const resolvedConfig = resolveSessionConfig(nextConfig);
		if (!resolvedConfig) {
			throw new Error(
				`Session ${input.sessionId} has invalid config: agent and cwd are required`
			);
		}

		const turnState: TurnState = {
			turnId: input.turnId,
			sessionId: input.sessionId,
			status: "running",
		};
		session.config = nextConfig;
		this.turns.set(input.turnId, turnState);
		session.activeTurnId = input.turnId;
		this.emit({
			type: "turn.started",
			sessionId: input.sessionId,
			turnId: input.turnId,
		});

		try {
			await this.driver.run(
				{
					sessionId: input.sessionId,
					turnId: input.turnId,
					prompt: input.prompt,
					dynamicConfig: {
						modelId: resolvedConfig.modelId,
						modeId: resolvedConfig.modeId,
						configOptions: resolvedConfig.configOptions,
					},
				},
				this.emit
			);
			if (turnState.status === "cancelled") {
				return;
			}
			turnState.status = "completed";
			this.emit({
				type: "turn.completed",
				sessionId: input.sessionId,
				turnId: input.turnId,
			});
		} catch (error) {
			if (turnState.status === "cancelled") {
				return;
			}
			turnState.status = "failed";
			this.emit({
				type: "turn.failed",
				sessionId: input.sessionId,
				turnId: input.turnId,
				error: toErrorMessage(error),
			});
			throw error;
		} finally {
			if (session.activeTurnId === input.turnId) {
				session.activeTurnId = null;
			}
		}
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
			...session,
			config: session.config ? { ...session.config } : null,
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
