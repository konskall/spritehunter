CREATE TABLE `monitor_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`provider_summary_json` text NOT NULL,
	`alerts_sent` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observation_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`observed_at_utc` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`target_json` text,
	`tle_type` text NOT NULL,
	`camera_json` text NOT NULL,
	`sky_json` text,
	`outcome` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`preferences_json` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `saved_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`elevation_m` real,
	`camera_height_m` real DEFAULT 1.6 NOT NULL,
	`light_pollution` text DEFAULT 'unknown' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`safety_notes` text DEFAULT '' NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
