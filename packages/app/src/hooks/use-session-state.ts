import type {
	SessionEvent,
	SessionStreamFrame,
} from "@corporation/contracts/browser-do";
import { env } from "@corporation/env/web";
import type { JsonBatch, StreamResponse } from "@durable-streams/client";
import { stream } from "@durable-streams/client";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	MessageTimelineEntry,
	TimelineEntry,
} from "@/components/chat/types";
import { getAuthHeaders, getSessionStreamState } from "@/lib/api-client";
import { sessionEventsToEntries } from "@/lib/session-events-to-entries";
import { toAbsoluteUrl } from "@/lib/url";

function buildSessionStreamBaseUrl(
	spaceSlug: string,
	sessionId: string
): string {
	const baseUrl = new URL(toAbsoluteUrl(env.VITE_SERVER_URL));
	baseUrl.pathname = `/api/spaces/${encodeURIComponent(spaceSlug)}/sessions/${encodeURIComponent(sessionId)}`;
	return baseUrl.toString();
}

function readStreamBatch(
	batch: JsonBatch<SessionStreamFrame>,
	sessionId: string
): {
	events: SessionEvent[];
	status: string | null;
	error: string | null | undefined;
} {
	const events: SessionEvent[] = [];
	let status: string | null = null;
	let error: string | null | undefined;

	for (const frame of batch.items) {
		if (frame.kind === "event") {
			if (frame.event.sessionId === sessionId) {
				events.push(frame.event);
			}
			continue;
		}

		if (frame.kind === "status_changed") {
			status = frame.status;
			error = frame.error;
		}
	}

	return { events, status, error };
}

export type SessionState = {
	entries: TimelineEntry[];
	status: string;
	error: string | null;
	agent: string | null;
	modelId: string | null;
	addOptimisticMessage: (text: string) => void;
	clearOptimisticMessages: () => void;
};

export function useSessionState({
	sessionId,
	spaceSlug,
	streamEnabled,
}: {
	sessionId: string;
	spaceSlug: string;
	streamEnabled: boolean;
}): SessionState {
	const seenEventIdsRef = useRef<Set<string>>(new Set());
	const [events, setEvents] = useState<SessionEvent[]>([]);
	const [optimisticMessages, setOptimisticMessages] = useState<
		MessageTimelineEntry[]
	>([]);
	const [sessionStatus, setSessionStatus] = useState<string>("idle");
	const [sessionError, setSessionError] = useState<string | null>(null);
	const [sessionAgent, setSessionAgent] = useState<string | null>(null);
	const [sessionModelId, setSessionModelId] = useState<string | null>(null);

	const addOptimisticMessage = useCallback((text: string) => {
		const entry: MessageTimelineEntry = {
			id: `optimistic-${nanoid()}`,
			kind: "message",
			time: new Date().toISOString(),
			role: "user",
			text,
		};
		setOptimisticMessages((prev) => [...prev, entry]);
		setSessionStatus("running");
	}, []);

	const clearOptimisticMessages = useCallback(() => {
		setOptimisticMessages([]);
		setSessionStatus("idle");
	}, []);

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
		setSessionError(null);
		setSessionAgent(null);
		setSessionModelId(null);
	}, [sessionId]);

	useEffect(() => {
		if (!(sessionId && streamEnabled)) {
			return;
		}

		const abortController = new AbortController();
		let isCancelled = false;
		let unsubscribe: (() => void) | null = null;
		let streamResponse: StreamResponse<SessionStreamFrame> | null = null;

		(async () => {
			const state = await getSessionStreamState(spaceSlug, sessionId);
			if (isCancelled) {
				return;
			}

			setSessionStatus(state.status);
			setSessionError(state.error ?? null);
			setSessionAgent(state.agent);
			setSessionModelId(state.modelId);

			const streamUrl = `${buildSessionStreamBaseUrl(spaceSlug, sessionId)}/stream`;
			streamResponse = await stream<SessionStreamFrame>({
				url: streamUrl,
				offset: "-1",
				live: "sse",
				json: true,
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
						addEvents(updates.events);
					}
					if (updates.status) {
						setSessionStatus(updates.status);
					}
					if (updates.error !== undefined) {
						setSessionError(updates.error ?? null);
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
	}, [addEvents, sessionId, spaceSlug, streamEnabled]);

	const entries = useMemo(() => {
		const serverEntries = sessionEventsToEntries(events);
		if (optimisticMessages.length === 0) {
			return serverEntries;
		}
		const serverUserTexts = new Set(
			serverEntries
				.filter(
					(e): e is MessageTimelineEntry =>
						e.kind === "message" && e.role === "user"
				)
				.map((e) => e.text)
		);
		const pending = optimisticMessages.filter(
			(m) => !serverUserTexts.has(m.text)
		);
		return pending.length > 0 ? [...serverEntries, ...pending] : serverEntries;
	}, [events, optimisticMessages]);

	return {
		entries,
		status: sessionStatus,
		error: sessionError,
		agent: sessionAgent,
		modelId: sessionModelId,
		addOptimisticMessage,
		clearOptimisticMessages,
	};
}
