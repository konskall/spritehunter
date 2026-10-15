import { describe, expect, it } from "vitest";
import type { CandidateScoreInput, ObservedLightning, WeatherHour } from "@/lib/domain";
import { parseCgSummary, quotaAllows } from "@/lib/providers/xweather";
import { mergeCloudSources, parseOpenWeatherHours, parseWeatherApiHours } from "@/lib/providers/sky-sources";
import { scoreOpportunity } from "@/lib/scoring";

const retrievedAt = "2026-10-13T21:00:00.000Z";

describe("Xweather CG summary", () => {
  const summary = (pulse: Record<string, number>, positiveMax?: number) => ({
    success: true,
    error: null,
    response: { summary: { pulse, ...(positiveMax == null ? {} : { peakAmp: { count: pulse.count, positive: { min: 9_000, max: positiveMax, avg: 30_000 } } }) } },
  });

  it("reads CG counts by polarity and the strongest positive stroke in kA", () => {
    const result = parseCgSummary(summary({ count: 14, cg: 14, ic: 0, positive: 3, negative: 11 }, 87_400), retrievedAt, 15);
    expect(result).toEqual({ windowMinutes: 15, cgCount: 14, positiveCount: 3, negativeCount: 11, maxPositiveKa: 87, maxNegativeKa: null, retrievedAt });
  });

  it("reads the strongest negative stroke, which drives ELVES", () => {
    // Xweather lists negative peak currents as magnitudes in amperes (379000 in its example).
    const raw = {
      success: true,
      error: null,
      response: { summary: { pulse: { count: 9, cg: 9, positive: 0, negative: 9 }, peakAmp: { count: 9, negative: { min: 4_000, max: 143_400, avg: 30_000 } } } },
    };
    expect(parseCgSummary(raw, retrievedAt, 15).maxNegativeKa).toBe(143);
  });

  it("accepts the array form of the response", () => {
    const raw = { ...summary({ count: 2, cg: 2, positive: 1, negative: 1 }, 45_000), response: [summary({ count: 2, cg: 2, positive: 1, negative: 1 }, 45_000).response] };
    expect(parseCgSummary(raw, retrievedAt, 15).positiveCount).toBe(1);
  });

  it("treats warn_no_data as a storm without CG strokes", () => {
    const result = parseCgSummary({ success: true, error: { code: "warn_no_data", description: "No data" }, response: [] }, retrievedAt, 15);
    expect(result).toEqual({ windowMinutes: 15, cgCount: 0, positiveCount: 0, negativeCount: 0, maxPositiveKa: null, maxNegativeKa: null, retrievedAt });
  });

  it("stops calling near the end of the allowance until the period resets", () => {
    const now = Date.parse("2026-10-20T00:00:00Z");
    const reset = Date.parse("2026-11-13T00:00:00Z");
    expect(quotaAllows({ remaining: null, resetAtMs: null }, now)).toBe(true);
    expect(quotaAllows({ remaining: 5_000, resetAtMs: reset }, now)).toBe(true);
    expect(quotaAllows({ remaining: 900, resetAtMs: reset }, now)).toBe(false);
    expect(quotaAllows({ remaining: 900, resetAtMs: reset }, reset)).toBe(true);
  });

  it("lets one day spend only its share of what is left", () => {
    const now = Date.parse("2026-10-20T21:00:00Z");
    const reset = Date.parse("2026-10-30T00:00:00Z");
    const day = Math.floor(now / 86_400_000);
    // 10 days left, 6,000 above the reserve at the start of the day: 600 for today.
    const state = { resetAtMs: reset, day, dayStartRemaining: 7_000 };
    expect(quotaAllows({ ...state, remaining: 6_500 }, now)).toBe(true);
    expect(quotaAllows({ ...state, remaining: 6_400 }, now)).toBe(false);
    // The share starts again on the next UTC day.
    expect(quotaAllows({ ...state, remaining: 6_400 }, now + 86_400_000)).toBe(true);
  });

  it("throws on an unsuccessful response instead of inventing zero strokes", () => {
    expect(() => parseCgSummary({ success: false, error: { code: "invalid_client", description: "bad key" }, response: [] }, retrievedAt, 15)).toThrow(/invalid_client/);
  });
});

describe("observer sky sources", () => {
  const start = Date.parse("2026-10-13T18:00:00Z");
  const hour = (index: number, cloudCover: number): WeatherHour => ({
    time: new Date(start + index * 3_600_000).toISOString().replace(":00.000Z", "Z"), temperatureC: 20, relativeHumidity: 60, precipitationMm: 0, precipitationProbability: 0,
    cloudCover, cloudCoverLow: 0, cloudCoverMid: 0, cloudCoverHigh: 0, visibilityM: 30_000, windSpeedKmh: 5, windDirectionDeg: 0,
    capeJkg: 0, convectiveInhibitionJkg: 0, liftedIndex: 0, precipitableWaterKgM2: 20, weatherCode: 0,
  });

  it("reads WeatherAPI hourly cloud", () => {
    const raw = { forecast: { forecastday: [{ hour: [{ time_epoch: start / 1000, cloud: 12, vis_km: 10 }, { time_epoch: start / 1000 + 3600, cloud: 40, vis_km: 8 }] }] } };
    expect(parseWeatherApiHours(raw)).toEqual([{ timeMs: start, cloudPercent: 12 }, { timeMs: start + 3_600_000, cloudPercent: 40 }]);
  });

  it("reads OpenWeatherMap 3-hourly cloud", () => {
    const raw = { list: [{ dt: start / 1000, clouds: { all: 75 }, visibility: 10_000 }, { dt: start / 1000 + 10_800, clouds: { all: 5 } }] };
    expect(parseOpenWeatherHours(raw)).toEqual([{ timeMs: start, cloudPercent: 75 }, { timeMs: start + 10_800_000, cloudPercent: 5 }]);
  });

  it("adds each source per hour and takes the median as consensus", () => {
    const merged = mergeCloudSources(
      [hour(0, 80), hour(1, 10), hour(5, 10)],
      [{ timeMs: start, cloudPercent: 20 }, { timeMs: start + 3_600_000, cloudPercent: 15 }],
      [{ timeMs: start, cloudPercent: 30 }, { timeMs: start + 3 * 3_600_000, cloudPercent: 90 }],
    );
    expect(merged[0].cloudSources).toEqual({ openMeteo: 80, weatherApi: 20, openWeather: 30 });
    expect(merged[0].cloudConsensus).toBe(30);
    // OpenWeatherMap steps are 3 h apart: 1 h from 18:00 still matches, 2 h from 21:00 does not.
    expect(merged[1].cloudSources).toEqual({ openMeteo: 10, weatherApi: 15, openWeather: 30 });
    expect(merged[2].cloudSources).toEqual({ openMeteo: 10, weatherApi: null, openWeather: null });
    expect(merged[2].cloudConsensus).toBe(10);
  });

  it("keeps Open-Meteo alone when no other source is configured", () => {
    const merged = mergeCloudSources([hour(0, 55)], null, null);
    expect(merged[0].cloudConsensus).toBe(55);
    expect(merged[0].cloudSources).toEqual({ openMeteo: 55, weatherApi: null, openWeather: null });
  });
});

describe("scoring with CG polarity and sky consensus", () => {
  const storm: ObservedLightning = { stormId: "s1", observedAt: retrievedAt, ageMinutes: 5, areaKm2: 800, maxFlashesPer5Min: 8, frames: 3, windowMinutes: 15 };
  const base: CandidateScoreInput = {
    capeJkg: 600, precipitationMm: 1, thunderCode: false, observerCloudPercent: 10, observerHighCloudPercent: 10, visibilityM: 30_000,
    distanceKm: 350, sunAltitudeDeg: -25, moonInterference: false, lightning: "observed", observedLightning: storm,
  };
  const cg = (positiveCount: number, maxPositiveKa: number | null, cgCount = 20) => ({ windowMinutes: 15, cgCount, positiveCount, negativeCount: cgCount - positiveCount, maxPositiveKa, retrievedAt });

  it("raises activity and confidence for strong positive CG strokes", () => {
    const without = scoreOpportunity({ ...base, terrain: "unknown" });
    const strong = scoreOpportunity({ ...base, observedLightning: { ...storm, cg: cg(4, 92) }, terrain: "unknown" });
    expect(strong.activity).toBeGreaterThan(without.activity);
    expect(strong.confidence).toBe("high");
    expect(strong.reasons.some((reason) => reason.el.includes("+CG") && reason.en.includes("+CG"))).toBe(true);
  });

  it("gives weak positive strokes a smaller boost than strong ones", () => {
    const weak = scoreOpportunity({ ...base, observedLightning: { ...storm, cg: cg(2, 18) }, terrain: "unknown" });
    const strong = scoreOpportunity({ ...base, observedLightning: { ...storm, cg: cg(2, 92) }, terrain: "unknown" });
    expect(strong.activity).toBeGreaterThan(weak.activity);
    expect(weak.confidence).toBe("medium");
  });

  it("lets positive CG separate large storms whose MTG-LI activity is already saturated", () => {
    const large = { ...storm, areaKm2: 10_000, maxFlashesPer5Min: 20 };
    const strong = scoreOpportunity({ ...base, capeJkg: 1_500, observedLightning: { ...large, cg: cg(11, 103) }, terrain: "unknown" });
    const negative = scoreOpportunity({ ...base, capeJkg: 1_500, observedLightning: { ...large, cg: cg(0, null) }, terrain: "unknown" });
    // Model share 6 + lightning 9 + 3.5·log10(10 000/50) ≈ 8.05 + 2 + 1 ≈ 26; strong +CG adds 8.
    expect(strong.activity).toBe(34);
    expect(negative.activity).toBe(26);
    expect(strong.total).toBeGreaterThan(negative.total);
  });

  it("notes a storm with only negative CG strokes", () => {
    const negative = scoreOpportunity({ ...base, observedLightning: { ...storm, cg: cg(0, null) }, terrain: "unknown" });
    const without = scoreOpportunity({ ...base, terrain: "unknown" });
    expect(negative.activity).toBe(without.activity);
    expect(negative.limitations.some((limitation) => limitation.el.includes("αρνητικ") && limitation.en.includes("negative"))).toBe(true);
  });

  it("warns when the sky forecasts disagree and credits agreement", () => {
    const disagree = scoreOpportunity({ ...base, observerCloudSources: 3, observerCloudSpread: 70, terrain: "unknown" });
    expect(disagree.limitations.some((limitation) => limitation.el.includes("διαφωνούν") && limitation.en.includes("disagree"))).toBe(true);
    const agree = scoreOpportunity({ ...base, observerCloudSources: 3, observerCloudSpread: 10, terrain: "unknown" });
    expect(agree.reasons.some((reason) => reason.el.includes("συμφωνούν") && reason.en.includes("agree"))).toBe(true);
  });
});
