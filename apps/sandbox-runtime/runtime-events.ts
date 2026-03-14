import type {
	PermissionOptionKind,
	PlanEntryPriority,
	PlanEntryStatus,
	SessionConfigGroupId,
	SessionConfigId,
	SessionConfigOptionCategory,
	SessionConfigValueId,
	SessionModeId,
	StopReason,
	ToolCallStatus,
	ToolKind,
} from "@agentclientprotocol/sdk";

export type TurnStopReason = StopReason;

export type RuntimeEventBase = {
	sessionId: string;
	turnId: string;
};

export type RuntimeOutputChannel = "user" | "assistant" | "thought";

export type RuntimeContent =
	| {
			type: "text";
			text: string;
	  }
	| {
			type: "image";
			mimeType: string;
			uri?: string | null;
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
			title?: string | null;
			description?: string | null;
			mimeType?: string | null;
			size?: number | null;
	  }
	| {
			type: "resource";
			uri: string;
			mimeType?: string | null;
			text?: string;
			blob?: string;
	  };

export type RuntimeToolKind = ToolKind;

export type RuntimeToolStatus = ToolCallStatus;

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

export type RuntimeToolCall = {
	toolCallId: string;
	title: string | null;
	status: RuntimeToolStatus | null;
	kind?: RuntimeToolKind | null;
	locations?: RuntimeToolLocation[] | null;
	content?: RuntimeToolContent[] | null;
	rawInput?: unknown;
	rawOutput?: unknown;
};

export type RuntimePlanEntry = {
	content: string;
	priority: PlanEntryPriority;
	status: PlanEntryStatus;
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

export type RuntimeAvailableCommand = {
	name: string;
	description: string;
	inputHint?: string | null;
};

export type RuntimePermissionOption = {
	optionId: string;
	kind: PermissionOptionKind;
	name: string;
};

export type RuntimeEvent =
	| (RuntimeEventBase & { type: "turn.started" })
	| (RuntimeEventBase & {
			type: "turn.completed";
			stopReason?: TurnStopReason;
	  })
	| (RuntimeEventBase & {
			type: "turn.failed";
			error: string;
	  })
	| (RuntimeEventBase & { type: "turn.cancelled" })
	| (RuntimeEventBase & {
			type: "output.delta";
			channel: RuntimeOutputChannel;
			content: RuntimeContent;
	  })
	| (RuntimeEventBase & {
			type: "tool.started";
			toolCall: RuntimeToolCall;
	  })
	| (RuntimeEventBase & {
			type: "tool.updated";
			toolCall: RuntimeToolCall;
	  })
	| (RuntimeEventBase & {
			type: "plan.updated";
			entries: RuntimePlanEntry[];
	  })
	| (RuntimeEventBase & {
			type: "usage.updated";
			used: number;
			size: number;
			cost?: {
				amount: number;
				currency: string;
			} | null;
	  })
	| (RuntimeEventBase & {
			type: "session.mode.updated";
			modeId: SessionModeId;
	  })
	| (RuntimeEventBase & {
			type: "session.config.updated";
			configOptions: RuntimeSessionConfigOption[];
	  })
	| (RuntimeEventBase & {
			type: "session.info.updated";
			title?: string | null;
			updatedAt?: string | null;
	  })
	| (RuntimeEventBase & {
			type: "session.available_commands.updated";
			commands: RuntimeAvailableCommand[];
	  })
	| (RuntimeEventBase & {
			type: "permission.requested";
			requestId: string;
			options: RuntimePermissionOption[];
			toolCall: RuntimeToolCall;
	  });
