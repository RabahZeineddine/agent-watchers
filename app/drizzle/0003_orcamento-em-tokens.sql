CREATE TABLE `model_prices` (
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_usd_per_mtok` real NOT NULL,
	`output_usd_per_mtok` real NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_prices_unq` ON `model_prices` (`provider`,`model`);--> statement-breakpoint
ALTER TABLE `runs` ADD `tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_daily` ADD `tokens` integer DEFAULT 0 NOT NULL;