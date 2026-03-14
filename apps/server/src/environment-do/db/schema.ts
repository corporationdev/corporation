import type { InferSelectModel } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const environmentStreamSubscriptions = sqliteTable(
	"environment_stream_subscriptions",
	{
		stream: text("stream").primaryKey(),
		requesterId: text("requester_id").notNull(),
		callbackBinding: text("callback_binding").notNull(),
		callbackName: text("callback_name").notNull(),
		lastPersistedOffset: text("last_persisted_offset").notNull(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	}
);

export type EnvironmentStreamSubscriptionRow = InferSelectModel<
	typeof environmentStreamSubscriptions
>;

export const schema = {
	environmentStreamSubscriptions,
};
