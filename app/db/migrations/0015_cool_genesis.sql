ALTER TABLE `ai_triage` ADD `organizer_score` integer;--> statement-breakpoint
ALTER TABLE `ai_triage` ADD `organizer_note` text;--> statement-breakpoint
ALTER TABLE `ai_triage` ADD `organizer_scored_by_id` text REFERENCES people(id);--> statement-breakpoint
ALTER TABLE `ai_triage` ADD `organizer_scored_at` integer;