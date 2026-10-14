import type { LensProfile, LogEntry, SavedLocation } from "@/lib/domain";
import type { AlertPreferences } from "@/lib/notifications";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const finiteIn = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export function isSavedLocation(value: unknown): value is SavedLocation {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && finiteIn(value.latitude, -90, 90)
    && finiteIn(value.longitude, -180, 180)
    && (value.elevationM === undefined || finiteIn(value.elevationM, -500, 9000))
    && finiteIn(value.cameraHeightM, 0, 100);
}

export function isLocationList(value: unknown): value is SavedLocation[] {
  return Array.isArray(value) && value.length > 0 && value.every(isSavedLocation);
}

export function isSearchRange(value: unknown): value is { min: number; max: number } {
  return isRecord(value) && finiteIn(value.min, 100, 800) && finiteIn(value.max, 100, 800) && (value.min as number) < (value.max as number);
}

export function isLensList(value: unknown): value is LensProfile[] {
  return Array.isArray(value) && value.length > 0 && value.every((lens) => isRecord(lens)
    && typeof lens.id === "string"
    && typeof lens.name === "string"
    && finiteIn(lens.focalLengthMm, 1, 2_000)
    && finiteIn(lens.maxAperture, 0.5, 64));
}

const isClockTime = (value: unknown) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export function isAlertPrefs(value: unknown): value is AlertPreferences {
  return isRecord(value)
    && finiteIn(value.minimumScore, 0, 100)
    && (value.confidence === "low" || value.confidence === "medium" || value.confidence === "high")
    && finiteIn(value.cooldown, 0, 1_440)
    && isClockTime(value.quietStart)
    && isClockTime(value.quietEnd);
}

export function isLogEntry(entry: unknown): entry is LogEntry {
  return isRecord(entry)
    && ["id", "timestamp", "target", "tleType", "lens", "shutter", "notes"].every((key) => typeof entry[key] === "string")
    && finiteIn(entry.iso, 0, 10_000_000)
    && finiteIn(entry.aperture, 0, 1_000)
    && (entry.success === "yes" || entry.success === "no" || entry.success === "uncertain");
}

/**
 * Any array is kept: rejecting the list for one malformed entry would reset the stored
 * logbook to empty. The screen shows only well-formed entries (see isLogEntry).
 */
export const isLogList = (value: unknown): value is LogEntry[] => Array.isArray(value);

export const isLanguage = (value: unknown): value is "el" | "en" => value === "el" || value === "en";
export const isOrientation = (value: unknown): value is "landscape" | "portrait" => value === "landscape" || value === "portrait";
export const isString = (value: unknown): value is string => typeof value === "string";
export const isLastAlert = (value: unknown): value is { at: string; score: number } | null =>
  value === null || (isRecord(value) && typeof value.at === "string" && finiteIn(value.score, 0, 100));
