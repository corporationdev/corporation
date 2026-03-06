CREATE TABLE `session_stream_frames` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`offset` integer NOT NULL,
	`created_at` integer NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_stream_frames_session_offset_idx` ON `session_stream_frames` (`session_id`,`offset`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_stream_offset` integer DEFAULT 0 NOT NULL;