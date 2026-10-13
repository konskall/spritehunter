import { describe, expect, it } from "vitest";
import type { AviationObservation, WeatherHour } from "@/lib/domain";
import { buildCandidate } from "@/lib/providers/open-meteo";
import { rescoreWithTerrain } from "@/lib/scoring";
import { evaluateAlert, isQuietTime, meetsConfidence } from "@/lib/notifications";

const sparta = { latitude: 37.075, longitude: 22.43, elevationM: 210 };
const start = Date.parse("2026-07-15T00:00:00Z");
const hourIso = (index: number) => new Date(start + index * 3_600_000).toISOString().slice(0, 16);

// Hourly target-cell payload: quiet everywhere except the hours given in `storms`.
function targetPayload(storms: Record<number, { cape: number; precipitation: number; code: number }>) {
  const hours = Array.from({ length: 48 }, (_, index) => index);
  return {
    latitude: 34.5,
    longitude: 24.5,
    elevation: 0,
    hourly: {
      time: hours.map(hourIso),
      cape: hours.map((index) => storms[index]?.cape ?? 0),
      precipitation: hours.map((index) => storms[index]?.precipitation ?? 0),
      weather_code: hours.map((index) => storms[index]?.code ?? 0),
      wind_speed_10m: hours.map(() => 10),
    },
  };
}

function observerHours(cloud: number, high: number, visibility: number): WeatherHour[] {
  return Array.from({ length: 48 }, (_, index) => ({
    time: `${hourIso(index)}Z`, temperatureC: 25, relativeHumidity: 50, precipitationMm: 0, precipitationProbability: 0,
    cloudCover: cloud, cloudCoverLow: 0, cloudCoverMid: 0, cloudCoverHigh: high, visibilityM: visibility,
    windSpeedKmh: 5, windDirectionDeg: 0, capeJkg: 0, convectiveInhibitionJkg: 0, liftedIndex: 0, precipitableWaterKgM2: 20, weatherCode: 0,
  }));
}

function metar(overrides: Partial<AviationObservation>): AviationObservation {
  return {
    status: "available", stationId: "LGKL", stationName: "Kalamata", distanceKm: 36, observedAt: "2026-07-15T22:00:00.000Z",
    retrievedAt: "2026-07-15T22:05:00.000Z", visibilityM: 10_000, cloudCoverPercent: 0, cloudSummary: { el: "CAVOK", en: "CAVOK" },
    windDirectionDeg: 0, windSpeedKmh: 0, weather: null, flightCategory: "VFR", rawMetar: "METAR LGKL 152200Z CAVOK",
    rawTaf: null, tafValidFrom: null, tafValidTo: null, message: { el: "", en: "" }, ...overrides,
  };
}

const noMetar = metar({ status: "unavailable", observedAt: null, cloudCoverPercent: null, visibilityM: null });

describe("forecast candidate selection", () => {
  it("chooses a dark-sky hour over a stronger daytime peak", () => {
    const payload = targetPayload({
      13: { cape: 2_000, precipitation: 3, code: 95 }, // 16:00 Athens, sun high
      22: { cape: 900, precipitation: 1, code: 95 }, // 01:00 Athens, astronomical night
    });
    const candidate = buildCandidate(sparta, payload, observerHours(0, 0, 30_000), noMetar, "2026-07-15T00:00:00Z", start);
    expect(candidate?.forecastValidAt).toBe("2026-07-15T22:00Z");
    expect(candidate!.score.total).toBeGreaterThan(29);
  });

  it("keeps forecast high cloud even when a METAR reports a clear low sky", () => {
    const payload = targetPayload({ 22: { cape: 900, precipitation: 1, code: 95 } });
    const candidate = buildCandidate(sparta, payload, observerHours(90, 90, 30_000), metar({}), "2026-07-15T00:00:00Z", start);
    // Blocking cloud = forecast high cloud 90 % → 20·0.1 + 10·(10 000/30 000) ≈ 5.
    expect(candidate!.score.atmosphere).toBe(5);
  });

  it("falls back to the forecast for fields the METAR does not report", () => {
    const payload = targetPayload({ 22: { cape: 900, precipitation: 1, code: 95 } });
    const candidate = buildCandidate(sparta, payload, observerHours(10, 10, 30_000), metar({ cloudCoverPercent: null, visibilityM: null }), "2026-07-15T00:00:00Z", start);
    // 20·(1 − 0.10) + 10·(30 000/30 000) = 28.
    expect(candidate!.score.atmosphere).toBe(28);
  });

  it("takes lightning potential from the 15-minute step at the valid hour", () => {
    const steps = Array.from({ length: 192 }, (_, index) => index);
    const payload = {
      ...targetPayload({ 22: { cape: 900, precipitation: 1, code: 95 } }),
      minutely_15: { time: steps.map((index) => new Date(start + index * 900_000).toISOString().slice(0, 16)), lightning_potential: steps },
    };
    const candidate = buildCandidate(sparta, payload, observerHours(0, 0, 30_000), noMetar, "2026-07-15T00:00:00Z", start)!;
    expect(candidate.forecastValidAt).toBe("2026-07-15T22:00Z");
    expect(candidate.lightningPotentialJkg).toBe(22 * 4);
  });

  it("uses the observer forecast for the valid hour", () => {
    const payload = targetPayload({ 22: { cape: 900, precipitation: 1, code: 95 } });
    const hours = observerHours(100, 100, 30_000).map((hour, index) => index === 22 ? { ...hour, cloudCover: 50, cloudCoverHigh: 50 } : hour);
    const candidate = buildCandidate(sparta, payload, hours, noMetar, "2026-07-15T00:00:00Z", start)!;
    // 20·(1 − 0.50) + 10·(30 000/30 000) = 20; any other hour would give 10.
    expect(candidate.score.atmosphere).toBe(20);
  });

  it("ignores a stale METAR", () => {
    const payload = targetPayload({ 22: { cape: 900, precipitation: 1, code: 95 } });
    const candidate = buildCandidate(sparta, payload, observerHours(10, 10, 30_000), metar({ status: "stale", cloudCoverPercent: 100, visibilityM: 1_000 }), "2026-07-15T00:00:00Z", start);
    expect(candidate!.score.atmosphere).toBe(28);
  });
});

describe("terrain-aware rescoring", () => {
  it("raises the terrain component and confidence once the DEM confirms a clear view", () => {
    const payload = targetPayload({ 22: { cape: 900, precipitation: 1, code: 95 } });
    const candidate = buildCandidate(sparta, payload, observerHours(0, 0, 30_000), noMetar, "2026-07-15T00:00:00Z", start)!;
    expect(candidate.score.terrain).toBe(5);
    const clear = rescoreWithTerrain(candidate.scoreInput, "clear");
    expect(clear.terrain).toBe(20);
    expect(clear.confidence).toBe("medium");
    expect(rescoreWithTerrain(candidate.scoreInput, "blocked").total).toBeLessThanOrEqual(29);
  });
});

describe("notification rules", () => {
  it("detects quiet hours that wrap past midnight", () => {
    expect(isQuietTime(new Date(2026, 0, 1, 23, 30), "23:00", "06:00")).toBe(true);
    expect(isQuietTime(new Date(2026, 0, 1, 5, 59), "23:00", "06:00")).toBe(true);
    expect(isQuietTime(new Date(2026, 0, 1, 6, 0), "23:00", "06:00")).toBe(false);
    expect(isQuietTime(new Date(2026, 0, 1, 12, 0), "23:00", "06:00")).toBe(false);
  });
  it("detects quiet hours within a single day", () => {
    expect(isQuietTime(new Date(2026, 0, 1, 0, 30), "01:00", "08:00")).toBe(false);
    expect(isQuietTime(new Date(2026, 0, 1, 1, 0), "01:00", "08:00")).toBe(true);
  });
  it("compares data confidence levels", () => {
    expect(meetsConfidence("medium", "low")).toBe(true);
    expect(meetsConfidence("low", "medium")).toBe(false);
    expect(meetsConfidence("insufficient", "low")).toBe(false);
  });
  it("suppresses alerts during quiet hours or below the confidence threshold", () => {
    const prefs = { minimumScore: 50, confidence: "low" as const, cooldown: 90, quietStart: "01:00", quietEnd: "08:00" };
    const base = { score: 60, confidence: "medium" as const, last: null };
    expect(evaluateAlert({ ...base, prefs, now: new Date(2026, 0, 1, 22, 0) })).toBe(true);
    expect(evaluateAlert({ ...base, prefs, now: new Date(2026, 0, 1, 3, 0) })).toBe(false);
    expect(evaluateAlert({ ...base, prefs: { ...prefs, confidence: "high" }, now: new Date(2026, 0, 1, 22, 0) })).toBe(false);
    expect(evaluateAlert({ ...base, score: 40, prefs, now: new Date(2026, 0, 1, 22, 0) })).toBe(false);
  });
});
