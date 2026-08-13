ALTER TABLE `forms` ADD `surface` text DEFAULT 'cfp' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `kind` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `completed_by_id` text REFERENCES people(id);