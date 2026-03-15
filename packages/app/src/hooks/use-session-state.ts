import type { JsonBatch, StreamResponse } from "@durable-streams/client";
import { stream } from "@durable-streams/client";
import type { SessionStreamFrame } from "@tendril/contracts/browser-do";
import { env } from "@tendril/env/web";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAuthHeaders, getSessionStreamState } from "@/lib/api-client";
import {
	type EnrichedSessionEvent,
	sessionEventsToMessages,
} from "@/lib/session-events-to-messages";
import {
	createOptimisticUserTextMessage,
	getTendrilMessageText,
	type TendrilUIMessage,
} from "@/lib/tendril-ui-message";
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
	events: EnrichedSessionEvent[];
	status: string | null;
	error: string | null | undefined;
} {
	const events: EnrichedSessionEvent[] = [];
	let status: string | null = null;
	let error: string | null | undefined;

	for (const frame of batch.items) {
		if (frame.event.sessionId !== sessionId) {
			continue;
		}

		events.push({
			eventId: frame.eventId,
			createdAt: frame.createdAt,
			event: frame.event,
		});
		if (frame.event.kind === "status") {
			status = frame.event.status;
			error = frame.event.error;
		}
	}

	return { events, status, error };
}

export type SessionState = {
	messages: TendrilUIMessage[];
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
	const [events, setEvents] = useState<EnrichedSessionEvent[]>([]);
	const [optimisticMessages, setOptimisticMessages] = useState<
		TendrilUIMessage[]
	>([]);
	const [sessionStatus, setSessionStatus] = useState<string>("idle");
	const [sessionError, setSessionError] = useState<string | null>(null);
	const [sessionAgent, setSessionAgent] = useState<string | null>(null);
	const [sessionModelId, setSessionModelId] = useState<string | null>(null);

	const addOptimisticMessage = useCallback((text: string) => {
		setOptimisticMessages((prev) => [
			...prev,
			createOptimisticUserTextMessage({
				id: `optimistic-${nanoid()}`,
				sessionId,
				text,
			}),
		]);
		setSessionStatus("running");
	}, [sessionId]);

	const clearOptimisticMessages = useCallback(() => {
		setOptimisticMessages([]);
		setSessionStatus("idle");
	}, []);

	const addEvents = useCallback((newEvents: EnrichedSessionEvent[]) => {
		const unseen: EnrichedSessionEvent[] = [];
		for (const enriched of newEvents) {
			if (!seenEventIdsRef.current.has(enriched.eventId)) {
				seenEventIdsRef.current.add(enriched.eventId);
				unseen.push(enriched);
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

	const messages = useMemo(() => {
		const serverMessages = sessionEventsToMessages(events);
		if (optimisticMessages.length === 0) {
			return serverMessages;
		}
		const serverUserTexts = new Set(
			serverMessages
				.filter((message) => message.role === "user")
				.map((message) => getTendrilMessageText(message))
		);
		const pending = optimisticMessages.filter(
			(message) => !serverUserTexts.has(getTendrilMessageText(message))
		);
		return pending.length > 0
			? [...serverMessages, ...pending]
			: serverMessages;
	}, [events, optimisticMessages]);

	return {
		messages,
		status: sessionStatus,
		error: sessionError,
		agent: sessionAgent,
		modelId: sessionModelId,
		addOptimisticMessage,
		clearOptimisticMessages,
	};
}
