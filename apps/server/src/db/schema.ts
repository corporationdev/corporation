import type { InferSelectModel } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tabTypeValues = ["session", "terminal"] as const;
export type TabType = (typeof tabTypeValues)[number];

export const tabs = sqliteTable("tabs", {
	id: text("id").primaryKey(),
	type: text("type", { enum: tabTypeValues }).notNull(),
	title: text("title").notNull(),
	sessionId: text("session_id"),
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
	ptySessionId: text("pty_session_id"),
	cols: integer("cols").notNull(),
	rows: integer("rows").notNull(),
	scrollbackBlob: text("scrollback_blob"),
	createdAt: integer("created_at", { mode: "number" }).notNull(),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export type TabRow = InferSelectModel<typeof tabs>;
export type TerminalRow = InferSelectModel<typeof terminals>;

type SharedTabFields = Pick<
	TabRow,
	"id" | "title" | "createdAt" | "updatedAt" | "archivedAt"
>;

export type SessionTab = SharedTabFields & {
	type: "session";
	sessionId: string;
	agent: string | null;
};

export type TerminalTab = SharedTabFields & {
	type: "terminal";
	terminalId: TerminalRow["id"];
	cols: TerminalRow["cols"];
	rows: TerminalRow["rows"];
};

export type SpaceTab = SessionTab | TerminalTab;
