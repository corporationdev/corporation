CREATE TABLE `builds` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`step` text,
	`logs` text DEFAULT '' NOT NULL,
	`error` text,
	`snapshot_id` text,
	`started_at` integer NOT NULL,
	`completed_at` integer
);
