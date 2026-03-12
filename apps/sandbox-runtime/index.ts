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
	cwd?: string;
};

export type StartTurnInput = {
	sessionId: SessionId;
	turnId: TurnId;
	prompt: PromptPart[];
	config?: SessionConfig;
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
	run(input: StartTurnInput, emit: EventSink): Promise<void>;
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

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class RuntimeEngine {
	private readonly sessions = new Map<SessionId, SessionState>();
	private readonly turns = new Map<TurnId, TurnState>();

	constructor(
		private readonly driver: AgentDriver,
		private readonly emit: EventSink
	) {}

	private getOrCreateSession(sessionId: SessionId): SessionState {
		const existing = this.sessions.get(sessionId);
		if (existing) {
			return existing;
		}

		const session: SessionState = {
			sessionId,
			activeTurnId: null,
			config: null,
		};
		this.sessions.set(sessionId, session);
		return session;
	}

	async startTurn(input: StartTurnInput): Promise<void> {
		const session = this.getOrCreateSession(input.sessionId);
		if (session.activeTurnId) {
			throw new Error(
				`Session ${input.sessionId} already has active turn ${session.activeTurnId}`
			);
		}

		const turnState: TurnState = {
			turnId: input.turnId,
			sessionId: input.sessionId,
			status: "running",
		};
		session.config = mergeSessionConfig(session.config, input.config);
		this.turns.set(input.turnId, turnState);
		session.activeTurnId = input.turnId;
		this.emit({
			type: "turn.started",
			sessionId: input.sessionId,
			turnId: input.turnId,
		});

		try {
			await this.driver.run(input, this.emit);
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
	},
};
