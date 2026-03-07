import type { SessionEvent } from "@corporation/contracts/client-do";
import type { TimelineEntry } from "@/components/chat/types";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: event translation is intentionally centralized here
export function sessionEventsToEntries(events: SessionEvent[]): TimelineEntry[] {
	const entries: TimelineEntry[] = [];

	let assistantAccumId: string | null = null;
	let assistantAccumText = "";
	let thoughtAccumId: string | null = null;
	let thoughtAccumText = "";

	const flushAssistant = (time: string) => {
		if (assistantAccumId) {
			const existing = entries.find((e) => e.id === assistantAccumId);
			if (existing) {
				existing.text = assistantAccumText;
				existing.time = time;
			}
		}
		assistantAccumId = null;
		assistantAccumText = "";
	};

	const flushThought = (time: string) => {
		if (thoughtAccumId) {
			const existing = entries.find((e) => e.id === thoughtAccumId);
			if (existing?.reasoning) {
				existing.reasoning.text = thoughtAccumText;
				existing.time = time;
			}
		}
		thoughtAccumId = null;
		thoughtAccumText = "";
	};

	const toolEntryMap = new Map<string, TimelineEntry>();

	for (const event of events) {
		const time = new Date(event.createdAt).toISOString();

		switch (event.kind) {
			case "user_prompt": {
				if (!event.text) {
					continue;
				}
				flushAssistant(time);
				flushThought(time);
				const replayPrefix = "Previous session history is replayed below";
				const text = event.text
					.split("\n\n")
					.map((part) => part.trim())
					.filter(
						(partText) =>
							partText.length > 0 && !partText.startsWith(replayPrefix)
					)
					.join("\n\n")
					.trim();
				if (!text) {
					continue;
				}
				entries.push({
					id: event.id,
					kind: "message",
					time,
					role: "user",
					text,
				});
				break;
			}
			case "agent_message_chunk": {
				if (!event.text) {
					break;
				}
				if (!assistantAccumId) {
					assistantAccumId = `assistant-${event.id}`;
					assistantAccumText = "";
					entries.push({
						id: assistantAccumId,
						kind: "message",
						time,
						role: "assistant",
						text: "",
					});
				}
				assistantAccumText += event.text;
				const entry = entries.find((e) => e.id === assistantAccumId);
				if (entry) {
					entry.text = assistantAccumText;
					entry.time = time;
				}
				break;
			}
			case "agent_thought_chunk": {
				if (!event.text) {
					break;
				}
				if (!thoughtAccumId) {
					thoughtAccumId = `thought-${event.id}`;
					thoughtAccumText = "";
					entries.push({
						id: thoughtAccumId,
						kind: "reasoning",
						time,
						reasoning: {
							text: "",
							visibility: "public",
						},
					});
				}
				thoughtAccumText += event.text;
				const entry = entries.find((e) => e.id === thoughtAccumId);
				if (entry?.reasoning) {
					entry.reasoning.text = thoughtAccumText;
					entry.time = time;
				}
				break;
			}
			case "tool_call": {
				flushAssistant(time);
				flushThought(time);
				const existing = toolEntryMap.get(event.toolCallId);
				if (existing) {
					if (event.status) {
						existing.toolStatus = event.status;
					}
					if (event.rawInput != null) {
						existing.toolInput = JSON.stringify(event.rawInput, null, 2);
					}
					if (event.rawOutput != null) {
						existing.toolOutput = JSON.stringify(event.rawOutput, null, 2);
					}
					existing.toolName = event.title;
					existing.time = time;
				} else {
					const entry: TimelineEntry = {
						id: `tool-${event.toolCallId}`,
						kind: "tool",
						time,
						toolName: event.title,
						toolInput:
							event.rawInput != null
								? JSON.stringify(event.rawInput, null, 2)
								: undefined,
						toolOutput:
							event.rawOutput != null
								? JSON.stringify(event.rawOutput, null, 2)
								: undefined,
						toolStatus: event.status ?? "in_progress",
					};
					toolEntryMap.set(event.toolCallId, entry);
					entries.push(entry);
				}
				break;
			}
			case "tool_call_update": {
				const existing = toolEntryMap.get(event.toolCallId);
				if (existing) {
					if (event.status) {
						existing.toolStatus = event.status;
					}
					if (event.rawInput != null) {
						existing.toolInput = JSON.stringify(event.rawInput, null, 2);
					}
					if (event.rawOutput != null) {
						existing.toolOutput = JSON.stringify(event.rawOutput, null, 2);
					}
					if (event.title) {
						existing.toolName = event.title;
					}
					existing.time = time;
				}
				break;
			}
			case "plan": {
				const detail = event.update.entries
					.map((entry) => `[${entry.status}] ${entry.content}`)
					.join("\n");
				entries.push({
					id: event.id,
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
			default:
				break;
		}
	}

	return entries;
}
