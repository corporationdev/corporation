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

export type TabRow = InferSelectModel<typeof tabs>;
export type TerminalRow = InferSelectModel<typeof terminals>;
export type PreviewRow = InferSelectModel<typeof previews>;

type SharedTabFields = Pick<
	TabRow,
	"id" | "title" | "active" | "createdAt" | "updatedAt" | "archivedAt"
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

export type PreviewTab = SharedTabFields & {
	type: "preview";
	previewId: string;
	url: string;
	port: number;
};

export type SpaceTab = SessionTab | TerminalTab | PreviewTab;
