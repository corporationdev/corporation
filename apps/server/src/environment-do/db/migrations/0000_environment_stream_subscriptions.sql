CREATE TABLE `environment_stream_subscriptions` (
	`stream` text PRIMARY KEY NOT NULL,
	`requester_id` text NOT NULL,
	`callback_binding` text NOT NULL,
	`callback_name` text NOT NULL,
	`last_persisted_offset` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
