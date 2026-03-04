ALTER TABLE `sessions` ADD `run_id` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `run_status` text DEFAULT 'idle' NOT NULL;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `run_started_at` integer;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `run_completed_at` integer;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_event_at` integer;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `callback_token` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `run_error` text;
--> statement-breakpoint
CREATE INDEX `sessions_run_status_idx` ON `sessions` (`run_status`);
