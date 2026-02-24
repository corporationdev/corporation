import type { InferSelectModel } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tabTypeValues = ["session", "terminal"] as const;
export type TabType = (typeof tabTypeValues)[number];

export const sessionStatusValues = [
	"running",
	"waiting",
	"stopped",
	"error",
] as const;
export type SessionStatus = (typeof sessionStatusValues)[number];

export const tabs = sqliteTable("tabs", {
	id: text("id").primaryKey(),
	type: text("type", { enum: tabTypeValues }).notNull(),
	title: text("title").notNull(),
	createdAt: integer("created_at", { mode: "number" }).notNull(),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	archivedAt: integer("archived_at", { mode: "number" }),
});

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	tabId: text("tab_id")
		.notNull()
		.unique()
		.references(() => tabs.id, { onDelete: "cascade" }),
	agent: text("agent").notNull().default("claude"),
	agentSessionId: text("agent_session_id"),
	lastConnectionId: text("last_connection_id"),
	sessionInitJson: text("session_init_json"),
	destroyedAt: integer("destroyed_at", { mode: "number" }),
	status: text("status", { enum: sessionStatusValues }).notNull(),
	createdAt: integer("created_at", { mode: "number" }).notNull(),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const terminals = sqliteTable("terminals", {
	id: text("id").primaryKey(),
	tabId: text("tab_id")
		.notNull()
		.unique()
		.references(() => tabs.id, { onDelete: "cascade" }),
	ptySessionId: text("pty_session_id"),
	cols: integer("cols").notNull(),
	rows: integer("rows").notNull(),
	scrollbackBlob: text("scrollback_blob"),
	createdAt: integer("created_at", { mode: "number" }).notNull(),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export type TabRow = InferSelectModel<typeof tabs>;
export type SessionRow = InferSelectModel<typeof sessions>;
export type TerminalRow = InferSelectModel<typeof terminals>;

type SharedTabFields = Pick<
	TabRow,
	"id" | "title" | "createdAt" | "updatedAt" | "archivedAt"
>;

export type SessionTab = SharedTabFields & {
	type: "session";
	sessionId: SessionRow["id"];
	status: SessionRow["status"];
};

export type TerminalTab = SharedTabFields & {
	type: "terminal";
	terminalId: TerminalRow["id"];
	cols: TerminalRow["cols"];
	rows: TerminalRow["rows"];
};

export type SpaceTab = SessionTab | TerminalTab;
