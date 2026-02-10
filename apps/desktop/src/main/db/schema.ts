import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

export const agentSessions = sqliteTable(
	"agent_sessions",
	{
		id: text("id").primaryKey(),
		title: text("title").notNull(),
		userId: text("user_id").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		archivedAt: integer("archived_at"),
	},
	(table) => [index("idx_agent_sessions_updated_at").on(table.updatedAt)]
);

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
	agentSessions,
	sessionEvents,
} as const;

export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type SessionEventRow = typeof sessionEvents.$inferSelect;
