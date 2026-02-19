import { eq } from "drizzle-orm";
import type { CachedEventRecord } from "../../shared/ipc-api";
import type { AppDb } from "./index";
import { sessionEvents } from "./schema";

export function getEventsForSession(
	db: AppDb,
	sessionId: string
): CachedEventRecord[] {
	const rows = db.orm
		.select()
		.from(sessionEvents)
		.where(eq(sessionEvents.sessionId, sessionId))
		.orderBy(sessionEvents.sequence)
		.all();

	return rows.map((row) => ({
		sessionId: row.sessionId,
		sequence: row.sequence,
		eventType: row.eventType,
		eventJson: row.eventJson,
	}));
}

export function appendManyEvents(db: AppDb, events: CachedEventRecord[]): void {
	if (events.length === 0) {
		return;
	}

	db.orm
		.insert(sessionEvents)
		.values(
			events.map((event) => ({
				sessionId: event.sessionId,
				sequence: event.sequence,
				eventType: event.eventType,
				eventJson: event.eventJson,
			}))
		)
		.onConflictDoNothing()
		.run();
}
