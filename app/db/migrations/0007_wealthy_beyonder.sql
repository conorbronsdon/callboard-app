CREATE TABLE `contact_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`querystring` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_segments_name_idx` ON `contact_segments` (`name`);