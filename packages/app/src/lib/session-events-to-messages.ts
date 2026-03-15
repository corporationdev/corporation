import type { SessionEvent, ToolCall } from "@tendril/contracts/session-event";
import type {
	TendrilMessageMetadata,
	TendrilUIMessage,
} from "@/lib/tendril-ui-message";

export type EnrichedSessionEvent = {
	eventId: string;
	createdAt: number;
	event: SessionEvent;
};

type MutableTendrilMessage = TendrilUIMessage & {
	metadata: TendrilMessageMetadata & {
		sessionId: string;
		createdAt: string;
		updatedAt: string;
		source: "stream" | "optimistic";
		sourceEventIds: string[];
		sourceEventKinds: SessionEvent["kind"][];
	};
};

function createMessage(input: {
	id: string;
	role: TendrilUIMessage["role"];
	sessionId: string;
	createdAt: string;
}): MutableTendrilMessage {
	return {
		id: input.id,
		role: input.role,
		metadata: {
			sessionId: input.sessionId,
			createdAt: input.createdAt,
			updatedAt: input.createdAt,
			source: "stream",
			sourceEventIds: [],
			sourceEventKinds: [],
		},
		parts: input.role === "assistant" ? [{ type: "step-start" }] : [],
	};
}

function attachEventMetadata(
	message: MutableTendrilMessage,
	enriched: EnrichedSessionEvent
): void {
	message.metadata.updatedAt = new Date(enriched.createdAt).toISOString();
	message.metadata.sourceEventIds.push(enriched.eventId);
	message.metadata.sourceEventKinds.push(enriched.event.kind);
}

function ensureMessage(
	messages: MutableTendrilMessage[],
	input: {
		role: "user" | "assistant";
		enriched: EnrichedSessionEvent;
	}
): MutableTendrilMessage {
	const lastMessage = messages.at(-1);
	if (lastMessage?.role === input.role) {
		attachEventMetadata(lastMessage, input.enriched);
		return lastMessage;
	}

	const createdAt = new Date(input.enriched.createdAt).toISOString();
	const message = createMessage({
		id: `${input.role}-${input.enriched.eventId}`,
		role: input.role,
		sessionId: input.enriched.event.sessionId,
		createdAt,
	});
	attachEventMetadata(message, input.enriched);
	messages.push(message);
	return message;
}

function appendTextPart(
	message: MutableTendrilMessage,
	partType: "text" | "reasoning",
	text: string
): void {
	if (!text) {
		return;
	}

	const lastPart = message.parts.at(-1);
	if (lastPart?.type === partType) {
		lastPart.text += text;
		return;
	}

	message.parts.push({
		type: partType,
		text,
	});
}

function findRuntimeToolPartIndex(
	message: MutableTendrilMessage,
	toolCallId: string
) {
	return message.parts.findIndex(
		(part) => part.type === "tool-runtime" && part.toolCallId === toolCallId
	);
}

function toRuntimeToolInput(toolCall: ToolCall) {
	return {
		toolCallId: toolCall.toolCallId,
		title: toolCall.title,
		toolKind: toolCall.toolKind,
		locations: toolCall.locations,
		content: toolCall.content,
		rawInput: toolCall.rawInput,
	};
}

function toRuntimeToolOutput(toolCall: ToolCall) {
	return {
		toolCallId: toolCall.toolCallId,
		title: toolCall.title,
		toolKind: toolCall.toolKind,
		locations: toolCall.locations,
		content: toolCall.content,
		rawOutput: toolCall.rawOutput,
		status: toolCall.status,
	};
}

function toRuntimeToolPart(
	toolCall: ToolCall
): Extract<TendrilUIMessage["parts"][number], { type: "tool-runtime" }> {
	const base = {
		type: "tool-runtime" as const,
		toolCallId: toolCall.toolCallId,
		title: toolCall.title ?? undefined,
		input: toRuntimeToolInput(toolCall),
	};

	if (
		toolCall.status === "completed" ||
		toolCall.status === "failed" ||
		toolCall.rawOutput !== undefined
	) {
		return {
			...base,
			state: "output-available",
			output: toRuntimeToolOutput(toolCall),
		};
	}

	return {
		...base,
		state: "input-available",
	};
}

function appendStructuredContent(
	message: MutableTendrilMessage,
	enriched: EnrichedSessionEvent,
	channel: "user" | "assistant" | "thinking",
	content: SessionEvent extends infer E
		? E extends { kind: "text_delta"; content: infer C }
			? Exclude<C, { type: "text" }>
			: never
		: never
): void {
	message.parts.push({
		type: "data-content",
		id: enriched.eventId,
		data: {
			eventId: enriched.eventId,
			createdAt: new Date(enriched.createdAt).toISOString(),
			channel,
			content,
		},
	});
}

export function sessionEventsToMessages(
	enrichedEvents: EnrichedSessionEvent[]
): TendrilUIMessage[] {
	const messages: MutableTendrilMessage[] = [];

	for (const enriched of enrichedEvents) {
		const { eventId, createdAt, event } = enriched;
		const timestamp = new Date(createdAt).toISOString();

		switch (event.kind) {
			case "text_delta": {
				if (event.channel === "user") {
					const message = ensureMessage(messages, {
						role: "user",
						enriched,
					});

					if (event.content.type === "text") {
						appendTextPart(message, "text", event.content.text);
					} else {
						appendStructuredContent(message, enriched, "user", event.content);
					}
					break;
				}

				const message = ensureMessage(messages, {
					role: "assistant",
					enriched,
				});

				if (event.content.type === "text") {
					appendTextPart(
						message,
						event.channel === "thinking" ? "reasoning" : "text",
						event.content.text
					);
				} else {
					appendStructuredContent(
						message,
						enriched,
						event.channel,
						event.content
					);
				}
				break;
			}
			case "tool_start":
			case "tool_update": {
				const message = ensureMessage(messages, {
					role: "assistant",
					enriched,
				});
				const nextPart = toRuntimeToolPart(event.toolCall);
				const partIndex = findRuntimeToolPartIndex(
					message,
					event.toolCall.toolCallId
				);

				if (partIndex === -1) {
					message.parts.push(nextPart);
				} else {
					message.parts[partIndex] = nextPart;
				}
				break;
			}
			case "plan": {
				const message = ensureMessage(messages, {
					role: "assistant",
					enriched,
				});
				message.parts.push({
					type: "data-plan",
					id: eventId,
					data: {
						eventId,
						createdAt: timestamp,
						entries: event.entries,
					},
				});
				break;
			}
			case "permission_request": {
				const message = ensureMessage(messages, {
					role: "assistant",
					enriched,
				});
				message.parts.push({
					type: "data-permission-request",
					id: eventId,
					data: {
						eventId,
						createdAt: timestamp,
						requestId: event.requestId,
						options: event.options,
						toolCall: event.toolCall,
					},
				});
				break;
			}
			case "usage": {
				const message = ensureMessage(messages, {
					role: "assistant",
					enriched,
				});
				message.parts.push({
					type: "data-usage",
					id: eventId,
					data: {
						eventId,
						createdAt: timestamp,
						used: event.used,
						size: event.size,
						cost: event.cost,
					},
				});
				break;
			}
			case "status": {
				const message = ensureMessage(messages, {
					role: "assistant",
					enriched,
				});
				message.parts.push({
					type: "data-status",
					id: eventId,
					data: {
						eventId,
						createdAt: timestamp,
						status: event.status,
						error: event.error,
						stopReason: event.stopReason,
					},
				});
				break;
			}
			case "mode_changed": {
				const message = ensureMessage(messages, {
					role: "assistant",
					enriched,
				});
				message.parts.push({
					type: "data-mode-changed",
					id: eventId,
					data: {
						eventId,
						createdAt: timestamp,
						modeId: event.modeId,
					},
				});
				break;
			}
			case "config_changed": {
				const message = ensureMessage(messages, {
					role: "assistant",
					enriched,
				});
				message.parts.push({
					type: "data-config-changed",
					id: eventId,
					data: {
						eventId,
						createdAt: timestamp,
						configOptions: event.configOptions,
					},
				});
				break;
			}
			case "info_changed": {
				const message = ensureMessage(messages, {
					role: "assistant",
					enriched,
				});
				message.parts.push({
					type: "data-info-changed",
					id: eventId,
					data: {
						eventId,
						createdAt: timestamp,
						title: event.title,
						updatedAt: event.updatedAt,
					},
				});
				break;
			}
			case "commands_changed": {
				const message = ensureMessage(messages, {
					role: "assistant",
					enriched,
				});
				message.parts.push({
					type: "data-commands-changed",
					id: eventId,
					data: {
						eventId,
						createdAt: timestamp,
						commands: event.commands,
					},
				});
				break;
			}
			default:
				break;
		}
	}

	return messages;
}
