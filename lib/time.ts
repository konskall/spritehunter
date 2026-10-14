export const ATHENS_TIME_ZONE = "Europe/Athens";
// 24-hour clock in both languages: Greek defaults to 12-hour, which showed 00:05 as "12:05 π.μ."
// on a night-time app.
const HOUR_CYCLE = "h23";

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
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATHENS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
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

export function dataFreshness(validAt: string | null, now = new Date(), staleAfterMinutes = 30) {
  if (!validAt) return { status: "unavailable" as const, ageMinutes: null };
  const ageMinutes = Math.max(0, Math.round((now.getTime() - new Date(validAt).getTime()) / 60_000));
  return { status: ageMinutes > staleAfterMinutes ? ("stale" as const) : ("available" as const), ageMinutes };
}

