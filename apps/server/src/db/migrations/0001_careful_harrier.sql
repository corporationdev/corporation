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
CREATE UNIQUE INDEX `previews_tab_id_unique` ON `previews` (`tab_id`);