CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`stream_key` text NOT NULL,
	`title` text DEFAULT 'New Chat' NOT NULL,
	`agent` text NOT NULL,
	`cwd` text NOT NULL,
	`model` text,
	`mode` text,
	`config_options` text,
	`last_applied_offset` text DEFAULT '-1' NOT NULL,
	`last_event_at` integer,
	`last_sync_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_stream_key_unique` ON `sessions` (`stream_key`);--> statement-breakpoint
CREATE INDEX `sessions_environment_id_updated_at_idx` ON `sessions` (`environment_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `runtime_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`stream_key` text NOT NULL,
	`session_id` text NOT NULL,
	`offset` text NOT NULL,
	`offset_seq` integer NOT NULL,
	`command_id` text,
	`turn_id` text,
	`event_type` text NOT NULL,
	`created_at` integer NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_events_stream_offset_unique` ON `runtime_events` (`stream_key`,`offset`);--> statement-breakpoint
CREATE INDEX `runtime_events_session_offset_seq_idx` ON `runtime_events` (`session_id`,`offset_seq`);--> statement-breakpoint
CREATE INDEX `runtime_events_stream_created_at_idx` ON `runtime_events` (`stream_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `runtime_events_command_id_idx` ON `runtime_events` (`command_id`);
