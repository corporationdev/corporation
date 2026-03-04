import { and, asc, desc, eq, gt, lt, or } from "drizzle-orm";
import type {
	ListEventsRequest,
	ListPage,
	ListPageRequest,
	SessionEvent,
	SessionPersistDriver,
	SessionRecord,
} from "sandbox-agent";
import type { SpaceDatabase } from "../space/types";
import { sessionEvents, sessions } from "./schema";

type SessionPageSortDirection = "asc" | "desc";

type SessionPageCursor = {
	createdAt: number;
	id: string;
	direction: SessionPageSortDirection;
};

export class SqliteSessionPersistDriver implements SessionPersistDriver {
	private readonly db: SpaceDatabase;

	constructor(db: SpaceDatabase) {
		this.db = db;
	}

	async getSession(id: string): Promise<SessionRecord | null> {
		const rows = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, id))
			.limit(1);
		const row = rows[0];
		if (!row) {
			return null;
		}
		return this.toSessionRecord(row);
	}

	async listSessions(
		request?: ListPageRequest
	): Promise<ListPage<SessionRecord>> {
		const limit = request?.limit ?? 100;
		const cursor = this.parseSessionCursor(request?.cursor);
		const direction = cursor?.direction ?? "desc";
		const cursorCondition = cursor
			? this.buildSessionCursorCondition(cursor)
			: undefined;

		const rows = await this.db
			.select()
			.from(sessions)
			.where(cursorCondition)
			.orderBy(
				direction === "desc"
					? desc(sessions.createdAt)
					: asc(sessions.createdAt),
				direction === "desc" ? desc(sessions.id) : asc(sessions.id)
			)
			.limit(limit + 1);

		const hasMore = rows.length > limit;
		const items = (hasMore ? rows.slice(0, limit) : rows).map((r) =>
			this.toSessionRecord(r)
		);
		const lastItem = items.at(-1);
		return {
			items,
			nextCursor:
				hasMore && lastItem
					? this.toSessionCursor(lastItem, direction)
					: undefined,
		};
	}

	async updateSession(session: SessionRecord): Promise<void> {
		await this.db
			.insert(sessions)
			.values({
				id: session.id,
				agent: session.agent,
				agentSessionId: session.agentSessionId,
				lastConnectionId: session.lastConnectionId,
				createdAt: session.createdAt,
				destroyedAt: session.destroyedAt ?? null,
				sessionInit: session.sessionInit
					? (session.sessionInit as Record<string, unknown>)
					: null,
				modelId: null,
			})
			.onConflictDoUpdate({
				target: sessions.id,
				set: {
					agent: session.agent,
					agentSessionId: session.agentSessionId,
					lastConnectionId: session.lastConnectionId,
					destroyedAt: session.destroyedAt ?? null,
					sessionInit: session.sessionInit
						? (session.sessionInit as Record<string, unknown>)
						: null,
				},
			});
	}

	async listEvents(
		request: ListEventsRequest
	): Promise<ListPage<SessionEvent>> {
		const limit = request.limit ?? 100;
		const conditions = [eq(sessionEvents.sessionId, request.sessionId)];

		if (request.cursor) {
			conditions.push(gt(sessionEvents.eventIndex, Number(request.cursor)));
		}

		const rows = await this.db
			.select()
			.from(sessionEvents)
			.where(and(...conditions))
			.orderBy(asc(sessionEvents.eventIndex))
			.limit(limit + 1);

		const hasMore = rows.length > limit;
		const items = (hasMore ? rows.slice(0, limit) : rows).map((r) =>
			this.toSessionEvent(r)
		);
		const lastItem = items.at(-1);
		return {
			items,
			nextCursor: hasMore && lastItem ? String(lastItem.eventIndex) : undefined,
		};
	}

	async insertEvent(event: SessionEvent): Promise<void> {
		await this.db.insert(sessionEvents).values({
			id: event.id,
			eventIndex: event.eventIndex,
			sessionId: event.sessionId,
			createdAt: event.createdAt,
			connectionId: event.connectionId,
			sender: event.sender,
			payload: event.payload as Record<string, unknown>,
		});
	}

	async setModelId(sessionId: string, modelId: string): Promise<void> {
		await this.db
			.update(sessions)
			.set({ modelId })
			.where(eq(sessions.id, sessionId));
	}

	async getModelId(sessionId: string): Promise<string | null> {
		const rows = await this.db
			.select({ modelId: sessions.modelId })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1);
		return rows[0]?.modelId ?? null;
	}

	private toSessionRecord(row: typeof sessions.$inferSelect): SessionRecord {
		const record: SessionRecord = {
			id: row.id,
			agent: row.agent,
			agentSessionId: row.agentSessionId,
			lastConnectionId: row.lastConnectionId,
			createdAt: row.createdAt,
		};
		if (row.destroyedAt != null) {
			record.destroyedAt = row.destroyedAt;
		}
		if (row.sessionInit != null) {
			record.sessionInit = row.sessionInit as SessionRecord["sessionInit"];
		}
		return record;
	}

	private toSessionEvent(row: typeof sessionEvents.$inferSelect): SessionEvent {
		return {
			id: row.id,
			eventIndex: row.eventIndex,
			sessionId: row.sessionId,
			createdAt: row.createdAt,
			connectionId: row.connectionId,
			sender: row.sender as SessionEvent["sender"],
			payload: row.payload as SessionEvent["payload"],
		};
	}

	private parseSessionCursor(cursor?: string): SessionPageCursor | null {
		if (!cursor) {
			return null;
		}

		try {
			const parsed = JSON.parse(cursor) as Partial<SessionPageCursor>;
			if (
				(parsed.direction === "asc" || parsed.direction === "desc") &&
				typeof parsed.createdAt === "number" &&
				Number.isFinite(parsed.createdAt) &&
				typeof parsed.id === "string" &&
				parsed.id.length > 0
			) {
				return {
					createdAt: parsed.createdAt,
					id: parsed.id,
					direction: parsed.direction,
				};
			}
		} catch {
			// Legacy cursors were plain createdAt timestamps.
		}

		const legacyCreatedAt = Number(cursor);
		if (Number.isFinite(legacyCreatedAt)) {
			return {
				createdAt: legacyCreatedAt,
				id: "",
				direction: "desc",
			};
		}

		return null;
	}

	private buildSessionCursorCondition(cursor: SessionPageCursor) {
		if (cursor.direction === "desc") {
			if (!cursor.id) {
				return lt(sessions.createdAt, cursor.createdAt);
			}

			return or(
				lt(sessions.createdAt, cursor.createdAt),
				and(
					eq(sessions.createdAt, cursor.createdAt),
					lt(sessions.id, cursor.id)
				)
			);
		}

		return or(
			gt(sessions.createdAt, cursor.createdAt),
			and(eq(sessions.createdAt, cursor.createdAt), gt(sessions.id, cursor.id))
		);
	}

	private toSessionCursor(
		session: Pick<SessionRecord, "createdAt" | "id">,
		direction: SessionPageSortDirection
	): string {
		return JSON.stringify({
			createdAt: session.createdAt,
			id: session.id,
			direction,
		});
	}
}
