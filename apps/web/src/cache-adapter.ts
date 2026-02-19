import type {
	CacheAdapter,
	CachedEventRecord,
} from "@corporation/app/cache-adapter";
import { cacheSchema, sessionEvents } from "@corporation/app/cache-schema";
import { eq } from "drizzle-orm";
import { drizzle, type SqlJsDatabase } from "drizzle-orm/sql-js";
import initSqlJs from "sql.js";

let dbPromise: Promise<SqlJsDatabase<typeof cacheSchema>> | null = null;

function getDb(): Promise<SqlJsDatabase<typeof cacheSchema>> {
	if (!dbPromise) {
		dbPromise = initSqlJs().then((SQL) => {
			const sqlite = new SQL.Database();
			sqlite.run(`
				CREATE TABLE IF NOT EXISTS session_events (
					session_id TEXT NOT NULL,
					sequence INTEGER NOT NULL,
					event_type TEXT NOT NULL,
					event_json TEXT NOT NULL,
					PRIMARY KEY (session_id, sequence)
				)
			`);
			return drizzle(sqlite, { schema: cacheSchema });
		});
	}
	return dbPromise;
}

export const webCacheAdapter: CacheAdapter = {
	events: {
		getForSession: async (sessionId): Promise<CachedEventRecord[]> => {
			const db = await getDb();
			return db
				.select()
				.from(sessionEvents)
				.where(eq(sessionEvents.sessionId, sessionId))
				.orderBy(sessionEvents.sequence)
				.all();
		},
		appendMany: async (events): Promise<void> => {
			if (events.length === 0) {
				return;
			}
			const db = await getDb();
			db.insert(sessionEvents)
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
		},
	},
};
