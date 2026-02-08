import { useCallback, useRef } from "react";
import type { UniversalEvent } from "sandbox-agent";

import type { CachedEvent } from "../../../shared/ipc-api";

export function useCachedEvents(threadId: string) {
	const isNew = threadId === "new";

	const cachedEvents = useRef<UniversalEvent[]>(
		isNew
			? []
			: window.localCache.events
					.getForSession(threadId)
					.map((e) => JSON.parse(e.data) as UniversalEvent)
	);

	const lastPersistedSequence = useRef<number>(
		cachedEvents.current.at(-1)?.sequence ?? 0
	);

	const persistNewEvents = useCallback(
		(allEvents: UniversalEvent[]) => {
			if (isNew) {
				return;
			}

			const newEvents = allEvents.filter(
				(e) => e.sequence > lastPersistedSequence.current
			);
			if (newEvents.length === 0) {
				return;
			}

			const toPersist: CachedEvent[] = newEvents.map((e) => ({
				sessionId: threadId,
				sequence: e.sequence,
				eventType: e.type,
				data: JSON.stringify(e),
			}));

			window.localCache.events.appendMany(toPersist);
			lastPersistedSequence.current =
				allEvents.at(-1)?.sequence ?? lastPersistedSequence.current;
		},
		[threadId, isNew]
	);

	return { cachedEvents: cachedEvents.current, persistNewEvents };
}
