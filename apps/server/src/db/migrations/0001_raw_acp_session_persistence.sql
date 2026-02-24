ALTER TABLE `sessions` ADD `agent` text DEFAULT 'claude' NOT NULL;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `agent_session_id` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_connection_id` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `session_init_json` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `destroyed_at` integer;
