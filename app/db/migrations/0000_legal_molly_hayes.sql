CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_suffix` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_idx` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`purpose` text DEFAULT 'magic_link' NOT NULL,
	`redirect_to` text,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`use_count` integer DEFAULT 0 NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_tokens_hash_idx` ON `auth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_tokens_person_idx` ON `auth_tokens` (`person_id`);--> statement-breakpoint
CREATE TABLE `comm_log` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text,
	`person_id` text,
	`template_id` text,
	`channel` text DEFAULT 'email' NOT NULL,
	`to_email` text NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`provider_message_id` text,
	`error` text,
	`meta` text,
	`sent_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`template_id`) REFERENCES `email_templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `comm_log_event_idx` ON `comm_log` (`event_id`);--> statement-breakpoint
CREATE INDEX `comm_log_person_idx` ON `comm_log` (`person_id`);--> statement-breakpoint
CREATE TABLE `email_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`from_name` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_templates_event_key_idx` ON `email_templates` (`event_id`,`key`);--> statement-breakpoint
CREATE TABLE `event_people` (
	`event_id` text NOT NULL,
	`person_id` text NOT NULL,
	`event_role` text DEFAULT 'speaker' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`event_id`, `person_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_people_person_idx` ON `event_people` (`person_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`location` text,
	`timezone` text DEFAULT 'America/Los_Angeles' NOT NULL,
	`starts_on` integer,
	`ends_on` integer,
	`submission_limit` integer,
	`settings` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_slug_idx` ON `events` (`slug`);--> statement-breakpoint
CREATE TABLE `fields` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`module` text DEFAULT 'session' NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`help_text` text,
	`type` text NOT NULL,
	`constraints` text,
	`is_locked` integer DEFAULT false NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fields_event_module_key_idx` ON `fields` (`event_id`,`module`,`key`);--> statement-breakpoint
CREATE TABLE `formats` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`default_minutes` integer,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `formats_event_name_idx` ON `formats` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `forms` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`target` text DEFAULT 'submission' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`welcome_title` text,
	`welcome_body` text,
	`thank_you_body` text,
	`schema` text DEFAULT '{}' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`min_speakers` integer DEFAULT 1 NOT NULL,
	`max_speakers` integer,
	`max_participants_total` integer,
	`closes_at` integer,
	`submission_limit` integer,
	`allow_multiple_drafts` integer DEFAULT true NOT NULL,
	`reminder_template_id` text,
	`thank_you_template_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `forms_event_idx` ON `forms` (`event_id`);--> statement-breakpoint
CREATE TABLE `levels` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `levels_event_name_idx` ON `levels` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`full_name` text,
	`first_name` text,
	`last_name` text,
	`pronouns` text,
	`company` text,
	`title` text,
	`bio` text,
	`headshot_key` text,
	`links` text,
	`role` text DEFAULT 'speaker' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_email_idx` ON `people` (`email`);--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`html_embed` text,
	`is_published` integer DEFAULT false NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resources_event_slug_idx` ON `resources` (`event_id`,`slug`);--> statement-breakpoint
CREATE TABLE `review_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`round_id` text NOT NULL,
	`session_id` text NOT NULL,
	`team_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `review_rounds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `review_teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_assignments_round_session_team_idx` ON `review_assignments` (`round_id`,`session_id`,`team_id`);--> statement-breakpoint
CREATE INDEX `review_assignments_session_idx` ON `review_assignments` (`session_id`);--> statement-breakpoint
CREATE TABLE `review_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`ordinal` integer DEFAULT 1 NOT NULL,
	`rubric` text,
	`ai_assist` integer DEFAULT false NOT NULL,
	`opens_at` integer,
	`closes_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_rounds_event_ordinal_idx` ON `review_rounds` (`event_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `review_team_members` (
	`team_id` text NOT NULL,
	`person_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`team_id`, `person_id`),
	FOREIGN KEY (`team_id`) REFERENCES `review_teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `review_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_teams_event_name_idx` ON `review_teams` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`round_id` text NOT NULL,
	`session_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`scores` text,
	`total_score` integer,
	`comment` text,
	`is_ai_suggested` integer DEFAULT false NOT NULL,
	`submitted_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `review_rounds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_round_session_reviewer_idx` ON `reviews` (`round_id`,`session_id`,`reviewer_id`);--> statement-breakpoint
CREATE INDEX `reviews_session_idx` ON `reviews` (`session_id`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`capacity` integer,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_event_name_idx` ON `rooms` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `session_participants` (
	`session_id` text NOT NULL,
	`person_id` text NOT NULL,
	`role` text DEFAULT 'speaker' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`session_id`, `person_id`, `role`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_participants_person_idx` ON `session_participants` (`person_id`);--> statement-breakpoint
CREATE TABLE `session_tags` (
	`session_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `tag_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`friendly_id` text,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`is_abstract` integer DEFAULT false NOT NULL,
	`form_id` text,
	`answers` text,
	`video_url` text,
	`external_url` text,
	`track_id` text,
	`room_id` text,
	`format_id` text,
	`level_id` text,
	`starts_at` integer,
	`ends_at` integer,
	`capacity` integer,
	`is_public` integer DEFAULT false NOT NULL,
	`published_at` integer,
	`composed_into_session_id` text,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`format_id`) REFERENCES `formats`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`level_id`) REFERENCES `levels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sessions_event_idx` ON `sessions` (`event_id`);--> statement-breakpoint
CREATE INDEX `sessions_event_abstract_status_idx` ON `sessions` (`event_id`,`is_abstract`,`status`);--> statement-breakpoint
CREATE INDEX `sessions_event_starts_idx` ON `sessions` (`event_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `sessions_room_starts_idx` ON `sessions` (`room_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `sessions_composed_idx` ON `sessions` (`composed_into_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_event_friendly_idx` ON `sessions` (`event_id`,`friendly_id`);--> statement-breakpoint
CREATE TABLE `sessions_auth` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer,
	`user_agent` text,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_auth_person_idx` ON `sessions_auth` (`person_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`provider` text NOT NULL,
	`cursor` text,
	`last_synced_at` integer,
	`last_error` text,
	`state` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_state_event_provider_idx` ON `sync_state` (`event_id`,`provider`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_event_name_idx` ON `tags` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `task_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`form_id` text,
	`due_offset_days` integer,
	`is_required` integer DEFAULT true NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `task_templates_event_idx` ON `task_templates` (`event_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`template_id` text,
	`person_id` text NOT NULL,
	`session_id` text,
	`title` text NOT NULL,
	`description` text,
	`form_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_at` integer,
	`completed_at` integer,
	`response` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `task_templates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tasks_event_person_idx` ON `tasks` (`event_id`,`person_id`);--> statement-breakpoint
CREATE INDEX `tasks_event_status_idx` ON `tasks` (`event_id`,`status`);--> statement-breakpoint
CREATE TABLE `tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracks_event_name_idx` ON `tracks` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`purpose` text DEFAULT 'other' NOT NULL,
	`key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`uploaded_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_key_idx` ON `uploads` (`key`);--> statement-breakpoint
CREATE INDEX `uploads_owner_idx` ON `uploads` (`owner_type`,`owner_id`);