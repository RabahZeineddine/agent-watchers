CREATE TABLE `trackers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`base_url` text NOT NULL,
	`project` text,
	`account` text,
	`credential_ref` text,
	`enabled` integer DEFAULT true NOT NULL
);
