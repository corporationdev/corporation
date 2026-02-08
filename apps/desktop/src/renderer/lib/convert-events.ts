import type { ThreadMessageLike } from "@assistant-ui/react";
import type {
	ContentPart,
	ItemDeltaData,
	ItemEventData,
	PermissionEventData,
	UniversalEvent,
	UniversalItem,
} from "sandbox-agent";

type ThreadMessageContent = Exclude<ThreadMessageLike["content"], string>;

type ToolCallPart = {
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result?: string;
};

export type ItemState = {
	item: UniversalItem;
	pendingDeltas: string[];
};

type ProcessResult = {
	messages: ThreadMessageLike[];
	isRunning: boolean;
	offset: number;
};

/**
 * Incrementally process universal events into assistant-ui messages.
 *
 * Applies events from `offset` onward to the `itemStates` map, invokes
 * `onPermission` for permission events, then derives messages from the
 * full map. Returns the new offset for the next call.
 */
export function processEvents(
	events: UniversalEvent[],
	itemStates: Map<string, ItemState>,
	offset: number,
	onPermission?: (
		type: "permission.requested" | "permission.resolved",
		data: PermissionEventData
	) => void
): ProcessResult {
	for (let i = offset; i < events.length; i++) {
		const event = events[i];
		switch (event.type) {
			case "item.started": {
				const { item } = event.data as ItemEventData;
				itemStates.set(item.item_id, { item, pendingDeltas: [] });
				break;
			}
			case "item.delta": {
				const { item_id, delta } = event.data as ItemDeltaData;
				const state = itemStates.get(item_id);
				if (state) {
					state.pendingDeltas.push(delta);
				}
				break;
			}
			case "item.completed": {
				const { item } = event.data as ItemEventData;
				const state = itemStates.get(item.item_id);
				if (state) {
					state.item = item;
					state.pendingDeltas = [];
				}
				break;
			}
			case "permission.requested":
			case "permission.resolved": {
				onPermission?.(event.type, event.data as PermissionEventData);
				break;
			}
			default:
				break;
		}
	}

	return { ...deriveMessages(itemStates), offset: events.length };
}

function addToolCallItem(
	item: UniversalItem,
	assistantId: string,
	byCallId: Map<string, ToolCallPart>,
	byMessageId: Map<string, ToolCallPart[]>
) {
	for (const part of item.content) {
		if (part.type !== "tool_call") {
			continue;
		}
		const toolPart: ToolCallPart = {
			type: "tool-call",
			toolCallId: part.call_id,
			toolName: part.name,
			args: parseToolCallArgs(part.arguments),
		};
		byCallId.set(part.call_id, toolPart);

		const existing = byMessageId.get(assistantId);
		if (existing) {
			existing.push(toolPart);
		} else {
			byMessageId.set(assistantId, [toolPart]);
		}
	}
}

function resolveToolResults(
	item: UniversalItem,
	byCallId: Map<string, ToolCallPart>
) {
	for (const part of item.content) {
		if (part.type !== "tool_result") {
			continue;
		}
		const existing = byCallId.get(part.call_id);
		if (existing) {
			existing.result = part.output;
		}
	}
}

/**
 * Collect tool call/result items and group them by their parent assistant message.
 */
function collectToolParts(itemStates: Map<string, ItemState>) {
	const byCallId = new Map<string, ToolCallPart>();
	const byMessageId = new Map<string, ToolCallPart[]>();
	let currentAssistantId: string | null = null;

	for (const { item } of itemStates.values()) {
		if (item.kind === "message" && item.role === "assistant") {
			currentAssistantId = item.item_id;
		} else if (item.kind === "tool_call" && currentAssistantId) {
			addToolCallItem(item, currentAssistantId, byCallId, byMessageId);
		} else if (item.kind === "tool_result") {
			resolveToolResults(item, byCallId);
		}
	}

	return { byMessageId };
}

/**
 * Derive assistant-ui messages from the item states map.
 *
 * Tool call and tool result items (separate in the universal event stream)
 * are merged into the preceding assistant message as `tool-call` content
 * parts, matching assistant-ui's expected format.
 */
function convertItemToMessage(
	state: ItemState,
	toolPartsForMessage: ToolCallPart[] | undefined
): ThreadMessageLike | null {
	const { item, pendingDeltas } = state;
	if (item.kind !== "message") {
		return null;
	}

	const role = item.role === "user" ? "user" : "assistant";
	const content = convertContent(item.content, pendingDeltas);

	if (role === "assistant") {
		if (toolPartsForMessage) {
			for (const tp of toolPartsForMessage) {
				content.push(tp as ThreadMessageContent[number]);
			}
		}
		return {
			id: item.item_id,
			role,
			content,
			status:
				item.status === "completed"
					? { type: "complete", reason: "stop" }
					: { type: "running" },
		};
	}

	return { id: item.item_id, role, content };
}

function deriveMessages(
	itemStates: Map<string, ItemState>
): Omit<ProcessResult, "offset"> {
	const { byMessageId } = collectToolParts(itemStates);
	const messages: ThreadMessageLike[] = [];
	let isRunning = false;

	for (const state of itemStates.values()) {
		if (
			state.item.role === "assistant" &&
			state.item.status === "in_progress"
		) {
			isRunning = true;
		}

		const message = convertItemToMessage(
			state,
			byMessageId.get(state.item.item_id)
		);
		if (message) {
			messages.push(message);
		}
	}

	return { messages, isRunning };
}

function convertContent(
	parts: ContentPart[],
	pendingDeltas: string[]
): ThreadMessageContent[number][] {
	const content: ThreadMessageContent[number][] = [];

	for (const part of parts) {
		const converted = convertPart(part);
		if (converted) {
			content.push(converted);
		}
	}

	if (pendingDeltas.length > 0) {
		const streamingText = pendingDeltas.join("");
		const lastPart = content.at(-1);

		if (lastPart?.type === "text") {
			content[content.length - 1] = {
				type: "text",
				text: (lastPart as { type: "text"; text: string }).text + streamingText,
			};
		} else {
			content.push({ type: "text", text: streamingText });
		}
	}

	return content;
}

function convertPart(part: ContentPart): ThreadMessageContent[number] | null {
	switch (part.type) {
		case "text":
			return { type: "text", text: part.text };
		case "reasoning":
			return { type: "reasoning", text: part.text };
		case "file_ref":
			return {
				type: "text",
				text: `[${part.action}] ${part.path}${part.diff ? `\n\`\`\`diff\n${part.diff}\n\`\`\`` : ""}`,
			};
		case "image":
			return { type: "image", image: part.path };
		case "status":
			return {
				type: "text",
				text: `[${part.label}]${part.detail ? `: ${part.detail}` : ""}`,
			};
		case "json":
			return { type: "text", text: JSON.stringify(part.json, null, 2) };
		default:
			return null;
	}
}

function parseToolCallArgs(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return { raw: value };
	} catch {
		return { raw: value };
	}
}
