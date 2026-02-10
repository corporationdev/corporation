import { desc, eq } from "drizzle-orm";
import type {
	AgentSessionRecord,
	CachedEventRecord,
} from "../../shared/ipc-api";
import type { AppDb } from "./index";
import { agentSessions, sessionEvents } from "./schema";

export function getAllSessions(db: AppDb): AgentSessionRecord[] {
	const rows = db.orm
		.select()
		.from(agentSessions)
		.orderBy(desc(agentSessions.updatedAt))
		.all();

	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		userId: row.userId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		archivedAt: row.archivedAt ?? null,
	}));
}

export function replaceAllSessions(
	db: AppDb,
	sessions: AgentSessionRecord[]
): void {
	db.orm.transaction((tx) => {
		tx.delete(agentSessions).run();
		if (sessions.length === 0) {
			return;
		}
		tx.insert(agentSessions)
			.values(
				sessions.map((session) => ({
					id: session.id,
					title: session.title,
					userId: session.userId,
					createdAt: session.createdAt,
					updatedAt: session.updatedAt,
					archivedAt: session.archivedAt,
				}))
			)
			.run();
	});
}

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
