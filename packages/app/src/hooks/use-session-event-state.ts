import { env } from "@corporation/env/web";
import type {
	SessionEvent,
	SessionStreamFrame,
	SessionStreamState,
} from "@corporation/shared/session-protocol";
import type { JsonBatch, StreamResponse } from "@durable-streams/client";
import { stream } from "@durable-streams/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TimelineEntry } from "@/components/chat/types";
import { getAuthHeaders } from "@/lib/api-client";
import type { SpaceActor } from "@/lib/rivetkit";
import { toAbsoluteUrl } from "@/lib/url";

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

function buildSessionStreamBaseUrl(
	spaceSlug: string,
	sessionId: string
): string {
	const encodedSpaceSlug = encodeURIComponent(spaceSlug);
	const encodedSessionId = encodeURIComponent(sessionId);
	return toAbsoluteUrl(
		`${env.VITE_SERVER_URL}/spaces/${encodedSpaceSlug}/sessions/${encodedSessionId}`
	);
}

async function fetchSessionStreamState(
	spaceSlug: string,
	sessionId: string,
	signal: AbortSignal
): Promise<SessionStreamState> {
	const baseUrl = buildSessionStreamBaseUrl(spaceSlug, sessionId);
	const authHeaders = await getAuthHeaders();
	const response = await fetch(`${baseUrl}/state`, {
		headers: authHeaders,
		signal,
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch session state (${response.status})`);
	}
	return response.json() as Promise<SessionStreamState>;
}

function readStreamBatch(
	batch: JsonBatch<SessionStreamFrame>,
	sessionId: string
): {
	events: SessionEvent[];
	status: string | null;
} {
	const events: SessionEvent[] = [];
	let status: string | null = null;

	for (const frame of batch.items) {
		if (frame.kind === "event") {
			if (frame.event.sessionId === sessionId) {
				events.push(frame.event);
			}
			continue;
		}

		if (frame.kind === "status_changed") {
			status = frame.status;
		}
	}

	return { events, status };
}

function sortSessionEvents(events: SessionEvent[]): void {
	events.sort((left, right) => {
		if (left.createdAt !== right.createdAt) {
			return left.createdAt - right.createdAt;
		}
		if (left.eventIndex !== right.eventIndex) {
			return left.eventIndex - right.eventIndex;
		}
		return left.id.localeCompare(right.id);
	});
}

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
		const payload = event.payload as Record<string, unknown>;
		const method = typeof payload.method === "string" ? payload.method : null;
		const time = new Date(event.createdAt).toISOString();

		if (event.sender === "client" && method === "session/prompt") {
			flushAssistant(time);
			flushThought(time);
			const params = payload.params as Record<string, unknown> | undefined;
			const promptArray = params?.prompt as
				| Array<{ type: string; text?: string }>
				| undefined;
			const replayPrefix = "Previous session history is replayed below";
			const text = (promptArray ?? [])
				.filter(
					(part) => part?.type === "text" && typeof part.text === "string"
				)
				.map((part) => part.text?.trim() ?? "")
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
			continue;
		}

		if (event.sender === "agent" && method === "session/update") {
			const params = payload.params as Record<string, unknown> | undefined;
			const update = params?.update as Record<string, unknown> | undefined;
			if (!update || typeof update.sessionUpdate !== "string") {
				continue;
			}

			switch (update.sessionUpdate) {
				case "agent_message_chunk": {
					const content = update.content as
						| { type?: string; text?: string }
						| undefined;
					if (content?.type === "text" && content.text) {
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
						assistantAccumText += content.text;
						const entry = entries.find((e) => e.id === assistantAccumId);
						if (entry) {
							entry.text = assistantAccumText;
							entry.time = time;
						}
					}
					break;
				}
				case "agent_thought_chunk": {
					const content = update.content as
						| { type?: string; text?: string }
						| undefined;
					if (content?.type === "text" && content.text) {
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
						thoughtAccumText += content.text;
						const entry = entries.find((e) => e.id === thoughtAccumId);
						if (entry?.reasoning) {
							entry.reasoning.text = thoughtAccumText;
							entry.time = time;
						}
					}
					break;
				}
				case "tool_call": {
					flushAssistant(time);
					flushThought(time);
					const toolCallId = (update.toolCallId as string) ?? event.id;
					const existing = toolEntryMap.get(toolCallId);
					if (existing) {
						if (update.status) {
							existing.toolStatus = update.status as string;
						}
						if (update.rawInput != null) {
							existing.toolInput = JSON.stringify(update.rawInput, null, 2);
						}
						if (update.rawOutput != null) {
							existing.toolOutput = JSON.stringify(update.rawOutput, null, 2);
						}
						if (update.title) {
							existing.toolName = update.title as string;
						}
						existing.time = time;
					} else {
						const entry: TimelineEntry = {
							id: `tool-${toolCallId}`,
							kind: "tool",
							time,
							toolName: (update.title as string) ?? "tool",
							toolInput:
								update.rawInput != null
									? JSON.stringify(update.rawInput, null, 2)
									: undefined,
							toolOutput:
								update.rawOutput != null
									? JSON.stringify(update.rawOutput, null, 2)
									: undefined,
							toolStatus: (update.status as string) ?? "in_progress",
						};
						toolEntryMap.set(toolCallId, entry);
						entries.push(entry);
					}
					break;
				}
				case "tool_call_update": {
					const toolCallId = update.toolCallId as string;
					const existing = toolEntryMap.get(toolCallId);
					if (existing) {
						if (update.status) {
							existing.toolStatus = update.status as string;
						}
						if (update.rawOutput != null) {
							existing.toolOutput = JSON.stringify(update.rawOutput, null, 2);
						}
						if (update.title) {
							existing.toolName = update.title as string;
						}
						existing.time = time;
					}
					break;
				}
				case "plan": {
					const planEntries =
						(update.entries as Array<{
							content: string;
							status: string;
						}>) ?? [];
					const detail = planEntries
						.map((e) => `[${e.status}] ${e.content}`)
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
	const seenEventIdsRef = useRef<Set<string>>(new Set());
	const [events, setEvents] = useState<SessionEvent[]>([]);
	const [optimisticMessages, setOptimisticMessages] = useState<
		OptimisticUserMessage[]
	>([]);
	const [sessionStatus, setSessionStatus] = useState<string>("idle");
	const [sessionAgent, setSessionAgent] = useState<string | null>(null);
	const [sessionModelId, setSessionModelId] = useState<string | null>(null);

	const addEvents = useCallback((newEvents: SessionEvent[]) => {
		const unseen: SessionEvent[] = [];
		for (const event of newEvents) {
			if (!seenEventIdsRef.current.has(event.id)) {
				seenEventIdsRef.current.add(event.id);
				unseen.push(event);
			}
		}
		if (unseen.length > 0) {
			setEvents((prev) => [...prev, ...unseen]);
		}
	}, []);

	useEffect(() => {
		if (!sessionId) {
			return;
		}
		seenEventIdsRef.current = new Set();
		setEvents([]);
		setOptimisticMessages([]);
		setSessionStatus("idle");
		setSessionAgent(null);
		setSessionModelId(null);
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

	useEffect(() => {
		if (!sessionId || actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		const abortController = new AbortController();
		let isCancelled = false;
		let unsubscribe: (() => void) | null = null;
		let streamResponse: StreamResponse<SessionStreamFrame> | null = null;

		(async () => {
			const state = await fetchSessionStreamState(
				spaceSlug,
				sessionId,
				abortController.signal
			);
			if (isCancelled) {
				return;
			}

			setSessionStatus(state.status);
			setSessionAgent(state.agent);
			setSessionModelId(state.modelId);

			const streamUrl = `${buildSessionStreamBaseUrl(spaceSlug, sessionId)}/stream`;
			streamResponse = await stream<SessionStreamFrame>({
				url: streamUrl,
				offset: "-1",
				live: true,
				headers: {
					Authorization: async () => (await getAuthHeaders()).Authorization,
				},
				signal: abortController.signal,
			});
			if (isCancelled) {
				streamResponse.cancel();
				return;
			}

			unsubscribe = streamResponse.subscribeJson(
				(batch: JsonBatch<SessionStreamFrame>) => {
					if (isCancelled) {
						return;
					}

					const updates = readStreamBatch(batch, sessionId);
					if (updates.events.length > 0) {
						sortSessionEvents(updates.events);
						addEvents(updates.events);
					}
					if (updates.status) {
						setSessionStatus(updates.status);
					}
				}
			);
		})().catch((error: unknown) => {
			if (isCancelled) {
				return;
			}
			console.error("Failed to initialize session stream", error);
		});

		return () => {
			isCancelled = true;
			abortController.abort("session-stream-cleanup");
			unsubscribe?.();
			streamResponse?.cancel("session-stream-cleanup");
		};
	}, [actor.connStatus, actor.connection, addEvents, sessionId, spaceSlug]);

	const realEntries = useMemo(() => eventsToEntries(events), [events]);
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
		rawEvents: events,
		status: sessionStatus,
		agent: sessionAgent,
		modelId: sessionModelId,
		setStatus: setSessionStatus,
		addOptimisticUserMessage,
		removeOptimisticUserMessage,
	};
}
