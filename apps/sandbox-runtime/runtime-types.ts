import type {
	PermissionOptionKind,
	PlanEntryPriority,
	PlanEntryStatus,
	RequestPermissionOutcome,
	SessionConfigGroupId,
	SessionConfigId,
	SessionConfigOptionCategory,
	SessionConfigValueId,
	StopReason,
	ToolKind,
} from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "./runtime-events";

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

export type ModelRef = {
	providerID: string;
	modelID: string;
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

export type SessionCreateInput = {
	sessionId?: SessionId;
	title?: string;
	directory?: string;
	agent?: string;
	model?: ModelRef;
	mode?: string;
	configOptions?: Record<string, string>;
};

export type StartTurnInput = {
	sessionId: SessionId;
	prompt: PromptPart[];
	dynamicConfig?: SessionDynamicConfig;
};

export type SessionPromptInput = {
	sessionId: SessionId;
	messageId?: string;
	parts: PromptPart[];
	agent?: string;
	model?: ModelRef;
	mode?: string;
	configOptions?: Record<string, string>;
};

export type RuntimeContent =
	| {
			type: "text";
			text: string;
	  }
	| {
			type: "image";
			mimeType: string;
			uri: string;
	  }
	| {
			type: "audio";
			mimeType: string;
			data: string;
	  }
	| {
			type: "resource_link";
			uri: string;
			name: string;
			title?: string;
			description?: string;
			mimeType?: string;
			size?: number;
	  }
	| {
			type: "resource";
			uri: string;
			mimeType?: string;
			text?: string;
			blob?: string;
	  };

export type RuntimeToolLocation = {
	path: string;
	line?: number | null;
};

export type RuntimeToolContent =
	| {
			type: "content";
			content: RuntimeContent;
	  }
	| {
			type: "diff";
			path: string;
			newText: string;
			oldText?: string | null;
	  }
	| {
			type: "terminal";
			terminalId: string;
	  };

export type RuntimeToolState =
	| {
			status: "pending";
			input: Record<string, unknown>;
			raw: string;
	  }
	| {
			status: "running";
			input: Record<string, unknown>;
			title?: string;
			startedAt: number;
			metadata?: {
				kind?: ToolKind | null;
				locations?: RuntimeToolLocation[];
				content?: RuntimeToolContent[];
			};
	  }
	| {
			status: "completed";
			input: Record<string, unknown>;
			title: string;
			output: string;
			startedAt: number;
			endedAt: number;
			metadata?: {
				kind?: ToolKind | null;
				locations?: RuntimeToolLocation[];
				content?: RuntimeToolContent[];
			};
	  }
	| {
			status: "error";
			input: Record<string, unknown>;
			error: string;
			startedAt: number;
			endedAt: number;
			metadata?: {
				kind?: ToolKind | null;
				locations?: RuntimeToolLocation[];
				content?: RuntimeToolContent[];
			};
	  };

export type RuntimeMessagePart =
	| {
			id: string;
			sessionId: SessionId;
			messageId: string;
			type: "text";
			text: string;
	  }
	| {
			id: string;
			sessionId: SessionId;
			messageId: string;
			type: "reasoning";
			text: string;
			startedAt?: number;
	  }
	| {
			id: string;
			sessionId: SessionId;
			messageId: string;
			type: "file";
			mimeType: string;
			uri: string;
			filename?: string;
	  }
	| {
			id: string;
			sessionId: SessionId;
			messageId: string;
			type: "tool";
			toolCallId: string;
			tool: string;
			state: RuntimeToolState;
			metadata?: {
				kind?: ToolKind | null;
				locations?: RuntimeToolLocation[];
				content?: RuntimeToolContent[];
				rawInput?: unknown;
				rawOutput?: unknown;
			};
	  };

export type RuntimeToolPart = Extract<RuntimeMessagePart, { type: "tool" }>;

export type RuntimeMessage = {
	id: string;
	sessionId: SessionId;
	role: "user" | "assistant";
	createdAt: number;
	parentId?: string;
	agent?: string;
	model?: ModelRef | null;
	completedAt?: number;
	stopReason?: StopReason;
	error?: string;
};

export type RuntimeTodo = {
	content: string;
	priority: PlanEntryPriority;
	status: PlanEntryStatus;
};

export type RuntimeUsage = {
	used: number;
	size: number;
	cost?: {
		amount: number;
		currency: string;
	} | null;
};

export type RuntimeAvailableCommand = {
	name: string;
	description: string;
	inputHint?: string | null;
};

export type RuntimeSessionConfigOptionValue = {
	name: string;
	value: SessionConfigValueId;
	description?: string | null;
};

export type RuntimeSessionConfigOptionGroup = {
	group: SessionConfigGroupId;
	name: string;
	options: RuntimeSessionConfigOptionValue[];
};

export type RuntimeSessionConfigOption = {
	type: "select";
	id: SessionConfigId;
	name: string;
	currentValue: SessionConfigValueId;
	options: Array<
		RuntimeSessionConfigOptionValue | RuntimeSessionConfigOptionGroup
	>;
	description?: string | null;
	category?: SessionConfigOptionCategory | null;
};

export type RuntimePermissionOption = {
	optionId: string;
	kind: PermissionOptionKind;
	name: string;
};

export type RuntimePermissionRequest = {
	id: string;
	sessionId: SessionId;
	permission: string;
	options: RuntimePermissionOption[];
	always: string[];
	messageId?: string;
	toolCallId?: string;
};

export type SessionPromptResult = {
	sessionId: SessionId;
	messageId: string;
	parts: RuntimeMessagePart[];
	stopReason?: StopReason;
	completedAt?: number;
	error?: string;
};

export type SessionAbortInput = {
	sessionId: SessionId;
};

export type ResolvedStartTurnInput = {
	sessionId: SessionId;
	turnId: TurnId;
	prompt: PromptPart[];
	dynamicConfig: SessionDynamicConfig;
	assistantMessageId: string;
};

export type EventSink = (event: RuntimeEvent) => void;

export type RespondToPermissionRequestInput = {
	requestId: string;
	outcome: RequestPermissionOutcome;
};

export type SessionPermissionReplyInput = {
	requestId: string;
	reply: "once" | "always" | "reject";
	message?: string;
};

export type RunTurnResult = {
	stopReason?: StopReason;
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

export type RuntimeSession = Readonly<{
	id: SessionId;
	title: string;
	directory: string;
	agent: string;
	model: ModelRef | null;
	mode: string | null;
	configOptions: Readonly<Record<string, string>>;
	activeTurnId: TurnId | null;
	status: "idle" | "busy";
	createdAt: number;
	updatedAt: number;
}>;

export type RuntimeTurn = Readonly<{
	turnId: TurnId;
	sessionId: SessionId;
	status: TurnStatus;
	userMessageId: string;
	assistantMessageId: string;
	startedAt: number;
	completedAt?: number;
	stopReason?: StopReason;
	error?: string;
}>;

export type RuntimeEventListener = (event: RuntimeEvent) => void;
