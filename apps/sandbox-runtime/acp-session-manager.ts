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
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModelRequest,
	type SetSessionModelResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type {
	DynamicSessionConfig,
	EventSink,
	ResolvedStartTurnInput,
	SessionId,
	SessionIdentity,
} from "./index";

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

export type AcpConnection = {
	request<M extends AcpRequestMethod>(
		method: M,
		params: AcpRequestMap[M]["params"]
	): Promise<AcpRequestMap[M]["result"]>;
	notify(
		method: typeof AGENT_METHODS.session_cancel,
		params: CancelNotification
	): Promise<void>;
};

export type AcpConnectionFactory = {
	connect(agent: string): Promise<AcpConnection>;
};

export type AcpManagedSession = {
	sessionId: SessionId;
	staticConfig: SessionIdentity;
	dynamicConfig?: DynamicSessionConfig;
};

export class AcpSessionHandle {
	readonly runtimeSessionId: SessionId;
	readonly acpSessionId: string;
	private readonly connection: AcpConnection;
	private appliedDynamic: DynamicSessionConfig;

	constructor(
		runtimeSessionId: SessionId,
		acpSessionId: string,
		connection: AcpConnection,
		initialDynamic: DynamicSessionConfig
	) {
		this.runtimeSessionId = runtimeSessionId;
		this.acpSessionId = acpSessionId;
		this.connection = connection;
		this.appliedDynamic = { ...initialDynamic };
	}

	async runTurn(
		input: ResolvedStartTurnInput,
		_emit: EventSink
	): Promise<void> {
		const next = input.dynamicConfig;

		if (next.modelId && next.modelId !== this.appliedDynamic.modelId) {
			await this.connection.request(AGENT_METHODS.session_set_model, {
				sessionId: this.acpSessionId,
				modelId: next.modelId,
			});
			this.appliedDynamic = {
				...this.appliedDynamic,
				modelId: next.modelId,
			};
		}

		if (next.modeId && next.modeId !== this.appliedDynamic.modeId) {
			await this.connection.request(AGENT_METHODS.session_set_mode, {
				sessionId: this.acpSessionId,
				modeId: next.modeId,
			});
			this.appliedDynamic = {
				...this.appliedDynamic,
				modeId: next.modeId,
			};
		}

		if (next.configOptions) {
			for (const [configId, valueId] of Object.entries(next.configOptions)) {
				const appliedValue = this.appliedDynamic.configOptions?.[configId];
				if (valueId !== appliedValue) {
					await this.connection.request(
						AGENT_METHODS.session_set_config_option,
						{
							sessionId: this.acpSessionId,
							configId,
							value: valueId,
						}
					);
				}
			}
			this.appliedDynamic = {
				...this.appliedDynamic,
				configOptions: {
					...this.appliedDynamic.configOptions,
					...next.configOptions,
				},
			};
		}

		await this.connection.request(AGENT_METHODS.session_prompt, {
			sessionId: this.acpSessionId,
			prompt: input.prompt,
		});
	}

	async cancelActiveTurn(): Promise<void> {
		await this.connection.notify(AGENT_METHODS.session_cancel, {
			sessionId: this.acpSessionId,
		});
	}

	getSnapshot() {
		return {
			runtimeSessionId: this.runtimeSessionId,
			acpSessionId: this.acpSessionId,
			appliedDynamic: { ...this.appliedDynamic },
		};
	}
}

export class AcpSessionManager {
	private readonly handles = new Map<SessionId, AcpSessionHandle>();
	private readonly factory: AcpConnectionFactory;

	constructor(factory: AcpConnectionFactory) {
		this.factory = factory;
	}

	async getOrCreate(input: AcpManagedSession): Promise<AcpSessionHandle> {
		const existing = this.handles.get(input.sessionId);
		if (existing) {
			return existing;
		}

		const connection = await this.factory.connect(input.staticConfig.agent);
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
		const dynamicConfig = input.dynamicConfig ?? {};

		if (dynamicConfig.modelId) {
			await connection.request(AGENT_METHODS.session_set_model, {
				sessionId: created.sessionId,
				modelId: dynamicConfig.modelId,
			});
		}

		if (dynamicConfig.modeId) {
			await connection.request(AGENT_METHODS.session_set_mode, {
				sessionId: created.sessionId,
				modeId: dynamicConfig.modeId,
			});
		}

		if (dynamicConfig.configOptions) {
			for (const [configId, value] of Object.entries(
				dynamicConfig.configOptions
			)) {
				await connection.request(AGENT_METHODS.session_set_config_option, {
					sessionId: created.sessionId,
					configId,
					value,
				});
			}
		}

		const handle = new AcpSessionHandle(
			input.sessionId,
			created.sessionId,
			connection,
			dynamicConfig
		);
		this.handles.set(input.sessionId, handle);
		return handle;
	}
}
