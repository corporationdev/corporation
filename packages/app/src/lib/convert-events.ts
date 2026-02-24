import type { ThreadMessageLike } from "@assistant-ui/react";
import type { SessionEvent } from "sandbox-agent";

type MessageContent = Exclude<ThreadMessageLike["content"], string>;
type MessagePart = MessageContent[number];

type ToolCallPart = {
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result?: string;
};

type TurnState = {
	id: string;
	createdAtEventIndex: number;
	fallbackUserParts: MessagePart[];
	userParts: MessagePart[];
	assistantParts: MessagePart[];
	toolParts: Map<string, ToolCallPart>;
	completed: boolean;
	stopReason?: string;
};

export type EventState = {
	turns: TurnState[];
	turnById: Map<string, TurnState>;
	syntheticCount: number;
};

type ProcessResult = {
	messages: ThreadMessageLike[];
	isRunning: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function createEventState(): EventState {
	return {
		turns: [],
		turnById: new Map<string, TurnState>(),
		syntheticCount: 0,
	};
}

export function processEvent(
	event: SessionEvent,
	state: EventState
): ProcessResult {
	const payload = event.payload as unknown;

	if (isRequestMessage(payload, "session/prompt")) {
		handlePromptRequest(event, payload, state);
	} else if (isRequestMessage(payload, "session/update")) {
		handleSessionUpdate(event, payload, state);
	} else if (isResponseMessage(payload)) {
		handleResponse(payload, state);
	}

	return deriveMessages(state);
}

function handlePromptRequest(
	event: SessionEvent,
	payload: Record<string, unknown>,
	state: EventState
): void {
	const requestId = getRequestId(payload);
	if (!requestId || state.turnById.has(requestId)) {
		return;
	}

	const params = getParams(payload);
	const fallbackUserParts =
		params && isRecord(params) ? convertPromptToParts(params.prompt) : [];

	const turn: TurnState = {
		id: requestId,
		createdAtEventIndex: event.eventIndex,
		fallbackUserParts,
		userParts: [],
		assistantParts: [],
		toolParts: new Map<string, ToolCallPart>(),
		completed: false,
	};

	state.turnById.set(requestId, turn);
	state.turns.push(turn);
}

function handleSessionUpdate(
	event: SessionEvent,
	payload: Record<string, unknown>,
	state: EventState
): void {
	const params = getParams(payload);
	if (!(isRecord(params) && isRecord(params.update))) {
		return;
	}

	const update = params.update;
	if (typeof update.sessionUpdate !== "string") {
		return;
	}

	const turn = getLatestActiveTurn(state) ?? createSyntheticTurn(event, state);

	switch (update.sessionUpdate) {
		case "user_message_chunk": {
			const converted = convertContentBlockToMessagePart(update.content);
			if (converted) {
				pushPart(turn.userParts, converted);
			}
			break;
		}
		case "agent_message_chunk": {
			const converted = convertContentBlockToMessagePart(update.content);
			if (converted) {
				pushPart(turn.assistantParts, converted);
			}
			break;
		}
		case "agent_thought_chunk": {
			const reasoning = convertThoughtChunk(update.content);
			if (reasoning) {
				turn.assistantParts.push(reasoning);
			}
			break;
		}
		case "tool_call": {
			upsertToolCall(turn, update);
			break;
		}
		case "tool_call_update": {
			upsertToolCall(turn, update);
			break;
		}
		case "plan": {
			const planText = formatPlanUpdate(update.entries);
			if (planText) {
				pushPart(turn.assistantParts, {
					type: "text",
					text: planText,
				});
			}
			break;
		}
		default:
			break;
	}
}

function handleResponse(
	payload: Record<string, unknown>,
	state: EventState
): void {
	const requestId = getResponseId(payload);
	if (!requestId) {
		return;
	}

	const turn = state.turnById.get(requestId);
	if (!turn) {
		return;
	}

	turn.completed = true;
	const result = payload.result;
	if (isRecord(result) && typeof result.stopReason === "string") {
		turn.stopReason = result.stopReason;
	}

	const error = payload.error;
	if (isRecord(error) && typeof error.message === "string") {
		pushPart(turn.assistantParts, {
			type: "text",
			text: `[error] ${error.message}`,
		});
	}
}

function deriveMessages(state: EventState): ProcessResult {
	const messages: ThreadMessageLike[] = [];
	let isRunning = false;

	for (const turn of state.turns) {
		const userContent =
			turn.userParts.length > 0 ? turn.userParts : turn.fallbackUserParts;
		if (userContent.length > 0) {
			messages.push({
				id: `${turn.id}:user`,
				role: "user",
				content: [...userContent],
			});
		}

		const assistantContent: MessagePart[] = [...turn.assistantParts];
		for (const toolPart of turn.toolParts.values()) {
			assistantContent.push(toolPart as MessagePart);
		}

		if (assistantContent.length > 0 || !turn.completed) {
			messages.push({
				id: `${turn.id}:assistant`,
				role: "assistant",
				content: assistantContent,
				status: turn.completed
					? { type: "complete", reason: "stop" }
					: { type: "running" },
			});
		}

		if (!turn.completed) {
			isRunning = true;
		}
	}

	return { messages, isRunning };
}

function createSyntheticTurn(
	event: SessionEvent,
	state: EventState
): TurnState {
	const turnId = `synthetic-${state.syntheticCount}-${event.eventIndex}`;
	state.syntheticCount += 1;
	const turn: TurnState = {
		id: turnId,
		createdAtEventIndex: event.eventIndex,
		fallbackUserParts: [],
		userParts: [],
		assistantParts: [],
		toolParts: new Map<string, ToolCallPart>(),
		completed: false,
	};
	state.turnById.set(turn.id, turn);
	state.turns.push(turn);
	return turn;
}

function getLatestActiveTurn(state: EventState): TurnState | null {
	for (let index = state.turns.length - 1; index >= 0; index -= 1) {
		const turn = state.turns[index];
		if (turn && !turn.completed) {
			return turn;
		}
	}
	return null;
}

function upsertToolCall(
	turn: TurnState,
	update: Record<string, unknown>
): void {
	if (typeof update.toolCallId !== "string") {
		return;
	}

	const existing = turn.toolParts.get(update.toolCallId);
	const nextToolPart: ToolCallPart = existing ?? {
		type: "tool-call",
		toolCallId: update.toolCallId,
		toolName: typeof update.title === "string" ? update.title : "tool",
		args: {},
	};

	if (typeof update.title === "string" && update.title.length > 0) {
		nextToolPart.toolName = update.title;
	}

	if ("rawInput" in update && update.rawInput !== undefined) {
		nextToolPart.args = parseToolCallArgs(update.rawInput);
	}

	const result = extractToolCallResult(update);
	if (result) {
		nextToolPart.result = result;
	}

	turn.toolParts.set(nextToolPart.toolCallId, nextToolPart);
}

function extractToolCallResult(
	update: Record<string, unknown>
): string | undefined {
	if ("rawOutput" in update && update.rawOutput !== undefined) {
		return stringifyValue(update.rawOutput);
	}

	if (!Array.isArray(update.content)) {
		return undefined;
	}

	const chunks = update.content
		.map((item) => convertToolContentToText(item))
		.filter(
			(item): item is string => typeof item === "string" && item.length > 0
		);

	if (chunks.length === 0) {
		return undefined;
	}

	return chunks.join("\n");
}

function convertToolContentToText(value: unknown): string | null {
	if (!isRecord(value) || typeof value.type !== "string") {
		return null;
	}

	switch (value.type) {
		case "content":
			return convertContentBlockToText(
				isRecord(value.content) ? value.content : null
			);
		case "diff":
			return stringifyValue(value);
		case "terminal": {
			if (typeof value.output === "string") {
				return value.output;
			}
			return stringifyValue(value);
		}
		default:
			return null;
	}
}

function parseToolCallArgs(rawInput: unknown): Record<string, unknown> {
	if (isRecord(rawInput)) {
		return rawInput;
	}

	return {
		raw: stringifyValue(rawInput),
	};
}

function convertPromptToParts(prompt: unknown): MessagePart[] {
	if (!Array.isArray(prompt)) {
		return [];
	}

	const parts: MessagePart[] = [];
	for (const block of prompt) {
		const converted = convertContentBlockToMessagePart(block);
		if (converted) {
			pushPart(parts, converted);
		}
	}

	return parts;
}

function convertThoughtChunk(content: unknown): MessagePart | null {
	const text = convertContentBlockToText(content);
	if (!text) {
		return null;
	}

	return {
		type: "reasoning",
		text,
	};
}

function convertContentBlockToMessagePart(
	content: unknown
): MessagePart | null {
	if (!isRecord(content) || typeof content.type !== "string") {
		return null;
	}

	switch (content.type) {
		case "text": {
			if (typeof content.text !== "string") {
				return null;
			}
			return {
				type: "text",
				text: content.text,
			};
		}
		case "image": {
			if (typeof content.data !== "string") {
				return null;
			}
			const mimeType =
				typeof content.mimeType === "string" && content.mimeType.length > 0
					? content.mimeType
					: "image/png";
			return {
				type: "image",
				image: `data:${mimeType};base64,${content.data}`,
			};
		}
		default: {
			const text = convertContentBlockToText(content);
			if (!text) {
				return null;
			}
			return {
				type: "text",
				text,
			};
		}
	}
}

function convertContentBlockToText(content: unknown): string | null {
	if (!isRecord(content) || typeof content.type !== "string") {
		return null;
	}

	switch (content.type) {
		case "text":
			return typeof content.text === "string" ? content.text : null;
		case "resource_link": {
			const name = typeof content.name === "string" ? content.name : "resource";
			const uri = typeof content.uri === "string" ? content.uri : "";
			return uri ? `[resource] ${name}: ${uri}` : `[resource] ${name}`;
		}
		case "resource":
			return `[resource] ${stringifyValue(content.resource ?? content)}`;
		case "audio":
			return "[audio]";
		case "image":
			return "[image]";
		default:
			return stringifyValue(content);
	}
}

function formatPlanUpdate(entries: unknown): string | null {
	if (!Array.isArray(entries) || entries.length === 0) {
		return null;
	}

	const lines = entries
		.map((entry, index) => {
			if (!isRecord(entry)) {
				return `- [pending] Step ${index + 1}`;
			}

			const status =
				typeof entry.status === "string" ? entry.status : "pending";
			const content =
				typeof entry.content === "string" ? entry.content : `Step ${index + 1}`;
			return `- [${status}] ${content}`;
		})
		.join("\n");

	return `Plan:\n${lines}`;
}

function pushPart(parts: MessagePart[], part: MessagePart): void {
	if (part.type === "text") {
		const lastPart = parts.at(-1);
		if (lastPart?.type === "text") {
			parts[parts.length - 1] = {
				type: "text",
				text: `${lastPart.text}${part.text}`,
			};
			return;
		}
	}

	parts.push(part);
}

function stringifyValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (value === null || value === undefined) {
		return "";
	}

	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function isRequestMessage(
	payload: unknown,
	method: string
): payload is Record<string, unknown> {
	return (
		isRecord(payload) &&
		typeof payload.method === "string" &&
		payload.method === method
	);
}

function isResponseMessage(
	payload: unknown
): payload is Record<string, unknown> {
	if (!isRecord(payload)) {
		return false;
	}

	if ("method" in payload) {
		return false;
	}

	return "result" in payload || "error" in payload;
}

function getRequestId(payload: Record<string, unknown>): string | null {
	if (!("id" in payload)) {
		return null;
	}

	const id = payload.id;
	if (id === null || id === undefined) {
		return null;
	}

	return String(id);
}

function getResponseId(payload: Record<string, unknown>): string | null {
	return getRequestId(payload);
}

function getParams(payload: Record<string, unknown>): unknown {
	if (!("params" in payload)) {
		return null;
	}

	return payload.params;
}
