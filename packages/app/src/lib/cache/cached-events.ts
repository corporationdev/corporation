import type { UniversalEvent } from "sandbox-agent";
import type { CacheAdapter, CachedEventRecord } from "./adapter";

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

export async function getCachedEvents(
	cache: CacheAdapter,
	slug: string
): Promise<UniversalEvent[]> {
	const rows = await cache.events.getForSession(slug);
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
	cache: CacheAdapter,
	slug: string,
	events: UniversalEvent[]
): Promise<void> {
	if (events.length === 0) {
		return;
	}
	await cache.events.appendMany(
		events.map((event) => toCachedEventRecord(slug, event))
	);
}
