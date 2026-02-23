import type { ThreadMessageLike } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UniversalEvent } from "sandbox-agent";
import { type ItemState, processEvent } from "@/lib/convert-events";
import type { SpaceActor } from "@/lib/rivetkit";

type SessionState = {
	messages: ThreadMessageLike[];
	isRunning: boolean;
};

export function useSessionEventState({
	sessionId,
	actor,
}: {
	sessionId: string;
	actor: SpaceActor;
}): SessionState {
	const itemStatesRef = useRef(new Map<string, ItemState>());
	const lastSequenceRef = useRef(0);
	const caughtUpRef = useRef(false);
	const bufferRef = useRef<UniversalEvent[]>([]);
	const [sessionState, setSessionState] = useState<SessionState>({
		messages: [],
		isRunning: false,
	});

	const applyEvents = useCallback((events: UniversalEvent[]) => {
		let lastResult: SessionState | null = null;

		for (const event of events) {
			if (event.sequence <= lastSequenceRef.current) {
				continue;
			}

			lastResult = processEvent(event, itemStatesRef.current);
			lastSequenceRef.current = event.sequence;
		}

		if (lastResult) {
			setSessionState(lastResult);
		}
	}, []);

	useEffect(() => {
		if (!sessionId) {
			return;
		}
		itemStatesRef.current = new Map();
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
			console.error("Failed to initialize session stream", error);
		});

		return () => {
			isCancelled = true;
			actor.connection
				?.unsubscribeSession(sessionId)
				.catch((error: unknown) => {
					console.error("Failed to unsubscribe session", error);
				});
		};
	}, [actor.connStatus, actor.connection, applyEvents, sessionId]);

	actor.useEvent("session.event", (event) => {
		const typed = event as UniversalEvent;
		if (!caughtUpRef.current) {
			bufferRef.current.push(typed);
			return;
		}
		applyEvents([typed]);
	});

	return sessionState;
}
