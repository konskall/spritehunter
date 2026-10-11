import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const savedLocations = sqliteTable("saved_locations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  elevationM: real("elevation_m"),
  cameraHeightM: real("camera_height_m").notNull().default(1.6),
  lightPollution: text("light_pollution").notNull().default("unknown"),
  notes: text("notes").notNull().default(""),
  safetyNotes: text("safety_notes").notNull().default(""),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const observationLogs = sqliteTable("observation_logs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  observedAtUtc: text("observed_at_utc").notNull(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  targetJson: text("target_json"),
  tleType: text("tle_type").notNull(),
  cameraJson: text("camera_json").notNull(),
  skyJson: text("sky_json"),
  outcome: text("outcome").notNull(),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull(),
});

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  preferencesJson: text("preferences_json").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
});

export const monitorRuns = sqliteTable("monitor_runs", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status").notNull(),
  providerSummaryJson: text("provider_summary_json").notNull(),
  alertsSent: integer("alerts_sent").notNull().default(0),
});

