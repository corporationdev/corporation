ALTER TABLE `sessions` ADD `run_id` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `pid` integer;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `status` text DEFAULT 'idle' NOT NULL;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `callback_token` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `error` text;
--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);
