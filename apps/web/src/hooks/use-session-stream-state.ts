import type {
	SessionEvent,
	SessionStreamFrame,
} from "@corporation/contracts/client-do";
import { env } from "@corporation/env/web";
import type { JsonBatch, StreamResponse } from "@durable-streams/client";
import { stream } from "@durable-streams/client";
import type { InferResponseType } from "hono/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient, getAuthHeaders } from "@/lib/api-client";
import type { SpaceActor } from "@/lib/rivetkit";
import { toAbsoluteUrl } from "@/lib/url";

const getSessionStreamStateRoute =
	apiClient.spaces[":spaceSlug"].sessions[":sessionId"].state.$get;

type SessionStreamStateResponse = InferResponseType<
	typeof getSessionStreamStateRoute,
	200
>;

export type SessionStreamStateData = {
	rawEvents: SessionEvent[];
	status: string;
	agent: string | null;
	modelId: string | null;
	setStatus: (status: string) => void;
};

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
): Promise<SessionStreamStateResponse> {
	const response = await getSessionStreamStateRoute(
		{
			param: {
				spaceSlug,
				sessionId,
			},
		},
		{
			init: { signal },
		}
	);
	if (!response.ok) {
		throw new Error(`Failed to fetch session state (${response.status})`);
	}
	return response.json();
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

export function useSessionStreamState({
	sessionId,
	spaceSlug,
	actor,
}: {
	sessionId: string;
	spaceSlug: string;
	actor: SpaceActor;
}): SessionStreamStateData {
	const seenEventIdsRef = useRef<Set<string>>(new Set());
	const [events, setEvents] = useState<SessionEvent[]>([]);
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
		setSessionStatus("idle");
		setSessionAgent(null);
		setSessionModelId(null);
	}, [sessionId]);

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

	return {
		rawEvents: events,
		status: sessionStatus,
		agent: sessionAgent,
		modelId: sessionModelId,
		setStatus: setSessionStatus,
	};
}
