import type { InferSelectModel } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const runtimeCommandStatusValues = [
	"accepted",
	"completed",
	"failed",
] as const;
export type RuntimeCommandStatus =
	(typeof runtimeCommandStatusValues)[number];

export const runtimeEventLog = sqliteTable(
	"runtime_event_log",
	{
		id: text("id").primaryKey(),
		streamKey: text("stream_key").notNull(),
		sequence: integer("sequence").notNull(),
		sessionId: text("session_id"),
		turnId: text("turn_id"),
		commandId: text("command_id"),
		eventType: text("event_type").notNull(),
		payload: text("payload", { mode: "json" })
			.notNull()
			.$type<Record<string, unknown>>(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("runtime_event_log_stream_sequence_unique").on(
			table.streamKey,
			table.sequence
		),
		index("runtime_event_log_stream_created_at_idx").on(
			table.streamKey,
			table.createdAt
		),
		index("runtime_event_log_command_id_idx").on(table.commandId),
	]
);

export const runtimeCommandReceipts = sqliteTable(
	"runtime_command_receipts",
	{
		commandId: text("command_id").primaryKey(),
		streamKey: text("stream_key").notNull(),
		commandType: text("command_type").notNull(),
		status: text("status", { enum: runtimeCommandStatusValues })
			.notNull()
			.default("accepted"),
		input: text("input", { mode: "json" })
			.notNull()
			.$type<Record<string, unknown>>(),
		result: text("result", { mode: "json" }).$type<
			Record<string, unknown> | null
		>(),
		error: text("error"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		index("runtime_command_receipts_stream_status_idx").on(
			table.streamKey,
			table.status
		),
		index("runtime_command_receipts_stream_created_at_idx").on(
			table.streamKey,
			table.createdAt
		),
	]
);

export type RuntimeEventLogRow = InferSelectModel<typeof runtimeEventLog>;
export type RuntimeCommandReceiptRow = InferSelectModel<
	typeof runtimeCommandReceipts
>;

export const schema = {
	runtimeEventLog,
	runtimeCommandReceipts,
};
