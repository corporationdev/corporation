import type { InferSelectModel } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const buildTypeValues = ["build", "rebuild", "override"] as const;
export type BuildType = (typeof buildTypeValues)[number];

export const buildStatusValues = ["running", "success", "error"] as const;
export type BuildStatus = (typeof buildStatusValues)[number];

export const buildStepValues = [
	"cloning",
	"writing_env",
	"setup_command",
	"installing_agent",
	"creating_snapshot",
] as const;
export type BuildStep = (typeof buildStepValues)[number];

export const builds = sqliteTable("builds", {
	id: text("id").primaryKey(),
	type: text("type", { enum: buildTypeValues }).notNull(),
	status: text("status", { enum: buildStatusValues }).notNull(),
	step: text("step", { enum: buildStepValues }),
	logs: text("logs").notNull().default(""),
	error: text("error"),
	snapshotId: text("snapshot_id"),
	startedAt: integer("started_at", { mode: "number" }).notNull(),
	completedAt: integer("completed_at", { mode: "number" }),
});

export type BuildRow = InferSelectModel<typeof builds>;
