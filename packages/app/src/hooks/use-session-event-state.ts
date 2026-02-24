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

export function useSessionEventState({
	sessionId,
	actor,
}: {
	sessionId: string;
	actor: SpaceActor;
}): SessionState {
	const eventStateRef = useRef<EventState>(createEventState());
	const lastSequenceRef = useRef(0);
	const caughtUpRef = useRef(false);
	const bufferRef = useRef<SessionEvent[]>([]);
	const [sessionState, setSessionState] = useState<SessionState>({
		messages: [],
		isRunning: false,
	});

	const applyEvents = useCallback((events: SessionEvent[]) => {
		let lastResult: SessionState | null = null;

		for (const event of events) {
			if (event.eventIndex <= lastSequenceRef.current) {
				continue;
			}

			lastResult = processEvent(event, eventStateRef.current);
			lastSequenceRef.current = event.eventIndex;
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
		lastSequenceRef.current = 0;
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
			const events = await conn.getTranscript(sessionId, 0);
			if (isCancelled) {
				return;
			}
			applyEvents(await events);
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
