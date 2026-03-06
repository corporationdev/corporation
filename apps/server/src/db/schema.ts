import type { InferSelectModel } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionStatusValues = ["idle", "running", "error"] as const;
export type SessionStatus = (typeof sessionStatusValues)[number];

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	title: text("title").notNull().default("New Chat"),
	active: integer("active", { mode: "boolean" }).notNull().default(true),
	archivedAt: integer("archived_at", { mode: "number" }),
	agent: text("agent").notNull(),
	agentSessionId: text("agent_session_id").notNull(),
	lastConnectionId: text("last_connection_id").notNull(),
	createdAt: integer("created_at", { mode: "number" }).notNull(),
	updatedAt: integer("updated_at", { mode: "number" }).notNull().default(0),
	destroyedAt: integer("destroyed_at", { mode: "number" }),
	sessionInit: text("session_init", { mode: "json" }),
	modelId: text("model_id"),
	runId: text("run_id"),
	pid: integer("pid"),
	status: text("status", { enum: sessionStatusValues })
		.notNull()
		.default("idle"),
	callbackToken: text("callback_token"),
	error: text("error", { mode: "json" }),
});

export const sessionEvents = sqliteTable("session_events", {
	id: text("id").primaryKey(),
	eventIndex: integer("event_index").notNull(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id, { onDelete: "cascade" }),
	createdAt: integer("created_at", { mode: "number" }).notNull(),
	connectionId: text("connection_id").notNull(),
	sender: text("sender").notNull().$type<"client" | "agent">(),
	payload: text("payload", { mode: "json" })
		.notNull()
		.$type<Record<string, unknown>>(),
});

export type SessionRow = InferSelectModel<typeof sessions>;
export type SessionEventRow = InferSelectModel<typeof sessionEvents>;

export const schema = {
	sessions,
	sessionEvents,
};
