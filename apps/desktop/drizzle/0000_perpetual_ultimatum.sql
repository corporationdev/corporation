CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_agent_sessions_updated_at` ON `agent_sessions` (`updated_at`);--> statement-breakpoint
CREATE TABLE `session_events` (
	`session_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`event_type` text NOT NULL,
	`event_json` text NOT NULL,
	PRIMARY KEY(`session_id`, `sequence`)
);
