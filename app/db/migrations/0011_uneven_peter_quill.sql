CREATE TABLE `pipeline_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`stage` text DEFAULT 'prospect' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`enrolled_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`score` integer,
	`rationale` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_entries_person_idx` ON `pipeline_entries` (`person_id`);--> statement-breakpoint
CREATE INDEX `pipeline_entries_stage_idx` ON `pipeline_entries` (`stage`);--> statement-breakpoint
CREATE TABLE `stage_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`person_id` text NOT NULL,
	`from_stage` text,
	`to_stage` text NOT NULL,
	`moved_by_person_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`moved_by_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stage_transitions_person_idx` ON `stage_transitions` (`person_id`);--> statement-breakpoint
CREATE INDEX `stage_transitions_entry_idx` ON `stage_transitions` (`entry_id`);