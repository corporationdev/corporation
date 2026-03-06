import type { InferSelectModel } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tabTypeValues = ["session", "terminal"] as const;
export type TabType = (typeof tabTypeValues)[number];

export const tabs = sqliteTable("tabs", {
	id: text("id").primaryKey(),
	type: text("type", { enum: tabTypeValues }).notNull(),
	title: text("title").notNull(),
	sessionId: text("session_id"),
	active: integer("active", { mode: "boolean" }).notNull().default(true),
	createdAt: integer("created_at", { mode: "number" }).notNull(),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	archivedAt: integer("archived_at", { mode: "number" }),
});

export const terminals = sqliteTable("terminals", {
	id: text("id").primaryKey(),
	tabId: text("tab_id")
		.notNull()
		.unique()
		.references(() => tabs.id, { onDelete: "cascade" }),
	ptyPid: integer("pty_pid"),
	cols: integer("cols").notNull(),
	rows: integer("rows").notNull(),
	createdAt: integer("created_at", { mode: "number" }).notNull(),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const sessionStatusValues = ["idle", "running", "error"] as const;
export type SessionStatus = (typeof sessionStatusValues)[number];

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	agent: text("agent").notNull(),
	agentSessionId: text("agent_session_id").notNull(),
	lastConnectionId: text("last_connection_id").notNull(),
	createdAt: integer("created_at", { mode: "number" }).notNull(),
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

export type TabRow = InferSelectModel<typeof tabs>;
export type TerminalRow = InferSelectModel<typeof terminals>;
export type SessionRow = InferSelectModel<typeof sessions>;
export type SessionEventRow = InferSelectModel<typeof sessionEvents>;

type SharedTabFields = Pick<
	TabRow,
	"id" | "title" | "active" | "createdAt" | "updatedAt" | "archivedAt"
>;

export type SessionTab = SharedTabFields & {
	type: "session";
	sessionId: string;
};

export type TerminalTab = SharedTabFields & {
	type: "terminal";
	terminalId: TerminalRow["id"];
};

export type SpaceTab = SessionTab | TerminalTab;

export const schema = {
	tabs,
	terminals,
	sessions,
	sessionEvents,
};
