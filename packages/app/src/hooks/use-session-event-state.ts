import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionEvent } from "sandbox-agent";
import type { TimelineEntry } from "@/components/chat/types";
import {
	isTransientActorConnError,
	softResetActorConnectionOnTransientError,
} from "@/lib/actor-errors";
import type { SpaceActor } from "@/lib/rivetkit";

export type SessionState = {
	entries: TimelineEntry[];
	rawEvents: SessionEvent[];
	status: string;
	setStatus: (status: string) => void;
};

const TRANSCRIPT_PAGE_SIZE = 200;

type SessionStateConnection = {
	getSessionState: (
		sessionId: string,
		offset: number,
		limit: number
	) =>
		| Promise<{ events: SessionEvent[]; status: string }>
		| Promise<Promise<{ events: SessionEvent[]; status: string }>>;
};

async function loadSessionState(
	conn: SessionStateConnection,
	sessionId: string,
	isCancelled: () => boolean
): Promise<{ events: SessionEvent[]; status: string }> {
	const events: SessionEvent[] = [];
	let offset = 0;
	let status = "idle";

	while (true) {
		if (isCancelled()) {
			break;
		}

		const resultPromise = await conn.getSessionState(
			sessionId,
			offset,
			TRANSCRIPT_PAGE_SIZE
		);
		const result = await resultPromise;
		if (isCancelled()) {
			break;
		}

		// Update status from the latest response
		status = result.status;

		if (result.events.length === 0) {
			break;
		}

		events.push(...result.events);
		offset += result.events.length;
		if (result.events.length < TRANSCRIPT_PAGE_SIZE) {
			break;
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

export function useSessionEventState({
	sessionId,
	actor,
}: {
	sessionId: string;
	actor: SpaceActor;
}): SessionState {
	const seenEventIdsRef = useRef<Set<string>>(new Set());
	const caughtUpRef = useRef(false);
	const bufferRef = useRef<SessionEvent[]>([]);
	const [events, setEvents] = useState<SessionEvent[]>([]);
	const [sessionStatus, setSessionStatus] = useState<string>("idle");

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
		caughtUpRef.current = false;
		bufferRef.current = [];
		setEvents([]);
		setSessionStatus("idle");
	}, [sessionId]);

	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		let isCancelled = false;
		caughtUpRef.current = false;
		bufferRef.current = [];

		const conn = actor.connection;
		(async () => {
			await conn.subscribeSession(sessionId);
			const { events: loaded, status } = await loadSessionState(
				conn,
				sessionId,
				() => isCancelled
			);
			if (isCancelled) {
				return;
			}
			sortSessionEvents(loaded);
			addEvents(loaded);
			setSessionStatus(status);
			addEvents(bufferRef.current);
			bufferRef.current = [];
			caughtUpRef.current = true;
		})().catch((error: unknown) => {
			const kind = softResetActorConnectionOnTransientError({
				error,
				reasonPrefix: "session-stream",
			});
			if (kind) {
				if (kind === "inflight-mismatch") {
					console.warn("actor-conn.session-stream.inflight-mismatch", {
						sessionId,
					});
				}
				return;
			}
			console.error("Failed to initialize session stream", error);
		});

		return () => {
			isCancelled = true;
			conn.unsubscribeSession(sessionId).catch((error: unknown) => {
				if (isTransientActorConnError(error)) {
					return;
				}
				console.error("Failed to unsubscribe session", error);
			});
		};
	}, [actor.connStatus, actor.connection, addEvents, sessionId]);

	actor.useEvent("session.event", (event) => {
		const typed = event as SessionEvent;
		if (!caughtUpRef.current) {
			bufferRef.current.push(typed);
			return;
		}
		addEvents([typed]);
	});

	actor.useEvent(
		"session.status",
		(event: { sessionId: string; status: string }) => {
			if (event.sessionId === sessionId) {
				setSessionStatus(event.status);
			}
		}
	);

	const entries = useMemo(() => eventsToEntries(events), [events]);

	return {
		entries,
		rawEvents: events,
		status: sessionStatus,
		setStatus: setSessionStatus,
	};
}
