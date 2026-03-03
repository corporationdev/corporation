CREATE TABLE `session_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_index` integer NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`connection_id` text NOT NULL,
	`sender` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`last_connection_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`destroyed_at` integer,
	`session_init` text,
	`model_id` text
);
