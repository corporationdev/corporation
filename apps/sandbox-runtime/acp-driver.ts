import {
	AGENT_METHODS,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type CancelNotification,
	type ForkSessionRequest,
	type ForkSessionResponse,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	type PromptRequest,
	type PromptResponse,
	type RequestPermissionRequest,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionNotification,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModelRequest,
	type SetSessionModelResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type {
	AgentDriver,
	CreateSessionInput,
	EventSink,
	ResolvedStartTurnInput,
	RunTurnResult,
	SessionDynamicConfig,
	SessionId,
	TurnId,
} from "./index";
import {
	normalizeAcpPermissionRequest,
	normalizeAcpSessionUpdate,
} from "./acp-event-normalizer";

const ACP_PROTOCOL_VERSION = 2;

export type AcpRequestMap = {
	[AGENT_METHODS.initialize]: {
		params: InitializeRequest;
		result: InitializeResponse;
	};
	[AGENT_METHODS.authenticate]: {
		params: AuthenticateRequest;
		result: AuthenticateResponse;
	};
	[AGENT_METHODS.session_new]: {
		params: NewSessionRequest;
		result: NewSessionResponse;
	};
	[AGENT_METHODS.session_load]: {
		params: LoadSessionRequest;
		result: LoadSessionResponse;
	};
	[AGENT_METHODS.session_list]: {
		params: ListSessionsRequest;
		result: ListSessionsResponse;
	};
	[AGENT_METHODS.session_fork]: {
		params: ForkSessionRequest;
		result: ForkSessionResponse;
	};
	[AGENT_METHODS.session_resume]: {
		params: ResumeSessionRequest;
		result: ResumeSessionResponse;
	};
	[AGENT_METHODS.session_set_mode]: {
		params: SetSessionModeRequest;
		result: SetSessionModeResponse;
	};
	[AGENT_METHODS.session_set_config_option]: {
		params: SetSessionConfigOptionRequest;
		result: SetSessionConfigOptionResponse;
	};
	[AGENT_METHODS.session_set_model]: {
		params: SetSessionModelRequest;
		result: SetSessionModelResponse;
	};
	[AGENT_METHODS.session_prompt]: {
		params: PromptRequest;
		result: PromptResponse;
	};
};

export type AcpRequestMethod = keyof AcpRequestMap;

export type AcpInboundEvent =
	| {
			type: "session_update";
			notification: SessionNotification;
	  }
	| {
			type: "permission_request";
			requestId: string;
			request: RequestPermissionRequest;
	  };

export type AcpConnection = {
	request<M extends AcpRequestMethod>(
		method: M,
		params: AcpRequestMap[M]["params"]
	): Promise<AcpRequestMap[M]["result"]>;
	notify(
		method: typeof AGENT_METHODS.session_cancel,
		params: CancelNotification
	): Promise<void>;
	subscribe(listener: (event: AcpInboundEvent) => void): () => void;
	close?(): Promise<void>;
};

export type AcpConnectionFactory = {
	connect(agent: string): Promise<AcpConnection>;
};

type AcpSession = {
	acpSessionId: string;
	connection: AcpConnection;
};

async function applyDynamicConfig(
	connection: AcpConnection,
	acpSessionId: string,
	config: SessionDynamicConfig
): Promise<void> {
	if (config.modelId) {
		await connection.request(AGENT_METHODS.session_set_model, {
			sessionId: acpSessionId,
			modelId: config.modelId,
		});
	}
	if (config.modeId) {
		await connection.request(AGENT_METHODS.session_set_mode, {
			sessionId: acpSessionId,
			modeId: config.modeId,
		});
	}
	if (config.configOptions) {
		for (const [configId, value] of Object.entries(config.configOptions)) {
			await connection.request(AGENT_METHODS.session_set_config_option, {
				sessionId: acpSessionId,
				configId,
				value,
			});
		}
	}
}

export function createAcpDriver(factory: AcpConnectionFactory): AgentDriver {
	const sessions = new Map<SessionId, AcpSession>();
	const turnToSession = new Map<TurnId, SessionId>();

	return {
		async createSession(input: CreateSessionInput): Promise<void> {
			if (sessions.has(input.sessionId)) {
				throw new Error(`ACP session already exists for ${input.sessionId}`);
			}

			const connection = await factory.connect(input.staticConfig.agent);
			await connection.request("initialize", {
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientInfo: {
					name: "sandbox-runtime",
					version: "v1",
				},
			});
			const created = await connection.request("session/new", {
				cwd: input.staticConfig.cwd,
				mcpServers: [],
			});

			await applyDynamicConfig(
				connection,
				created.sessionId,
				input.dynamicConfig
			);

			sessions.set(input.sessionId, {
				acpSessionId: created.sessionId,
				connection,
			});
		},

		async run(
			input: ResolvedStartTurnInput,
			emit: EventSink
		): Promise<RunTurnResult> {
			const session = sessions.get(input.sessionId);
			if (!session) {
				throw new Error(`ACP session not found for ${input.sessionId}`);
			}

			turnToSession.set(input.turnId, input.sessionId);
			const unsubscribe = session.connection.subscribe((event) => {
				switch (event.type) {
					case "session_update":
						if (event.notification.sessionId !== session.acpSessionId) {
							return;
						}
						emit(
							normalizeAcpSessionUpdate(
								input.sessionId,
								input.turnId,
								event.notification.update
							)
						);
						return;
					case "permission_request":
						if (event.request.sessionId !== session.acpSessionId) {
							return;
						}
						emit(
							normalizeAcpPermissionRequest(
								input.sessionId,
								input.turnId,
								event.requestId,
								event.request
							)
						);
						return;
				}
			});

			try {
				await applyDynamicConfig(
					session.connection,
					session.acpSessionId,
					input.dynamicConfig
				);

				const result = await session.connection.request(
					AGENT_METHODS.session_prompt,
					{
					sessionId: session.acpSessionId,
					prompt: input.prompt,
					}
				);
				return {
					stopReason: result.stopReason,
				};
			} finally {
				unsubscribe();
				turnToSession.delete(input.turnId);
			}
		},

		async cancel(turnId: TurnId): Promise<void> {
			const sessionId = turnToSession.get(turnId);
			if (!sessionId) {
				return;
			}
			const session = sessions.get(sessionId);
			if (!session) {
				return;
			}
			await session.connection.notify(AGENT_METHODS.session_cancel, {
				sessionId: session.acpSessionId,
			});
		},
	};
}
