CREATE TABLE `ai_triage` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`session_id` text NOT NULL,
	`score` integer,
	`recommendation` text,
	`reasoning` text,
	`model` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`requested_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_triage_session_idx` ON `ai_triage` (`session_id`);--> statement-breakpoint
CREATE INDEX `ai_triage_event_idx` ON `ai_triage` (`event_id`);