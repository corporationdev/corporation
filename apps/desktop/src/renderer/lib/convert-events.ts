import type { ThreadMessageLike } from "@assistant-ui/react";
import type { SessionEvent } from "sandbox-agent";

type ThreadMessageContent = Exclude<ThreadMessageLike["content"], string>;

type ToolCallPart = {
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result?: string;
};

type ToolCallState = {
	part: ToolCallPart;
	status: string;
};

export type ConversationState = {
	entries: EntryState[];
	toolCalls: Map<string, ToolCallState>;
	currentAssistantId: string | null;
	currentAssistantText: string;
	isRunning: boolean;
};

type EntryState =
	| { kind: "user"; id: string; text: string }
	| { kind: "assistant"; id: string; text: string }
	| { kind: "tool"; id: string; toolCallId: string };

type Payload = {
	method?: string;
	params?: Record<string, unknown>;
	id?: string | number | null;
	result?: unknown;
};

type UpdatePayload = {
	sessionUpdate: string;
	content?: { type?: string; text?: string };
	toolCallId?: string;
	title?: string;
	rawInput?: unknown;
	rawOutput?: unknown;
	status?: string;
};

type DeriveResult = { messages: ThreadMessageLike[]; isRunning: boolean };

const REPLAY_PREFIX = "Previous session history is replayed below";

export function createConversationState(): ConversationState {
	return {
		entries: [],
		toolCalls: new Map(),
		currentAssistantId: null,
		currentAssistantText: "",
		isRunning: false,
	};
}

export type PermissionCallback = (
	requestId: string,
	toolCall: { title: string; rawInput?: unknown }
) => void;

/**
 * Apply a single SessionEvent to the conversation state.
 * Mutates `state` in place and returns the derived messages.
 */
export function processEvent(
	event: SessionEvent,
	state: ConversationState,
	onPermission?: PermissionCallback
): DeriveResult {
	const payload = event.payload as Payload;
	const method = payload.method;

	if (!method) {
		if (payload.result != null) {
			flushAssistant(state);
			state.isRunning = false;
		}
		return deriveMessages(state);
	}

	if (event.sender === "client" && method === "session/prompt") {
		handlePrompt(event, payload, state);
	} else if (event.sender === "agent" && method === "session/update") {
		handleSessionUpdate(event, payload, state);
	} else if (method === "session/requestPermission" && payload.id != null) {
		handlePermissionRequest(payload, onPermission);
	}

	return deriveMessages(state);
}

function handlePrompt(
	event: SessionEvent,
	payload: Payload,
	state: ConversationState
) {
	flushAssistant(state);
	state.isRunning = true;
	const promptArray = payload.params?.prompt as
		| Array<{ type: string; text?: string }>
		| undefined;
	const text = (promptArray ?? [])
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => (part.text ?? "").trim())
		.filter((t) => t.length > 0 && !t.startsWith(REPLAY_PREFIX))
		.join("\n\n")
		.trim();

	if (text) {
		state.entries.push({ kind: "user", id: event.id, text });
	}
}

function handleSessionUpdate(
	event: SessionEvent,
	payload: Payload,
	state: ConversationState
) {
	const update = payload.params?.update as UpdatePayload | undefined;
	if (!update?.sessionUpdate) {
		return;
	}

	switch (update.sessionUpdate) {
		case "agent_message_chunk":
		case "agent_thought_chunk":
			handleMessageChunk(event, update, state);
			break;
		case "tool_call":
			handleToolCall(event, update, state);
			break;
		case "tool_call_update":
			handleToolCallUpdate(update, state);
			break;
		default:
			break;
	}
}

function handleMessageChunk(
	event: SessionEvent,
	update: UpdatePayload,
	state: ConversationState
) {
	const text =
		update.content?.type === "text" ? (update.content.text ?? "") : "";
	if (!text) {
		return;
	}

	if (!state.currentAssistantId) {
		state.currentAssistantId = `assistant-${event.id}`;
		state.currentAssistantText = "";
		state.entries.push({
			kind: "assistant",
			id: state.currentAssistantId,
			text: "",
		});
	}
	state.currentAssistantText += text;
	const entry = state.entries.find((e) => e.id === state.currentAssistantId);
	if (entry && entry.kind === "assistant") {
		entry.text = state.currentAssistantText;
	}
}

function handleToolCall(
	event: SessionEvent,
	update: UpdatePayload,
	state: ConversationState
) {
	flushAssistant(state);
	const toolCallId = update.toolCallId ?? event.id;
	const existing = state.toolCalls.get(toolCallId);
	if (existing) {
		applyToolCallFields(existing, update);
		return;
	}

	const part: ToolCallPart = {
		type: "tool-call",
		toolCallId,
		toolName: update.title ?? "tool",
		args: normalizeArgs(update.rawInput),
		result:
			update.rawOutput != null
				? JSON.stringify(update.rawOutput, null, 2)
				: undefined,
	};
	state.toolCalls.set(toolCallId, {
		part,
		status: update.status ?? "in_progress",
	});
	state.entries.push({ kind: "tool", id: `tool-${toolCallId}`, toolCallId });
}

function handleToolCallUpdate(update: UpdatePayload, state: ConversationState) {
	const toolCallId = update.toolCallId;
	if (!toolCallId) {
		return;
	}
	const existing = state.toolCalls.get(toolCallId);
	if (existing) {
		applyToolCallFields(existing, update);
	}
}

function applyToolCallFields(existing: ToolCallState, update: UpdatePayload) {
	if (update.status) {
		existing.status = update.status;
	}
	if (update.title) {
		existing.part.toolName = update.title;
	}
	if (update.rawInput != null) {
		existing.part.args = normalizeArgs(update.rawInput);
	}
	if (update.rawOutput != null) {
		existing.part.result = JSON.stringify(update.rawOutput, null, 2);
	}
}

function handlePermissionRequest(
	payload: Payload,
	onPermission?: PermissionCallback
) {
	const params = payload.params as
		| { toolCall?: { title?: string; rawInput?: unknown } }
		| undefined;
	onPermission?.(String(payload.id), {
		title: params?.toolCall?.title ?? "Permission requested",
		rawInput: params?.toolCall?.rawInput,
	});
}

function flushAssistant(state: ConversationState) {
	state.currentAssistantId = null;
	state.currentAssistantText = "";
}

function deriveMessages(state: ConversationState): DeriveResult {
	const messages: ThreadMessageLike[] = [];
	let currentAssistantMsg: {
		id: string;
		content: ThreadMessageContent[number][];
	} | null = null;

	for (const entry of state.entries) {
		switch (entry.kind) {
			case "user": {
				if (currentAssistantMsg) {
					messages.push(
						buildAssistantMessage(currentAssistantMsg, state.isRunning)
					);
					currentAssistantMsg = null;
				}
				messages.push({
					id: entry.id,
					role: "user",
					content: [{ type: "text", text: entry.text }],
				});
				break;
			}
			case "assistant": {
				if (currentAssistantMsg) {
					messages.push(buildAssistantMessage(currentAssistantMsg, false));
				}
				currentAssistantMsg = {
					id: entry.id,
					content: entry.text ? [{ type: "text", text: entry.text }] : [],
				};
				break;
			}
			case "tool": {
				const toolState = state.toolCalls.get(entry.toolCallId);
				if (toolState && currentAssistantMsg) {
					currentAssistantMsg.content.push(
						toolState.part as ThreadMessageContent[number]
					);
				}
				break;
			}
			default:
				break;
		}
	}

	if (currentAssistantMsg) {
		messages.push(buildAssistantMessage(currentAssistantMsg, state.isRunning));
	}

	return { messages, isRunning: state.isRunning };
}

function buildAssistantMessage(
	msg: { id: string; content: ThreadMessageContent[number][] },
	isRunning: boolean
): ThreadMessageLike {
	return {
		id: msg.id,
		role: "assistant",
		content: msg.content,
		status: isRunning
			? { type: "running" }
			: { type: "complete", reason: "stop" },
	};
}

function normalizeArgs(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// fall through
		}
		return { raw: value };
	}
	return {};
}
