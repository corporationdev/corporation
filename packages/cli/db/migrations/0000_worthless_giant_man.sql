CREATE TABLE `runtime_command_receipts` (
	`command_id` text PRIMARY KEY NOT NULL,
	`stream_key` text NOT NULL,
	`command_type` text NOT NULL,
	`status` text DEFAULT 'accepted' NOT NULL,
	`input` text NOT NULL,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runtime_command_receipts_stream_status_idx` ON `runtime_command_receipts` (`stream_key`,`status`);--> statement-breakpoint
CREATE INDEX `runtime_command_receipts_stream_created_at_idx` ON `runtime_command_receipts` (`stream_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `runtime_event_log` (
	`id` text PRIMARY KEY NOT NULL,
	`stream_key` text NOT NULL,
	`sequence` integer NOT NULL,
	`session_id` text,
	`turn_id` text,
	`command_id` text,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_event_log_stream_sequence_unique` ON `runtime_event_log` (`stream_key`,`sequence`);--> statement-breakpoint
CREATE INDEX `runtime_event_log_stream_created_at_idx` ON `runtime_event_log` (`stream_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `runtime_event_log_command_id_idx` ON `runtime_event_log` (`command_id`);