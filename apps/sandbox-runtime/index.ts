import type { RuntimeEvent } from "./runtime-events";
import {
	cloneDynamicConfig,
	cloneStaticConfig,
	defaultSessionTitle,
	getConfigDiff,
	mergeDynamicConfig,
	resolvePermissionOptionId,
	toAbortedError,
	toDefaultModel,
	toErrorMessage,
	toPromptParts,
	toUnknownError,
	toUserPart,
} from "./runtime-helpers";
import type {
	AgentDriver,
	CreateSessionInput,
	EventSink,
	ModelRef,
	RespondToPermissionRequestInput,
	RuntimeEventListener,
	RuntimeMessage,
	RuntimeMessagePart,
	RuntimePermissionRequest,
	RuntimeSession,
	RuntimeTurn,
	SessionAbortInput,
	SessionCreateInput,
	SessionDynamicConfig,
	SessionId,
	SessionPermissionReplyInput,
	SessionPromptInput,
	SessionPromptResult,
	SessionStaticConfig,
	StartTurnInput,
	TurnId,
	TurnStatus,
} from "./runtime-types";

type SessionState = {
	sessionId: SessionId;
	activeTurnId: TurnId | null;
	staticConfig: SessionStaticConfig;
	dynamicConfig: SessionDynamicConfig;
	title: string;
	createdAt: number;
	updatedAt: number;
	model: ModelRef | null;
};

type TurnState = {
	turnId: TurnId;
	sessionId: SessionId;
	status: TurnStatus;
	startedAt: number;
	completedAt?: number;
	stopReason?: RuntimeTurn["stopReason"];
	error?: string;
	userMessage: RuntimeMessage;
	assistantMessage: RuntimeMessage;
	assistantParts: RuntimeMessagePart[];
};

export class RuntimeEngine {
	private readonly sessions = new Map<SessionId, SessionState>();
	private readonly turns = new Map<TurnId, TurnState>();
	private readonly permissions = new Map<string, RuntimePermissionRequest>();
	private readonly listeners = new Set<RuntimeEventListener>();
	private readonly driver: AgentDriver;

	readonly session = {
		create: (input: SessionCreateInput) => this.createSessionResource(input),
		get: (sessionId: SessionId) => this.getSession(sessionId),
		prompt: (input: SessionPromptInput) => this.promptSession(input),
		abort: (input: SessionAbortInput) => this.abortSession(input),
	};

	readonly permission = {
		reply: (input: SessionPermissionReplyInput) =>
			this.replyToPermission(input),
	};

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

	private findTurnByAssistantMessageId(
		messageId: string
	): TurnState | undefined {
		for (const turn of this.turns.values()) {
			if (turn.assistantMessage.id === messageId) {
				return turn;
			}
		}
		return undefined;
	}

	private updateAssistantMessage(message: RuntimeMessage): void {
		const turn = this.findTurnByAssistantMessageId(message.id);
		if (!turn) {
			return;
		}
		turn.assistantMessage = message;
		turn.completedAt = message.completedAt;
		turn.stopReason = message.stopReason;
		turn.error = message.error;
	}

	private upsertAssistantPart(part: RuntimeMessagePart): void {
		const turn = this.findTurnByAssistantMessageId(part.messageId);
		if (!turn) {
			return;
		}
		const existingIndex = turn.assistantParts.findIndex(
			(candidate) => candidate.id === part.id
		);
		if (existingIndex === -1) {
			turn.assistantParts.push(part);
			return;
		}
		turn.assistantParts[existingIndex] = part;
	}

	private syncEventState(event: RuntimeEvent): void {
		switch (event.type) {
			case "message.updated":
				if (event.message.role === "assistant") {
					this.updateAssistantMessage(event.message);
				}
				return;
			case "message.part.updated":
				this.upsertAssistantPart(event.part);
				return;
			case "permission.requested":
				this.permissions.set(event.request.id, event.request);
				return;
			default:
				return;
		}
	}

	private readonly emit = (event: RuntimeEvent): void => {
		this.syncEventState(event);
		for (const listener of this.listeners) {
			listener(event);
		}
	};

	private toRuntimeSession(session: SessionState): RuntimeSession {
		return {
			id: session.sessionId,
			title: session.title,
			directory: session.staticConfig.cwd,
			agent: session.staticConfig.agent,
			model: session.model,
			mode: session.dynamicConfig.modeId ?? null,
			configOptions: { ...(session.dynamicConfig.configOptions ?? {}) },
			activeTurnId: session.activeTurnId,
			status: session.activeTurnId ? "busy" : "idle",
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
		};
	}

	private toRuntimeTurn(turn: TurnState): RuntimeTurn {
		return {
			turnId: turn.turnId,
			sessionId: turn.sessionId,
			status: turn.status,
			userMessageId: turn.userMessage.id,
			assistantMessageId: turn.assistantMessage.id,
			startedAt: turn.startedAt,
			...(turn.completedAt ? { completedAt: turn.completedAt } : {}),
			...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
			...(turn.error ? { error: turn.error } : {}),
		};
	}

	private buildUserMessage(
		session: SessionState,
		input: SessionPromptInput,
		messageId: string
	): RuntimeMessage {
		return {
			id: messageId,
			sessionId: session.sessionId,
			role: "user",
			createdAt: Date.now(),
			agent: input.agent ?? session.staticConfig.agent,
			model: toDefaultModel(
				session.staticConfig.agent,
				input.model ?? session.model,
				session.dynamicConfig
			),
		};
	}

	private buildAssistantMessage(
		session: SessionState,
		input: SessionPromptInput,
		parentId: string
	): RuntimeMessage {
		return {
			id: crypto.randomUUID(),
			sessionId: session.sessionId,
			role: "assistant",
			createdAt: Date.now(),
			parentId,
			agent: input.agent ?? session.staticConfig.agent,
			model: toDefaultModel(
				session.staticConfig.agent,
				input.model ?? session.model,
				session.dynamicConfig
			),
		};
	}

	private async createInternalSession(
		input: CreateSessionInput,
		title: string,
		model: ModelRef | null
	): Promise<SessionState> {
		if (this.sessions.has(input.sessionId)) {
			throw new Error(`Session ${input.sessionId} already exists`);
		}

		const createSessionInput: CreateSessionInput = {
			sessionId: input.sessionId,
			staticConfig: cloneStaticConfig(input.staticConfig),
			dynamicConfig: cloneDynamicConfig(input.dynamicConfig),
		};
		await this.driver.createSession?.(createSessionInput);

		const now = Date.now();
		const session: SessionState = {
			sessionId: input.sessionId,
			activeTurnId: null,
			staticConfig: cloneStaticConfig(createSessionInput.staticConfig),
			dynamicConfig: cloneDynamicConfig(createSessionInput.dynamicConfig),
			title,
			createdAt: now,
			updatedAt: now,
			model,
		};
		this.sessions.set(input.sessionId, session);
		return session;
	}

	createSession(input: CreateSessionInput): Promise<RuntimeSession> {
		const title = defaultSessionTitle(input.staticConfig.cwd);
		const model = input.dynamicConfig.modelId
			? {
					providerID: input.staticConfig.agent,
					modelID: input.dynamicConfig.modelId,
				}
			: null;
		return this.createInternalSession(input, title, model).then((session) =>
			this.toRuntimeSession(session)
		);
	}

	private async promptTurn(
		input: StartTurnInput,
		assistantMessage: RuntimeMessage,
		userMessage: RuntimeMessage
	): Promise<TurnId> {
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
			startedAt: Date.now(),
			userMessage,
			assistantMessage,
			assistantParts: [],
		};
		this.turns.set(turnId, turnState);
		session.activeTurnId = turnId;

		try {
			if (configDiff) {
				await this.driver.updateSessionConfig?.(input.sessionId, configDiff);
				session.dynamicConfig = mergeDynamicConfig(
					session.dynamicConfig,
					configDiff
				);
				if (configDiff.modelId) {
					session.model = {
						providerID: session.model?.providerID ?? session.staticConfig.agent,
						modelID: configDiff.modelId,
					};
				}
			}

			const runResult = await this.driver.run(
				{
					sessionId: input.sessionId,
					turnId,
					prompt: input.prompt,
					dynamicConfig: configDiff ?? {},
					assistantMessageId: assistantMessage.id,
				},
				this.emit
			);

			if (turnState.status !== "cancelled") {
				turnState.status = "completed";
				turnState.completedAt = Date.now();
				turnState.stopReason = runResult?.stopReason;
				turnState.assistantMessage = {
					...turnState.assistantMessage,
					completedAt: turnState.completedAt,
					...(runResult?.stopReason ? { stopReason: runResult.stopReason } : {}),
				};
				this.emit({
					type: "message.updated",
					message: turnState.assistantMessage,
				});
				this.emit({
					type: "session.status",
					sessionId: input.sessionId,
					status: "idle",
				});
				this.emit({
					type: "session.idle",
					sessionId: input.sessionId,
				});
			}
		} catch (error) {
			if (turnState.status !== "cancelled") {
				turnState.status = "failed";
				turnState.error = toErrorMessage(error);
				turnState.assistantMessage = {
					...turnState.assistantMessage,
					error: toUnknownError(error),
				};
				this.emit({
					type: "message.updated",
					message: turnState.assistantMessage,
				});
				this.emit({
					type: "session.error",
					sessionId: input.sessionId,
					error: turnState.error,
				});
				this.emit({
					type: "session.status",
					sessionId: input.sessionId,
					status: "idle",
				});
				throw error;
			}
		} finally {
			session.activeTurnId = null;
			session.updatedAt = Date.now();
		}

		return turnId;
	}

	startTurn(input: StartTurnInput): Promise<TurnId> {
		const session = this.sessions.get(input.sessionId);
		if (!session) {
			throw new Error(`Session ${input.sessionId} does not exist`);
		}

		const userMessage = this.buildUserMessage(
			session,
			{
				sessionId: input.sessionId,
				parts: input.prompt,
			},
			crypto.randomUUID()
		);
		const assistantMessage = this.buildAssistantMessage(
			session,
			{
				sessionId: input.sessionId,
				parts: [],
			},
			userMessage.id
		);

		return this.promptTurn(input, assistantMessage, userMessage);
	}

	async cancelTurn(turnId: TurnId): Promise<boolean> {
		const turnState = this.turns.get(turnId);
		if (!turnState || turnState.status !== "running") {
			return false;
		}

		await this.driver.cancel?.(turnId);
		turnState.status = "cancelled";
		turnState.completedAt = Date.now();
		turnState.error = toAbortedError();
		turnState.assistantMessage = {
			...turnState.assistantMessage,
			completedAt: turnState.completedAt,
			error: turnState.error,
		};
		this.emit({
			type: "message.updated",
			message: turnState.assistantMessage,
		});
		this.emit({
			type: "session.status",
			sessionId: turnState.sessionId,
			status: "idle",
		});
		this.emit({
			type: "session.idle",
			sessionId: turnState.sessionId,
		});
		return true;
	}

	async respondToPermissionRequest(
		input: RespondToPermissionRequestInput
	): Promise<boolean> {
		return (await this.driver.respondToPermissionRequest?.(input)) ?? false;
	}

	private async createSessionResource(
		input: SessionCreateInput
	): Promise<RuntimeSession> {
		const model = input.model ?? null;
		const sessionId = input.sessionId ?? crypto.randomUUID();
		const directory = input.directory ?? process.cwd();
		const agent = input.agent ?? "default";
		const title = input.title ?? defaultSessionTitle(directory);
		const created = await this.createInternalSession(
			{
				sessionId,
				staticConfig: {
					agent,
					cwd: directory,
				},
				dynamicConfig: {
					...(model ? { modelId: model.modelID } : {}),
					...(input.mode ? { modeId: input.mode } : {}),
					...(input.configOptions
						? { configOptions: input.configOptions }
						: {}),
				},
			},
			title,
			model
		);

		const session = this.toRuntimeSession(created);
		this.emit({
			type: "session.created",
			session,
		});
		return session;
	}

	private async promptSession(
		input: SessionPromptInput
	): Promise<SessionPromptResult> {
		const session = this.sessions.get(input.sessionId);
		if (!session) {
			throw new Error(`Session ${input.sessionId} does not exist`);
		}
		if (session.activeTurnId) {
			throw new Error(
				`Session ${input.sessionId} already has active turn ${session.activeTurnId}`
			);
		}
		if (input.agent && input.agent !== session.staticConfig.agent) {
			throw new Error(
				`Session ${input.sessionId} is bound to agent ${session.staticConfig.agent}`
			);
		}
		if (input.model) {
			session.model = input.model;
		}

		const userMessage = this.buildUserMessage(
			session,
			input,
			input.messageId ?? crypto.randomUUID()
		);
		const assistantMessage = this.buildAssistantMessage(
			session,
			input,
			userMessage.id
		);

		session.updatedAt = Date.now();
		this.emit({
			type: "session.updated",
			session: this.toRuntimeSession(session),
		});
		this.emit({
			type: "message.updated",
			message: userMessage,
		});
		for (const part of input.parts.map((part) =>
			toUserPart(input.sessionId, userMessage.id, part)
		)) {
			this.emit({
				type: "message.part.updated",
				part,
			});
		}
		this.emit({
			type: "message.updated",
			message: assistantMessage,
		});
		this.emit({
			type: "session.status",
			sessionId: input.sessionId,
			status: "busy",
		});

		await this.promptTurn(
			{
				sessionId: input.sessionId,
				prompt: toPromptParts(input.parts),
				dynamicConfig:
					input.model || input.mode || input.configOptions
						? {
								...(input.model ? { modelId: input.model.modelID } : {}),
								...(input.mode ? { modeId: input.mode } : {}),
								...(input.configOptions
									? { configOptions: input.configOptions }
									: {}),
							}
						: undefined,
			},
			assistantMessage,
			userMessage
		);

		const turn = [...this.turns.values()].find(
			(candidate) =>
				candidate.sessionId === input.sessionId &&
				candidate.assistantMessage.id === assistantMessage.id
		);

		return {
			sessionId: input.sessionId,
			messageId: turn?.assistantMessage.id ?? assistantMessage.id,
			parts: turn?.assistantParts ?? [],
			...(turn?.stopReason ? { stopReason: turn.stopReason } : {}),
			...(turn?.completedAt ? { completedAt: turn.completedAt } : {}),
			...(turn?.error ? { error: turn.error } : {}),
		};
	}

	private abortSession(input: SessionAbortInput): Promise<boolean> {
		const turnId = this.getActiveTurnId(input.sessionId);
		if (!turnId) {
			return Promise.resolve(false);
		}
		return this.cancelTurn(turnId);
	}

	private async replyToPermission(
		input: SessionPermissionReplyInput
	): Promise<boolean> {
		const permission = this.permissions.get(input.requestId);
		if (!permission) {
			return false;
		}

		const outcome =
			input.reply === "reject"
				? { outcome: "cancelled" as const }
				: {
						outcome: "selected" as const,
						optionId: resolvePermissionOptionId(permission, input.reply),
					};

		const handled = await this.respondToPermissionRequest({
			requestId: input.requestId,
			outcome,
		});
		if (!handled) {
			return false;
		}

		this.emit({
			type: "permission.responded",
			requestId: input.requestId,
			sessionId: permission.sessionId,
			reply: input.reply,
		});
		return true;
	}

	getTurn(turnId: TurnId): RuntimeTurn | undefined {
		const turn = this.turns.get(turnId);
		if (!turn) {
			return undefined;
		}
		return this.toRuntimeTurn(turn);
	}

	getSession(sessionId: SessionId): RuntimeSession | undefined {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return undefined;
		}
		return this.toRuntimeSession(session);
	}

	getActiveTurnId(sessionId: SessionId): TurnId | null {
		return this.sessions.get(sessionId)?.activeTurnId ?? null;
	}
}
