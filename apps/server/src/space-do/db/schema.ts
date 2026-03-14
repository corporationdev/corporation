import type { InferSelectModel } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		clientId: text("environment_id").notNull(),
		streamKey: text("stream_key").notNull(),
		title: text("title").notNull().default("New Chat"),
		agent: text("agent").notNull(),
		cwd: text("cwd").notNull(),
		model: text("model"),
		mode: text("mode"),
		configOptions: text("config_options", { mode: "json" }).$type<Record<
			string,
			string
		> | null>(),
		lastAppliedOffset: text("last_applied_offset").notNull().default("-1"),
		lastEventAt: integer("last_event_at", { mode: "number" }),
		lastSyncError: text("last_sync_error"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
		archivedAt: integer("archived_at", { mode: "number" }),
	},
	(table) => [
		uniqueIndex("sessions_stream_key_unique").on(table.streamKey),
		index("sessions_environment_id_updated_at_idx").on(
			table.clientId,
			table.updatedAt
		),
	]
);

export const runtimeEvents = sqliteTable(
	"runtime_events",
	{
		eventId: text("event_id").primaryKey(),
		streamKey: text("stream_key").notNull(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		offset: text("offset").notNull(),
		offsetSeq: integer("offset_seq").notNull(),
		commandId: text("command_id"),
		turnId: text("turn_id"),
		eventType: text("event_type").notNull(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		payload: text("payload", { mode: "json" })
			.notNull()
			.$type<Record<string, unknown>>(),
	},
	(table) => [
		uniqueIndex("runtime_events_stream_offset_unique").on(
			table.streamKey,
			table.offset
		),
		index("runtime_events_session_offset_seq_idx").on(
			table.sessionId,
			table.offsetSeq
		),
		index("runtime_events_stream_created_at_idx").on(
			table.streamKey,
			table.createdAt
		),
		index("runtime_events_command_id_idx").on(table.commandId),
	]
);

export type SpaceSessionRow = InferSelectModel<typeof sessions>;
export type RuntimeEventRow = InferSelectModel<typeof runtimeEvents>;

export const schema = {
	sessions,
	runtimeEvents,
};
