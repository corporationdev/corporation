ALTER TABLE `tabs` ADD `active` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `terminals` ADD `pty_pid` integer;--> statement-breakpoint
ALTER TABLE `terminals` DROP COLUMN `pty_session_id`;