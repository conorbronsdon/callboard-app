CREATE TABLE `upload_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`upload_id` text NOT NULL,
	`author_id` text,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `upload_comments_upload_idx` ON `upload_comments` (`upload_id`);--> statement-breakpoint
ALTER TABLE `uploads` ADD `version_of` text;--> statement-breakpoint
ALTER TABLE `uploads` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `uploads_version_idx` ON `uploads` (`version_of`);