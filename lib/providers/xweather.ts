import { z } from "zod";
import type { CgLightning, Coordinates } from "@/lib/domain";
import { fetchWithRetry } from "@/lib/providers/fetch";
import { InFlight, TtlCache } from "@/lib/bounded-cache";

// Vaisala Xweather /lightning/summary: CG stroke counts by polarity and peak-current
// statistics around a point. One access per request (×1 endpoint), so the app asks once
// per observed storm and caches the answer. The site is public and every visitor spends
// the same allowance, so answers are shared for 10 minutes.
const SUMMARY_URL = "https://data.api.xweather.com/lightning/summary";
export const CG_WINDOW_MINUTES = 15;
const CACHE_TTL_MS = 10 * 60_000;
// Calls stop when the subscription period has fewer accesses left than this.
const QUOTA_RESERVE = 1_000;
const DAY_MS = 24 * 60 * 60_000;

export interface QuotaState {
  /** Latest allowance left in the period, from Xweather's rate-limit headers. */
  remaining: number | null;
  resetAtMs: number | null;
  /** UTC day of `dayStartRemaining`, and the allowance first seen that day. */
  day?: number | null;
  dayStartRemaining?: number | null;
}

const quota: QuotaState = { remaining: null, resetAtMs: null, day: null, dayStartRemaining: null };

/**
 * False once the period allowance is down to the reserve, until the period resets. Each
 * UTC day may also spend only an even share of what is left, so a burst of scans (anyone
 * can call the public API) uses up one day's share at most, not the whole month.
 */
export function quotaAllows(state: QuotaState, nowMs: number, reserve = QUOTA_RESERVE) {
  if (state.remaining == null) return true;
  if (state.resetAtMs != null && nowMs >= state.resetAtMs) return true;
  if (state.remaining <= reserve) return false;
  if (state.dayStartRemaining == null || state.resetAtMs == null || state.day !== Math.floor(nowMs / DAY_MS)) return true;
  const daysLeft = Math.max(1, Math.ceil((state.resetAtMs - nowMs) / DAY_MS));
  const dailyShare = (state.dayStartRemaining - reserve) / daysLeft;
  return state.dayStartRemaining - state.remaining < dailyShare;
}

export const xweatherQuotaAllows = (nowMs = Date.now()) => quotaAllows(quota, nowMs);

function recordQuota(response: Response, nowMs = Date.now()) {
  const remaining = Number(response.headers.get("x-ratelimit-remaining-period"));
  if (response.headers.has("x-ratelimit-remaining-period") && Number.isFinite(remaining)) {
    quota.remaining = remaining;
    const day = Math.floor(nowMs / DAY_MS);
    if (quota.day !== day) {
      // This response already spent one access of the new day.
      quota.day = day;
      quota.dayStartRemaining = remaining + 1;
    }
  }
  // An HTTP date, e.g. "Fri, 13 Nov 2026 00:00:00 GMT" for a monthly allowance.
  const resetAtMs = Date.parse(response.headers.get("x-ratelimit-reset-period") ?? "");
  if (Number.isFinite(resetAtMs)) quota.resetAtMs = resetAtMs;
}

const amplitude = z.object({ max: z.number().nullable().optional() }).passthrough();
const summarySchema = z.object({
  summary: z.object({
    pulse: z.object({
      count: z.number(),
      cg: z.number().optional(),
      positive: z.number().optional(),
      negative: z.number().optional(),
    }).passthrough(),
    peakAmp: z.object({ positive: amplitude.optional(), negative: amplitude.optional() }).passthrough().optional(),
  }).passthrough(),
});
const envelopeSchema = z.object({
  success: z.boolean(),
  error: z.object({ code: z.string(), description: z.string().optional() }).nullable().optional(),
  response: z.union([summarySchema, z.array(summarySchema)]).optional(),
});

// The browser fallback imports this module too; it has no process and never gets the keys.
const env = (name: string) => (typeof process === "undefined" ? undefined : process.env[name]);

export const xweatherConfigured = () => Boolean(env("XWEATHER_CLIENT_ID") && env("XWEATHER_CLIENT_SECRET"));

/** Reads a /lightning/summary response requested with `filter=cg`. */
export function parseCgSummary(raw: unknown, retrievedAt: string, windowMinutes: number): CgLightning {
  const envelope = envelopeSchema.parse(raw);
  if (!envelope.success) throw new Error(`Xweather ${envelope.error?.code ?? "error"}${envelope.error?.description ? `: ${envelope.error.description}` : ""}`);
  const record = Array.isArray(envelope.response) ? envelope.response[0] : envelope.response;
  // warn_no_data (an empty response) means no strokes in the window, which is a real answer.
  if (!record) return { windowMinutes, cgCount: 0, positiveCount: 0, negativeCount: 0, maxPositiveKa: null, maxNegativeKa: null, retrievedAt };
  const { pulse, peakAmp } = record.summary;
  const positiveCount = pulse.positive ?? 0;
  const negativeCount = pulse.negative ?? 0;
  const maxPositive = positiveCount > 0 ? peakAmp?.positive?.max ?? null : null;
  // Negative peak currents come as magnitudes; the largest one is the strongest stroke.
  const maxNegative = negativeCount > 0 ? peakAmp?.negative?.max ?? null : null;
  // Peak amplitudes are reported in amperes.
  const kiloamps = (amperes: number | null) => (amperes == null ? null : Math.round(Math.abs(amperes) / 1000));
  return {
    windowMinutes,
    cgCount: pulse.cg ?? pulse.count,
    positiveCount,
    negativeCount,
    maxPositiveKa: kiloamps(maxPositive),
    maxNegativeKa: kiloamps(maxNegative),
    retrievedAt,
  };
}

const cgCache = new TtlCache<CgLightning>(200);
const cgInFlight = new InFlight<CgLightning>();

/** CG strokes of the last CG_WINDOW_MINUTES within `radiusKm` of a storm centre. */
export async function fetchCgLightning(center: Coordinates, radiusKm: number): Promise<CgLightning> {
  const radius = Math.max(10, Math.min(150, Math.round(radiusKm)));
  const key = `${center.latitude.toFixed(1)}:${center.longitude.toFixed(1)}:${radius}`;
  const cached = cgCache.get(key);
  if (cached) return cached;
  return cgInFlight.run(key, async () => {
    const url = new URL(`${SUMMARY_URL}/${center.latitude.toFixed(4)},${center.longitude.toFixed(4)}`);
    url.searchParams.set("radius", `${radius}km`);
    url.searchParams.set("filter", "cg");
    // A lookback always needs to=now, or the API returns only a short slice from `from`.
    url.searchParams.set("from", `-${CG_WINDOW_MINUTES}minutes`);
    url.searchParams.set("to", "now");
    url.searchParams.set("client_id", env("XWEATHER_CLIENT_ID") ?? "");
    url.searchParams.set("client_secret", env("XWEATHER_CLIENT_SECRET") ?? "");
    const raw = await fetchWithRetry<unknown>(url.toString(), async (response) => {
      recordQuota(response);
      return response.json();
    }, { retries: 1, timeoutMs: 8_000, deadlineMs: 12_000, headers: { Accept: "application/json" } });
    const value = parseCgSummary(raw, new Date().toISOString(), CG_WINDOW_MINUTES);
    cgCache.set(key, value, CACHE_TTL_MS);
    return value;
  });
}
