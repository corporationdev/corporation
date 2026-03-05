CREATE TABLE `previews` (
	`id` text PRIMARY KEY NOT NULL,
	`tab_id` text NOT NULL,
	`url` text NOT NULL,
	`port` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tab_id`) REFERENCES `tabs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `previews_tab_id_unique` ON `previews` (`tab_id`);--> statement-breakpoint
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
	`model_id` text,
	`run_id` text,
	`pid` integer,
	`status` text DEFAULT 'idle' NOT NULL,
	`callback_token` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `tabs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`session_id` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE TABLE `terminals` (
	`id` text PRIMARY KEY NOT NULL,
	`tab_id` text NOT NULL,
	`pty_pid` integer,
	`cols` integer NOT NULL,
	`rows` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tab_id`) REFERENCES `tabs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `terminals_tab_id_unique` ON `terminals` (`tab_id`);