import type { ThreadMessageLike } from "@assistant-ui/react";
import type {
	ContentPart,
	ItemDeltaData,
	ItemEventData,
	UniversalEvent,
	UniversalItem,
} from "sandbox-agent";

type ThreadMessageContent = Exclude<ThreadMessageLike["content"], string>;

type ConvertedState = {
	messages: ThreadMessageLike[];
	isRunning: boolean;
};

type ItemState = {
	item: UniversalItem;
	pendingDeltas: string[];
};

/**
 * Convert universal events to assistant-ui messages.
 * Following sandbox-agent's recommended pattern:
 * - Build item map from events
 * - Derive running state from item status
 * - Combine content with pending deltas for streaming
 */
export function convertEventsToMessages(
	events: UniversalEvent[]
): ConvertedState {
	const itemStates = new Map<string, ItemState>();

	for (const event of events) {
		applyEventToItemStates(itemStates, event);
	}

	const messages: ThreadMessageLike[] = [];
	let isRunning = false;

	for (const state of itemStates.values()) {
		if (
			state.item.role === "assistant" &&
			state.item.status === "in_progress"
		) {
			isRunning = true;
		}

		const message = convertItemStateToMessage(state);
		if (message) {
			messages.push(message);
		}
	}

	return { messages, isRunning };
}

function applyEventToItemStates(
	itemStates: Map<string, ItemState>,
	event: UniversalEvent
): void {
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
		default:
			break;
	}
}

function convertItemStateToMessage(state: ItemState): ThreadMessageLike | null {
	const { item, pendingDeltas } = state;
	if (item.kind !== "message") {
		return null;
	}

	const role = item.role === "user" ? "user" : "assistant";
	const content = convertContent(item.content, pendingDeltas);

	if (role === "assistant") {
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
		case "tool_call":
			return {
				type: "tool-call",
				toolCallId: part.call_id,
				toolName: part.name,
				args: parseToolCallArgs(part.arguments) as never,
			};
		case "tool_result":
			return {
				type: "tool-call",
				toolCallId: part.call_id,
				toolName: "tool",
				result: part.output,
			};
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
