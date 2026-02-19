import {
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

export const sessionEvents = sqliteTable(
	"session_events",
	{
		sessionId: text("session_id").notNull(),
		sequence: integer("sequence").notNull(),
		eventType: text("event_type").notNull(),
		eventJson: text("event_json").notNull(),
	},
	(table) => [primaryKey({ columns: [table.sessionId, table.sequence] })]
);

export const dbSchema = {
	sessionEvents,
} as const;

export type SessionEventRow = typeof sessionEvents.$inferSelect;
