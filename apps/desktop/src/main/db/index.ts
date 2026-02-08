import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { app } from "electron";
import { agentSessions, sessionEvents } from "./schema";

let db: ReturnType<typeof createDb> | null = null;

function createDb() {
	const dbPath = path.join(app.getPath("userData"), "local-cache.db");
	const sqlite = new Database(dbPath);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("synchronous = NORMAL");
	return drizzle(sqlite, { schema: { agentSessions, sessionEvents } });
}

export function getDb() {
	if (!db) {
		db = createDb();
	}
	return db;
}

export type AppDb = ReturnType<typeof getDb>;
