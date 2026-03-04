import type { InferSelectModel } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tabTypeValues = ["session", "terminal", "preview"] as const;
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

export const previews = sqliteTable("previews", {
	id: text("id").primaryKey(),
	tabId: text("tab_id")
		.notNull()
		.unique()
		.references(() => tabs.id, { onDelete: "cascade" }),
	url: text("url").notNull(),
	port: integer("port").notNull(),
	createdAt: integer("created_at", { mode: "number" }).notNull(),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const runStatusValues = [
	"idle",
	"running",
	"completed",
	"failed",
] as const;
export type RunStatus = (typeof runStatusValues)[number];

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
	runStatus: text("run_status", { enum: runStatusValues })
		.notNull()
		.default("idle"),
	runStartedAt: integer("run_started_at", { mode: "number" }),
	runCompletedAt: integer("run_completed_at", { mode: "number" }),
	lastEventAt: integer("last_event_at", { mode: "number" }),
	callbackToken: text("callback_token"),
	runStopReason: text("run_stop_reason"),
	runError: text("run_error", { mode: "json" }),
});

export const sessionEvents = sqliteTable("session_events", {
	id: text("id").primaryKey(),
	eventIndex: integer("event_index").notNull(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id, { onDelete: "cascade" }),
	createdAt: integer("created_at", { mode: "number" }).notNull(),
	connectionId: text("connection_id").notNull(),
	sender: text("sender").notNull(),
	payload: text("payload", { mode: "json" }).notNull(),
});

export type TabRow = InferSelectModel<typeof tabs>;
export type TerminalRow = InferSelectModel<typeof terminals>;
export type PreviewRow = InferSelectModel<typeof previews>;
export type SessionRow = InferSelectModel<typeof sessions>;
export type SessionEventRow = InferSelectModel<typeof sessionEvents>;

type SharedTabFields = Pick<
	TabRow,
	"id" | "title" | "active" | "createdAt" | "updatedAt" | "archivedAt"
>;

export type SessionTab = SharedTabFields & {
	type: "session";
	sessionId: string;
	agent: string | null;
	modelId: string | null;
};

export type TerminalTab = SharedTabFields & {
	type: "terminal";
	terminalId: TerminalRow["id"];
	cols: TerminalRow["cols"];
	rows: TerminalRow["rows"];
};

export type PreviewTab = SharedTabFields & {
	type: "preview";
	previewId: string;
	url: string;
	port: number;
};

export type SpaceTab = SessionTab | TerminalTab | PreviewTab;

export const schema = {
	tabs,
	terminals,
	previews,
	sessions,
	sessionEvents,
};
