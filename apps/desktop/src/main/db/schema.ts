import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agentSessions = sqliteTable("agent_sessions", {
	id: text("id").primaryKey(),
	title: text("title").notNull(),
	userId: text("user_id").notNull(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
	archivedAt: integer("archived_at"),
});

export const sessionEvents = sqliteTable(
	"session_events",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		sessionId: text("session_id").notNull(),
		sequence: integer("sequence").notNull(),
		eventType: text("event_type").notNull(),
		data: text("data").notNull(),
	},
	(table) => [index("idx_session_sequence").on(table.sessionId, table.sequence)]
);
