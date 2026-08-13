CREATE TABLE `comm_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comm_batches_event_key_idx` ON `comm_batches` (`event_id`,`idempotency_key`);