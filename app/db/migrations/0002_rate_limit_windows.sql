CREATE TABLE `rate_limit_windows` (
  `scope` text NOT NULL,
  `identifier_hash` text NOT NULL,
  `window_start` integer NOT NULL,
  `window_count` integer DEFAULT 0 NOT NULL,
  `expires_at` integer NOT NULL,
  PRIMARY KEY(`scope`, `identifier_hash`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `rate_limit_windows_expires_idx` ON `rate_limit_windows` (`expires_at`);
