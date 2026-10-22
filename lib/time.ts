const ATHENS_TIME_ZONE = "Europe/Athens";
// 24-hour clock in both languages: Greek defaults to 12-hour, which showed 00:05 as "12:05 π.μ."
// on a night-time app.
const HOUR_CYCLE = "h23";
// Built once: creating a formatter costs far more than using one, and the sky screen asks often.
const ATHENS_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: ATHENS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const ATHENS_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: ATHENS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

export function formatAthens(iso: string | Date, language: "el" | "en" = "el") {
  return new Intl.DateTimeFormat(language === "el" ? "el-GR" : "en-GB", {
    timeZone: ATHENS_TIME_ZONE,
    dateStyle: "short",
    timeStyle: "short",
    hourCycle: HOUR_CYCLE,
  }).format(typeof iso === "string" ? new Date(iso) : iso);
}

export function formatAthensTime(iso: string | Date, language: "el" | "en" = "el") {
  return new Intl.DateTimeFormat(language === "el" ? "el-GR" : "en-GB", {
    timeZone: ATHENS_TIME_ZONE,
    timeStyle: "short",
    hourCycle: HOUR_CYCLE,
  }).format(typeof iso === "string" ? new Date(iso) : iso);
}

export function athensUtcOffsetMinutes(date: Date) {
  const parts = ATHENS_CLOCK.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return Math.round((localAsUtc - date.getTime()) / 60_000);
}

const DAY_MS = 86_400_000;

/** The Athens calendar date of an instant. */
function athensDate(date: Date) {
  const parts = ATHENS_DATE.formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

/** Athens midnight of the date `offsetDays` after the one that contains `date`. */
function athensMidnight(date: Date, offsetDays: number) {
  const { year, month, day } = athensDate(date);
  const utcMidnight = Date.UTC(year, month - 1, day + offsetDays);
  // Athens runs 2 or 3 hours ahead; the offset is looked up again at the found instant, since
  // it can differ from the one at UTC midnight on the days the clocks change (never at 00:00).
  const guess = utcMidnight - athensUtcOffsetMinutes(new Date(utcMidnight)) * 60_000;
  return new Date(utcMidnight - athensUtcOffsetMinutes(new Date(guess)) * 60_000);
}

/** Start and end of the Athens day that contains `date`: 23 or 25 hours when the clocks change. */
export function athensDayBounds(date: Date) {
  return { start: athensMidnight(date, 0), end: athensMidnight(date, 1) };
}

/**
 * Noon of the Athens day `offsetDays` after the one that contains `date`. Adding 24 hours instead
 * lands on the wrong day around a clock change.
 */
export function athensNoon(date: Date, offsetDays = 0) {
  const { year, month, day } = athensDate(date);
  // The clocks change at 03:00–04:00, so the offset at 12:00 UTC is the one at Athens noon.
  const utcNoon = Date.UTC(year, month - 1, day + offsetDays, 12);
  return new Date(utcNoon - athensUtcOffsetMinutes(new Date(utcNoon)) * 60_000);
}

/** Whole Athens calendar days from `from` to `to` (0 the same day, 1 the next). */
export function athensDayDifference(from: Date, to: Date) {
  const a = athensDate(from);
  const b = athensDate(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);
}

export function dataFreshness(validAt: string | null, now = new Date(), staleAfterMinutes = 30) {
  if (!validAt) return { status: "unavailable" as const, ageMinutes: null };
  const ageMinutes = Math.max(0, Math.round((now.getTime() - new Date(validAt).getTime()) / 60_000));
  return { status: ageMinutes > staleAfterMinutes ? ("stale" as const) : ("available" as const), ageMinutes };
}

