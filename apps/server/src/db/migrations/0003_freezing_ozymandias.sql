DROP TABLE `session_events`;--> statement-breakpoint
DROP INDEX `session_stream_frames_session_offset_idx`;--> statement-breakpoint
ALTER TABLE `session_stream_frames` ADD `event_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `session_stream_frames_session_event_id_unique` ON `session_stream_frames` (`session_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `session_stream_frames_session_kind_offset_idx` ON `session_stream_frames` (`session_id`,`kind`,`offset`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_stream_frames_session_offset_idx` ON `session_stream_frames` (`session_id`,`offset`);