import { and, eq } from "drizzle-orm";

import type { AgentSession, CachedEvent } from "../../shared/ipc-api";
import type { AppDb } from "./index";
import { agentSessions, sessionEvents } from "./schema";

// --- Sessions ---

export function getAllSessions(db: AppDb): AgentSession[] {
	const rows = db.select().from(agentSessions).all();
	return rows.map(rowToSession);
}

export function getSessionById(db: AppDb, id: string): AgentSession | null {
	const row = db
		.select()
		.from(agentSessions)
		.where(eq(agentSessions.id, id))
		.get();
	return row ? rowToSession(row) : null;
}

export function replaceAllSessions(db: AppDb, sessions: AgentSession[]): void {
	db.transaction((tx) => {
		tx.delete(agentSessions).run();
		for (const session of sessions) {
			tx.insert(agentSessions).values(sessionToRow(session)).run();
		}
	});
}

export function upsertSession(db: AppDb, session: AgentSession): void {
	db.insert(agentSessions)
		.values(sessionToRow(session))
		.onConflictDoUpdate({
			target: agentSessions.id,
			set: sessionToRow(session),
		})
		.run();
}

// --- Events ---

export function getEventsForSession(
	db: AppDb,
	sessionId: string
): CachedEvent[] {
	return db
		.select()
		.from(sessionEvents)
		.where(eq(sessionEvents.sessionId, sessionId))
		.orderBy(sessionEvents.sequence)
		.all();
}

export function appendManyEvents(db: AppDb, events: CachedEvent[]): void {
	if (events.length === 0) {
		return;
	}

	db.transaction((tx) => {
		for (const event of events) {
			const exists = tx
				.select({ id: sessionEvents.id })
				.from(sessionEvents)
				.where(
					and(
						eq(sessionEvents.sessionId, event.sessionId),
						eq(sessionEvents.sequence, event.sequence)
					)
				)
				.get();

			if (!exists) {
				tx.insert(sessionEvents)
					.values({
						sessionId: event.sessionId,
						sequence: event.sequence,
						eventType: event.eventType,
						data: event.data,
					})
					.run();
			}
		}
	});
}

export function deleteEventsForSession(db: AppDb, sessionId: string): void {
	db.delete(sessionEvents).where(eq(sessionEvents.sessionId, sessionId)).run();
}

// --- Row mappers ---

function rowToSession(row: typeof agentSessions.$inferSelect): AgentSession {
	return {
		id: row.id,
		title: row.title,
		userId: row.userId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		archivedAt: row.archivedAt ?? null,
	};
}

function sessionToRow(session: AgentSession) {
	return {
		id: session.id,
		title: session.title,
		userId: session.userId,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		archivedAt: session.archivedAt,
	};
}
