import type { ThreadMessageLike } from "@assistant-ui/react";
import { useQuery as useTanstackQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionEventData, UniversalEvent } from "sandbox-agent";
import {
	appendEventsToCache,
	getCachedEvents,
} from "@/lib/cache/cached-events";
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
	threadId,
	actor,
	onPermissionEvent,
}: {
	threadId: string;
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
		(events: UniversalEvent[], persist: boolean) => {
			const newEvents: UniversalEvent[] = [];
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
				newEvents.push(event);
			}

			if (lastResult) {
				setThreadState(lastResult);
			}

			if (persist && newEvents.length > 0) {
				appendEventsToCache(threadId, newEvents).catch(() => {
					// Ignore write failures; cache will be refreshed on next transcript sync.
				});
			}
		},
		[onPermissionEvent, threadId]
	);

	const cachedEventsQuery = useTanstackQuery({
		queryKey: ["thread-events-cache", threadId] as const,
		queryFn: async () => await getCachedEvents(threadId),
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
	});

	useEffect(() => {
		if (!cachedEventsQuery.data) {
			return;
		}
		applyEvents(cachedEventsQuery.data, false);
	}, [applyEvents, cachedEventsQuery.data]);

	// On connect, fetch missed events then flush any buffered real-time events
	useEffect(() => {
		if (
			!cachedEventsQuery.isFetched ||
			actor.connStatus !== "connected" ||
			!actor.connection
		) {
			return;
		}

		caughtUpRef.current = false;
		bufferRef.current = [];

		actor.connection
			.getTranscript(lastSequenceRef.current)
			.then((missedEvents) => {
				applyEvents(missedEvents as UniversalEvent[], true);
				// Flush buffered real-time events, skipping duplicates
				applyEvents(bufferRef.current, true);
				bufferRef.current = [];
				caughtUpRef.current = true;
			});
	}, [
		actor.connStatus,
		actor.connection,
		applyEvents,
		cachedEventsQuery.isFetched,
	]);

	// Real-time events — buffer during catch-up, process directly after
	actor.useEvent("agentEvent", (event) => {
		const typed = event as UniversalEvent;
		if (!caughtUpRef.current) {
			bufferRef.current.push(typed);
			return;
		}
		applyEvents([typed], true);
	});

	return threadState;
}
