import type { ThreadMessageLike } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionEventData, UniversalEvent } from "sandbox-agent";
import { type ItemState, processEvent } from "@/lib/convert-events";

type ThreadState = {
	messages: ThreadMessageLike[];
	isRunning: boolean;
};

type OnPermissionEvent = (
	type: "permission.requested" | "permission.resolved",
	data: PermissionEventData
) => void;

type ThreadEventActor = {
	connStatus: string;
	connection:
		| {
				getTranscript: (offset: number) => Promise<unknown[]>;
		  }
		| null
		| undefined;
	useEvent: (eventName: "agentEvent", cb: (event: unknown) => void) => void;
};

export function useThreadEventState({
	actor,
	onPermissionEvent,
}: {
	slug: string;
	actor: ThreadEventActor;
	onPermissionEvent: OnPermissionEvent;
}): ThreadState {
	const itemStatesRef = useRef(new Map<string, ItemState>());
	const lastSequenceRef = useRef(0);
	const caughtUpRef = useRef(false);
	const bufferRef = useRef<UniversalEvent[]>([]);
	const [threadState, setThreadState] = useState<ThreadState>({
		messages: [],
		isRunning: false,
	});

	const applyEvents = useCallback(
		(events: UniversalEvent[]) => {
			let lastResult: ThreadState | null = null;

			for (const event of events) {
				if (event.sequence <= lastSequenceRef.current) {
					continue;
				}

				lastResult = processEvent(
					event,
					itemStatesRef.current,
					onPermissionEvent
				);
				lastSequenceRef.current = event.sequence;
			}

			if (lastResult) {
				setThreadState(lastResult);
			}
		},
		[onPermissionEvent]
	);

	// On connect, fetch all events then flush any buffered real-time events
	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		caughtUpRef.current = false;
		bufferRef.current = [];

		actor.connection.getTranscript(0).then((events) => {
			applyEvents(events as UniversalEvent[]);
			applyEvents(bufferRef.current);
			bufferRef.current = [];
			caughtUpRef.current = true;
		});
	}, [actor.connStatus, actor.connection, applyEvents]);

	// Real-time events — buffer during catch-up, process directly after
	actor.useEvent("agentEvent", (event) => {
		const typed = event as UniversalEvent;
		if (!caughtUpRef.current) {
			bufferRef.current.push(typed);
			return;
		}
		applyEvents([typed]);
	});

	return threadState;
}
