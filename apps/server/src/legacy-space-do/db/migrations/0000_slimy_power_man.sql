CREATE TABLE `session_stream_frames` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`offset` integer NOT NULL,
	`created_at` integer NOT NULL,
	`kind` text NOT NULL,
	`event_id` text,
	`data` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_stream_frames_session_offset_idx` ON `session_stream_frames` (`session_id`,`offset`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_stream_frames_session_event_id_unique` ON `session_stream_frames` (`session_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `session_stream_frames_session_kind_offset_idx` ON `session_stream_frames` (`session_id`,`kind`,`offset`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT 'New Chat' NOT NULL,
	`agent` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`last_connection_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL,
	`destroyed_at` integer,
	`session_init` text,
	`model_id` text,
	`run_id` text,
	`pid` integer,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_stream_offset` integer DEFAULT 0 NOT NULL,
	`callback_token` text,
	`error` text
);
