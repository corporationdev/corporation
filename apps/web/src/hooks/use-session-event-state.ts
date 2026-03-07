import type { SessionEvent } from "@corporation/contracts/client-do";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TimelineEntry } from "@/components/chat/types";
import type { SpaceActor } from "@/lib/rivetkit";
import { useSessionStreamState } from "./use-session-stream-state";

export type SessionState = {
	entries: TimelineEntry[];
	rawEvents: SessionEvent[];
	status: string;
	agent: string | null;
	modelId: string | null;
	setStatus: (status: string) => void;
	addOptimisticUserMessage: (message: {
		clientId: string;
		text: string;
		createdAt?: number;
	}) => void;
	removeOptimisticUserMessage: (clientId: string) => void;
};

const OPTIMISTIC_MATCH_TIME_TOLERANCE_MS = 5000;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: event processing requires handling many event types
function eventsToEntries(events: SessionEvent[]): TimelineEntry[] {
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

type OptimisticUserMessage = {
	clientId: string;
	text: string;
	createdAt: number;
};

function normalizeMessageText(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function reconcileOptimisticMessages(
	realEntries: TimelineEntry[],
	optimisticMessages: OptimisticUserMessage[]
): OptimisticUserMessage[] {
	const realUserEntries = realEntries.filter(
		(entry) =>
			entry.kind === "message" &&
			entry.role === "user" &&
			typeof entry.text === "string"
	);

	let searchStart = 0;
	const remaining: OptimisticUserMessage[] = [];

	for (const optimistic of optimisticMessages) {
		const targetText = normalizeMessageText(optimistic.text);
		let matchedIndex = -1;

		for (let index = searchStart; index < realUserEntries.length; index += 1) {
			const candidate = realUserEntries[index];
			const candidateText = candidate.text;
			if (!candidateText) {
				continue;
			}

			const candidateTime = Date.parse(candidate.time);
			if (
				Number.isFinite(candidateTime) &&
				candidateTime + OPTIMISTIC_MATCH_TIME_TOLERANCE_MS <
					optimistic.createdAt
			) {
				continue;
			}

			if (normalizeMessageText(candidateText) === targetText) {
				matchedIndex = index;
				break;
			}
		}

		if (matchedIndex === -1) {
			remaining.push(optimistic);
			continue;
		}

		searchStart = matchedIndex + 1;
	}

	return remaining;
}

function optimisticMessageToEntry(
	message: OptimisticUserMessage
): TimelineEntry {
	return {
		id: `optimistic-${message.clientId}`,
		kind: "message",
		time: new Date(message.createdAt).toISOString(),
		role: "user",
		text: message.text,
	};
}

export function useSessionEventState({
	sessionId,
	spaceSlug,
	actor,
}: {
	sessionId: string;
	spaceSlug: string;
	actor: SpaceActor;
}): SessionState {
	const {
		rawEvents,
		status: sessionStatus,
		agent: sessionAgent,
		modelId: sessionModelId,
		setStatus: setSessionStatus,
	} = useSessionStreamState({
		sessionId,
		spaceSlug,
		actor,
	});
	const [optimisticMessages, setOptimisticMessages] = useState<
		OptimisticUserMessage[]
	>([]);

	useEffect(() => {
		if (!sessionId) {
			return;
		}
		setOptimisticMessages([]);
	}, [sessionId]);

	const addOptimisticUserMessage = useCallback(
		(message: { clientId: string; text: string; createdAt?: number }) => {
			const text = message.text.trim();
			if (!text) {
				return;
			}
			setOptimisticMessages((current) => {
				if (
					current.some((candidate) => candidate.clientId === message.clientId)
				) {
					return current;
				}
				return [
					...current,
					{
						clientId: message.clientId,
						text,
						createdAt: message.createdAt ?? Date.now(),
					},
				];
			});
		},
		[]
	);

	const removeOptimisticUserMessage = useCallback((clientId: string) => {
		setOptimisticMessages((current) =>
			current.filter((candidate) => candidate.clientId !== clientId)
		);
	}, []);

	const realEntries = useMemo(() => eventsToEntries(rawEvents), [rawEvents]);
	const unmatchedOptimisticMessages = useMemo(
		() => reconcileOptimisticMessages(realEntries, optimisticMessages),
		[realEntries, optimisticMessages]
	);

	useEffect(() => {
		setOptimisticMessages((current) => {
			if (current.length !== unmatchedOptimisticMessages.length) {
				return unmatchedOptimisticMessages;
			}
			for (let index = 0; index < current.length; index += 1) {
				if (
					current[index].clientId !==
					unmatchedOptimisticMessages[index]?.clientId
				) {
					return unmatchedOptimisticMessages;
				}
			}
			return current;
		});
	}, [unmatchedOptimisticMessages]);

	const entries = useMemo(
		() => [
			...realEntries,
			...unmatchedOptimisticMessages.map(optimisticMessageToEntry),
		],
		[realEntries, unmatchedOptimisticMessages]
	);

	return {
		entries,
		rawEvents,
		status: sessionStatus,
		agent: sessionAgent,
		modelId: sessionModelId,
		setStatus: setSessionStatus,
		addOptimisticUserMessage,
		removeOptimisticUserMessage,
	};
}
