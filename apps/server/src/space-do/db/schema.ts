import type { SessionStreamFrameData } from "@corporation/contracts/client-do";
import type { InferSelectModel } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sessionStatusValues = ["idle", "running", "error"] as const;
export type SessionStatus = (typeof sessionStatusValues)[number];
export const sessionStreamFrameKindValues = [
	"event",
	"status_changed",
] as const;
export type SessionStreamFrameKind =
	(typeof sessionStreamFrameKindValues)[number];

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	title: text("title").notNull().default("New Chat"),
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
	lastStreamOffset: integer("last_stream_offset").notNull().default(0),
	callbackToken: text("callback_token"),
	error: text("error", { mode: "json" }),
});

export const spaceMetadata = sqliteTable("space_metadata", {
	id: integer("id").primaryKey(),
	sandboxId: text("sandbox_id"),
	agentUrl: text("agent_url"),
});

export const sessionStreamFrames = sqliteTable(
	"session_stream_frames",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		offset: integer("offset").notNull(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		kind: text("kind", { enum: sessionStreamFrameKindValues }).notNull(),
		eventId: text("event_id"),
		data: text("data", { mode: "json" })
			.notNull()
			.$type<SessionStreamFrameData>(),
	},
	(table) => [
		uniqueIndex("session_stream_frames_session_offset_idx").on(
			table.sessionId,
			table.offset
		),
		uniqueIndex("session_stream_frames_session_event_id_unique").on(
			table.sessionId,
			table.eventId
		),
		index("session_stream_frames_session_kind_offset_idx").on(
			table.sessionId,
			table.kind,
			table.offset
		),
	]
);

export type SessionRow = InferSelectModel<typeof sessions>;
export type SessionStreamFrameRow = InferSelectModel<
	typeof sessionStreamFrames
>;

export const schema = {
	spaceMetadata,
	sessions,
	sessionStreamFrames,
};
