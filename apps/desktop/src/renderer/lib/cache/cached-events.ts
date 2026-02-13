import type { UniversalEvent } from "sandbox-agent";
import type { CachedEventRecord } from "../../../shared/ipc-api";

function toCachedEventRecord(
	slug: string,
	event: UniversalEvent
): CachedEventRecord {
	return {
		sessionId: slug,
		sequence: event.sequence,
		eventType: event.type,
		eventJson: JSON.stringify(event),
	};
}

export async function getCachedEvents(slug: string): Promise<UniversalEvent[]> {
	const rows = await window.localCache.events.getForSession(slug);
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
	slug: string,
	events: UniversalEvent[]
): Promise<void> {
	if (events.length === 0) {
		return;
	}
	await window.localCache.events.appendMany(
		events.map((event) => toCachedEventRecord(slug, event))
	);
}
