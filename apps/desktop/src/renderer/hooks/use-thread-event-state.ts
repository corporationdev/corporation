import type { ThreadMessageLike } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionEvent } from "sandbox-agent";
import {
	type ConversationState,
	createConversationState,
	type PermissionCallback,
	processEvent,
} from "@/lib/convert-events";
import type { AgentActor } from "@/lib/rivet";

type ThreadState = {
	messages: ThreadMessageLike[];
	isRunning: boolean;
};

export function useThreadEventState({
	actor,
	onPermission,
}: {
	actor: AgentActor;
	onPermission: PermissionCallback;
}): ThreadState {
	const stateRef = useRef<ConversationState>(createConversationState());
	const lastIndexRef = useRef(-1);
	const caughtUpRef = useRef(false);
	const bufferRef = useRef<SessionEvent[]>([]);
	const [threadState, setThreadState] = useState<ThreadState>({
		messages: [],
		isRunning: false,
	});

	const applyEvents = useCallback(
		(events: SessionEvent[]) => {
			let result: ThreadState | null = null;

			for (const event of events) {
				if (event.eventIndex <= lastIndexRef.current) {
					continue;
				}
				result = processEvent(event, stateRef.current, onPermission);
				lastIndexRef.current = event.eventIndex;
			}

			if (result) {
				setThreadState(result);
			}
		},
		[onPermission]
	);

	// On connect, fetch all persisted events then flush buffered live events
	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		// Reset state for fresh connection
		stateRef.current = createConversationState();
		lastIndexRef.current = -1;
		caughtUpRef.current = false;
		bufferRef.current = [];

		(async () => {
			const allEvents: SessionEvent[] = [];
			let cursor: string | undefined;

			do {
				const page = await actor.connection?.getEvents(cursor);
				if (!page) {
					break;
				}
				allEvents.push(...(page.items as SessionEvent[]));
				cursor = page.nextCursor;
			} while (cursor);

			applyEvents(allEvents);
			applyEvents(bufferRef.current);
			bufferRef.current = [];
			caughtUpRef.current = true;
		})();
	}, [actor.connStatus, actor.connection, applyEvents]);

	// Live events — buffer during catch-up, process directly after
	actor.useEvent("session.event", (event) => {
		const typed = event as SessionEvent;
		if (!caughtUpRef.current) {
			bufferRef.current.push(typed);
			return;
		}
		applyEvents([typed]);
	});

	return threadState;
}
