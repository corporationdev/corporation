import { sql } from "drizzle-orm";

import type { AppDb } from "./index";

export function migrate(db: AppDb) {
	db.run(sql`
		CREATE TABLE IF NOT EXISTS agent_sessions (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			user_id TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			archived_at INTEGER
		)
	`);

	db.run(sql`
		CREATE TABLE IF NOT EXISTS session_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			sequence INTEGER NOT NULL,
			event_type TEXT NOT NULL,
			data TEXT NOT NULL
		)
	`);

	db.run(sql`
		CREATE INDEX IF NOT EXISTS idx_session_sequence
		ON session_events (session_id, sequence)
	`);
}
