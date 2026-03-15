import type {
	AvailableCommand,
	ConfigOption,
	Content,
	PermissionOption,
	PlanEntry,
	SessionEvent,
	ToolCall,
	ToolContent,
	ToolLocation,
	ToolStatus,
} from "@tendril/contracts/session-event";
import type { UIMessage } from "ai";

export type TendrilRuntimeToolInput = {
	toolCallId: string;
	title: string | null;
	toolKind?: string | null;
	locations?: ToolLocation[] | null;
	content?: ToolContent[] | null;
	rawInput?: unknown;
};

export type TendrilRuntimeToolOutput = {
	toolCallId: string;
	title: string | null;
	toolKind?: string | null;
	locations?: ToolLocation[] | null;
	content?: ToolContent[] | null;
	rawOutput?: unknown;
	status?: ToolStatus | null;
};

export type TendrilMessageMetadata = {
	sessionId?: string;
	createdAt?: string;
	updatedAt?: string;
	source?: "stream" | "optimistic";
	sourceEventIds?: string[];
	sourceEventKinds?: SessionEvent["kind"][];
	composer?: {
		agentId: string;
		modelId: string;
		modeId?: string;
		environmentId?: string | null;
	};
};

export type TendrilDataParts = {
	plan: {
		eventId: string;
		createdAt: string;
		entries: PlanEntry[];
	};
	"permission-request": {
		eventId: string;
		createdAt: string;
		requestId: string;
		options: PermissionOption[];
		toolCall: ToolCall;
	};
	usage: {
		eventId: string;
		createdAt: string;
		used: number;
		size: number;
		cost?: {
			amount: number;
			currency: string;
		} | null;
	};
	status: {
		eventId: string;
		createdAt: string;
		status: "running" | "idle" | "error";
		error?: string;
		stopReason?: string;
	};
	"mode-changed": {
		eventId: string;
		createdAt: string;
		modeId: string;
	};
	"config-changed": {
		eventId: string;
		createdAt: string;
		configOptions: ConfigOption[];
	};
	"info-changed": {
		eventId: string;
		createdAt: string;
		title?: string | null;
		updatedAt?: string | null;
	};
	"commands-changed": {
		eventId: string;
		createdAt: string;
		commands: AvailableCommand[];
	};
	content: {
		eventId: string;
		createdAt: string;
		channel: "user" | "assistant" | "thinking";
		content: Exclude<Content, { type: "text" }>;
	};
};

export type TendrilTools = {
	runtime: {
		input: TendrilRuntimeToolInput;
		output: TendrilRuntimeToolOutput;
	};
};

export type TendrilUIMessage = UIMessage<
	TendrilMessageMetadata,
	TendrilDataParts,
	TendrilTools
>;

export function createOptimisticUserTextMessage(input: {
	id: string;
	sessionId: string;
	text: string;
	createdAt?: string;
}): TendrilUIMessage {
	const timestamp = input.createdAt ?? new Date().toISOString();

	return {
		id: input.id,
		role: "user",
		metadata: {
			sessionId: input.sessionId,
			createdAt: timestamp,
			updatedAt: timestamp,
			source: "optimistic",
			sourceEventIds: [],
			sourceEventKinds: [],
		},
		parts: [
			{
				type: "text",
				text: input.text,
			},
		],
	};
}

export function getTendrilMessageText(message: TendrilUIMessage): string {
	let text = "";

	for (const part of message.parts) {
		if (part.type === "text") {
			text += part.text;
		}
	}

	return text;
}
