import path from "node:path";
import Database from "better-sqlite3";
import {
	type BetterSQLite3Database,
	drizzle,
} from "drizzle-orm/better-sqlite3";
import { app } from "electron";
import { dbSchema } from "./schema";

type AppDb = {
	sqlite: Database.Database;
	orm: BetterSQLite3Database<typeof dbSchema>;
};

let db: AppDb | null = null;

function createDb(): AppDb {
	const dbPath = path.join(app.getPath("userData"), "local-cache.db");
	const sqlite = new Database(dbPath);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("synchronous = NORMAL");
	const orm = drizzle(sqlite, { schema: dbSchema });
	return { sqlite, orm };
}

export function getDb(): AppDb {
	if (!db) {
		db = createDb();
	}
	return db;
}

export type { AppDb };
