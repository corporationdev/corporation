DROP TABLE `previews`;--> statement-breakpoint
DROP TABLE `tabs`;--> statement-breakpoint
DROP TABLE `terminals`;--> statement-breakpoint
ALTER TABLE `sessions` ADD `title` text DEFAULT 'New Chat' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `updated_at` integer DEFAULT 0 NOT NULL;