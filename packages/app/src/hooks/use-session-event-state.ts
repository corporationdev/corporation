import type { ThreadMessageLike } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionEvent } from "sandbox-agent";
import {
	createEventState,
	type EventState,
	processEvent,
} from "@/lib/convert-events";
import type { SpaceActor } from "@/lib/rivetkit";

type SessionState = {
	messages: ThreadMessageLike[];
	isRunning: boolean;
};

const TRANSCRIPT_PAGE_SIZE = 200;

function isActorConnDisposedError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const message = error.message.toLowerCase();
	return (
		error.name === "ActorConnDisposed" ||
		message.includes("disposed actor connection")
	);
}

type TranscriptConnection = {
	getTranscript: (
		sessionId: string,
		offset: number,
		limit: number
	) => Promise<SessionEvent[] | Promise<SessionEvent[]>>;
};

async function loadTranscriptEvents(
	conn: TranscriptConnection,
	sessionId: string,
	isCancelled: () => boolean
): Promise<SessionEvent[]> {
	const events: SessionEvent[] = [];
	let offset = 0;

	while (true) {
		if (isCancelled()) {
			break;
		}

		const pageResult = await conn.getTranscript(
			sessionId,
			offset,
			TRANSCRIPT_PAGE_SIZE
		);
		const page = await pageResult;
		if (isCancelled()) {
			break;
		}

		if (page.length === 0) {
			break;
		}

		events.push(...page);
		offset += page.length;
		if (page.length < TRANSCRIPT_PAGE_SIZE) {
			break;
		}
	}

	return events;
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

export function useSessionEventState({
	sessionId,
	actor,
}: {
	sessionId: string;
	actor: SpaceActor;
}): SessionState {
	const eventStateRef = useRef<EventState>(createEventState());
	const seenEventIdsRef = useRef<Set<string>>(new Set());
	const caughtUpRef = useRef(false);
	const bufferRef = useRef<SessionEvent[]>([]);
	const [sessionState, setSessionState] = useState<SessionState>({
		messages: [],
		isRunning: false,
	});

	const applyEvents = useCallback((events: SessionEvent[]) => {
		let lastResult: SessionState | null = null;

		for (const event of events) {
			if (seenEventIdsRef.current.has(event.id)) {
				continue;
			}
			seenEventIdsRef.current.add(event.id);

			lastResult = processEvent(event, eventStateRef.current);
		}

		if (lastResult) {
			setSessionState(lastResult);
		}
	}, []);

	useEffect(() => {
		if (!sessionId) {
			return;
		}
		eventStateRef.current = createEventState();
		seenEventIdsRef.current = new Set();
		caughtUpRef.current = false;
		bufferRef.current = [];
		setSessionState({ messages: [], isRunning: false });
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
			const events = await loadTranscriptEvents(
				conn,
				sessionId,
				() => isCancelled
			);
			if (isCancelled) {
				return;
			}
			sortSessionEvents(events);
			applyEvents(events);
			applyEvents(bufferRef.current);
			bufferRef.current = [];
			caughtUpRef.current = true;
		})().catch((error: unknown) => {
			if (isActorConnDisposedError(error)) {
				return;
			}
			console.error("Failed to initialize session stream", error);
		});

		return () => {
			isCancelled = true;
			conn.unsubscribeSession(sessionId).catch((error: unknown) => {
				if (isActorConnDisposedError(error)) {
					return;
				}
				console.error("Failed to unsubscribe session", error);
			});
		};
	}, [actor.connStatus, actor.connection, applyEvents, sessionId]);

	actor.useEvent("session.event", (event) => {
		const typed = event as SessionEvent;
		if (!caughtUpRef.current) {
			bufferRef.current.push(typed);
			return;
		}
		applyEvents([typed]);
	});

	return sessionState;
}
