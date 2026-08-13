CREATE TABLE `contact_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`author_id` text,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contact_notes_person_idx` ON `contact_notes` (`person_id`);--> statement-breakpoint
CREATE TABLE `contact_tags` (
	`person_id` text NOT NULL,
	`tag` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`person_id`, `tag`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `people` ADD `travel_notes` text;--> statement-breakpoint
ALTER TABLE `people` ADD `merged_into` text;