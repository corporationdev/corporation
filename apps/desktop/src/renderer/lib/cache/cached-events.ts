import type { UniversalEvent } from "sandbox-agent";
import type { CachedEventRecord } from "../../../shared/ipc-api";

function toCachedEventRecord(
	sessionId: string,
	event: UniversalEvent
): CachedEventRecord {
	return {
		sessionId,
		sequence: event.sequence,
		eventType: event.type,
		eventJson: JSON.stringify(event),
	};
}

export async function getCachedEvents(
	sessionId: string
): Promise<UniversalEvent[]> {
	const rows = await window.localCache.events.getForSession(sessionId);
	const parsedEvents: UniversalEvent[] = [];

	for (const row of rows) {
		try {
			// todo: zod parse here
			parsedEvents.push(JSON.parse(row.eventJson) as UniversalEvent);
		} catch {
			// Ignore malformed cached rows and continue replaying the rest.
		}
	}

	return parsedEvents.sort((a, b) => a.sequence - b.sequence);
}

export async function appendEventsToCache(
	sessionId: string,
	events: UniversalEvent[]
): Promise<void> {
	if (events.length === 0) {
		return;
	}
	await window.localCache.events.appendMany(
		events.map((event) => toCachedEventRecord(sessionId, event))
	);
}
