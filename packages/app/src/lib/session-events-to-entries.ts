import type { SessionEvent } from "@corporation/contracts/session-event";
import type {
	MessageTimelineEntry,
	ReasoningTimelineEntry,
	TimelineEntry,
	ToolTimelineEntry,
} from "@/components/chat/types";

export type EnrichedSessionEvent = {
	eventId: string;
	createdAt: number;
	event: SessionEvent;
};

function extractText(
	content: SessionEvent extends infer E
		? E extends { kind: "text_delta"; content: infer C }
			? C
			: never
		: never
): string | null {
	if (content.type === "text") {
		return content.text || null;
	}
	return null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: event translation is intentionally centralized here
export function sessionEventsToEntries(
	enrichedEvents: EnrichedSessionEvent[]
): TimelineEntry[] {
	const entries: TimelineEntry[] = [];

	let assistantEntry: MessageTimelineEntry | null = null;
	let assistantAccumText = "";
	let thoughtEntry: ReasoningTimelineEntry | null = null;
	let thoughtAccumText = "";

	const flushAssistant = (time: string) => {
		if (assistantEntry) {
			assistantEntry.text = assistantAccumText;
			assistantEntry.time = time;
		}
		assistantEntry = null;
		assistantAccumText = "";
	};

	const flushThought = (time: string) => {
		if (thoughtEntry) {
			thoughtEntry.reasoning.text = thoughtAccumText;
			thoughtEntry.time = time;
		}
		thoughtEntry = null;
		thoughtAccumText = "";
	};

	const toolEntryMap = new Map<string, ToolTimelineEntry>();

	for (const { eventId, createdAt, event } of enrichedEvents) {
		const time = new Date(createdAt).toISOString();

		switch (event.kind) {
			case "text_delta": {
				const text = extractText(event.content);
				if (!text) {
					break;
				}

				switch (event.channel) {
					case "user": {
						flushAssistant(time);
						flushThought(time);
						const replayPrefix = "Previous session history is replayed below";
						const cleaned = text
							.split("\n\n")
							.map((part) => part.trim())
							.filter(
								(partText) =>
									partText.length > 0 && !partText.startsWith(replayPrefix)
							)
							.join("\n\n")
							.trim();
						if (!cleaned) {
							break;
						}
						entries.push({
							id: eventId,
							kind: "message",
							time,
							role: "user",
							text: cleaned,
						});
						break;
					}
					case "assistant": {
						if (!assistantEntry) {
							assistantAccumText = "";
							assistantEntry = {
								id: `assistant-${eventId}`,
								kind: "message",
								time,
								role: "assistant",
								text: "",
							};
							entries.push(assistantEntry);
						}
						assistantAccumText += text;
						assistantEntry.text = assistantAccumText;
						assistantEntry.time = time;
						break;
					}
					case "thinking": {
						if (!thoughtEntry) {
							thoughtAccumText = "";
							thoughtEntry = {
								id: `thought-${eventId}`,
								kind: "reasoning",
								time,
								reasoning: {
									text: "",
									visibility: "public",
								},
							};
							entries.push(thoughtEntry);
						}
						thoughtAccumText += text;
						thoughtEntry.reasoning.text = thoughtAccumText;
						thoughtEntry.time = time;
						break;
					}
					default:
						break;
				}
				break;
			}
			case "tool_start": {
				flushAssistant(time);
				flushThought(time);
				const tc = event.toolCall;
				const existing = toolEntryMap.get(tc.toolCallId);
				if (existing) {
					if (tc.status) {
						existing.toolStatus = tc.status;
					}
					if (tc.rawInput != null) {
						existing.toolInput = JSON.stringify(tc.rawInput, null, 2);
					}
					if (tc.rawOutput != null) {
						existing.toolOutput = JSON.stringify(tc.rawOutput, null, 2);
					}
					existing.toolName = tc.title ?? existing.toolName;
					existing.time = time;
				} else {
					const entry: ToolTimelineEntry = {
						id: `tool-${tc.toolCallId}`,
						kind: "tool",
						time,
						toolName: tc.title ?? undefined,
						toolInput:
							tc.rawInput != null
								? JSON.stringify(tc.rawInput, null, 2)
								: undefined,
						toolOutput:
							tc.rawOutput != null
								? JSON.stringify(tc.rawOutput, null, 2)
								: undefined,
						toolStatus: tc.status ?? "in_progress",
					};
					toolEntryMap.set(tc.toolCallId, entry);
					entries.push(entry);
				}
				break;
			}
			case "tool_update": {
				const tc = event.toolCall;
				const existing = toolEntryMap.get(tc.toolCallId);
				if (existing) {
					if (tc.status) {
						existing.toolStatus = tc.status;
					}
					if (tc.rawInput != null) {
						existing.toolInput = JSON.stringify(tc.rawInput, null, 2);
					}
					if (tc.rawOutput != null) {
						existing.toolOutput = JSON.stringify(tc.rawOutput, null, 2);
					}
					if (tc.title) {
						existing.toolName = tc.title;
					}
					existing.time = time;
				}
				break;
			}
			case "plan": {
				const detail = event.entries
					.map((entry) => `[${entry.status}] ${entry.content}`)
					.join("\n");
				entries.push({
					id: eventId,
					kind: "meta",
					time,
					meta: {
						title: "Plan",
						detail,
						severity: "info",
					},
				});
				break;
			}
			case "status": {
				if (event.status === "error" && event.error) {
					entries.push({
						id: eventId,
						kind: "meta",
						time,
						meta: {
							title: "Error",
							detail: event.error,
							severity: "error",
						},
					});
				}
				break;
			}
			default:
				break;
		}
	}

	return entries;
}
