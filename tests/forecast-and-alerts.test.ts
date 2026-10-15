import { describe, expect, it } from "vitest";
import type { AviationObservation, WeatherHour } from "@/lib/domain";
import { buildCandidate, dropNearbyForecasts, screeningGrid } from "@/lib/providers/open-meteo";
import { pathCloudPercent, pathSampleGrid } from "@/lib/line-of-sight";
import type { StormCandidate } from "@/lib/domain";
import { destinationPoint, inverseGeodesic } from "@/lib/geodesy";
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
    retrievedAt: "2026-07-15T22:05:00.000Z", visibilityM: 10_000, visibilityAtLeast: false, cloudCoverPercent: 0, cloudSummary: { el: "CAVOK", en: "CAVOK" },
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

  it("treats a METAR '10 km or more' as a minimum, not a cap on a clearer forecast", () => {
    const payload = targetPayload({ 22: { cape: 900, precipitation: 1, code: 95 } });
    const candidate = buildCandidate(sparta, payload, observerHours(10, 10, 30_000), metar({ visibilityAtLeast: true }), "2026-07-15T00:00:00Z", start);
    // Forecast 30 km stands: 20·(1 − 0.10) + 10 = 28, not 20·0.9 + 10·(10 000/30 000) ≈ 21.
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

  it("does not let a CAVOK report hide a mid-level cloud deck the METAR cannot see", () => {
    // European METARs report cloud below ~1,500 m only: CAVOK says nothing about altostratus.
    const payload = targetPayload({ 22: { cape: 900, precipitation: 1, code: 95 } });
    const hours = observerHours(80, 0, 30_000).map((hour) => ({ ...hour, cloudCoverMid: 80 }));
    const candidate = buildCandidate(sparta, payload, hours, metar({}), "2026-07-15T00:00:00Z", start)!;
    expect(candidate.scoreInput.observerCloudPercent).toBe(80);
    // Blocking 80·0.85 = 68 → 20·0.32 + 10·(10 000/30 000) ≈ 10.
    expect(candidate.score.atmosphere).toBe(10);
  });

  it("skips hours with instability but neither rain nor a thunderstorm code", () => {
    const payload = targetPayload({ 22: { cape: 1_500, precipitation: 0, code: 0 } });
    expect(buildCandidate(sparta, payload, observerHours(0, 0, 30_000), noMetar, "2026-07-15T00:00:00Z", start)).toBeNull();
  });

  it("keeps a rainy hour with modest instability", () => {
    // Cells with 0.2–1 mm of rain and CAPE 100–250 J/kg had lightning nearby 35 % of the time.
    const payload = targetPayload({ 22: { cape: 150, precipitation: 0.5, code: 61 } });
    expect(buildCandidate(sparta, payload, observerHours(0, 0, 30_000), noMetar, "2026-07-15T00:00:00Z", start)?.forecastValidAt).toBe("2026-07-15T22:00Z");
  });

  it("marks a forecast target with the location error the verification found", () => {
    // Forecast cells that had lightning nearby were 52 km from the storm centre at the median, 74 km at the 75th percentile.
    const payload = targetPayload({ 22: { cape: 900, precipitation: 1, code: 95 } });
    const candidate = buildCandidate(sparta, payload, observerHours(0, 0, 30_000), noMetar, "2026-07-15T00:00:00Z", start)!;
    expect(candidate.uncertaintyKm).toBeGreaterThanOrEqual(75);
  });

  it("lowers the sky score for cloud along the line of sight towards the target", () => {
    const payload = targetPayload({ 22: { cape: 900, precipitation: 1, code: 95 } });
    const clearSite = observerHours(0, 0, 30_000);
    // A cloud deck 40–90 km out in every direction, where a low view towards the storm crosses it.
    const deck = pathSampleGrid(sparta).map((sample) => ({ ...sample, hours: clearSite.map((hour) => ({ ...hour, cloudCoverMid: 95, cloudCoverHigh: 95 })) }));
    const without = buildCandidate(sparta, payload, clearSite, noMetar, "2026-07-15T00:00:00Z", start)!;
    const withDeck = buildCandidate(sparta, payload, clearSite, noMetar, "2026-07-15T00:00:00Z", start, null, deck)!;
    expect(withDeck.scoreInput.pathCloudPercent).toBe(95);
    expect(withDeck.score.atmosphere).toBeLessThan(without.score.atmosphere);
  });

  it("ignores a stale METAR", () => {
    const payload = targetPayload({ 22: { cape: 900, precipitation: 1, code: 95 } });
    const candidate = buildCandidate(sparta, payload, observerHours(10, 10, 30_000), metar({ status: "stale", cloudCoverPercent: 100, visibilityM: 1_000 }), "2026-07-15T00:00:00Z", start);
    expect(candidate!.score.atmosphere).toBe(28);
  });
});

describe("forecast scan grid", () => {
  it("samples every 15° and every 100 km, so storms between the old 45° spokes are not missed", () => {
    // Verified Oct 2025–Feb 2026 (200–600 km): 24 cells had a target near 27 % of the large storms, this grid 76 %.
    const grid = screeningGrid(sparta, 200, 600).map((point) => inverseGeodesic(sparta, point));
    expect(grid).toHaveLength(96);
    expect([...new Set(grid.map((g) => Math.round(g.distanceM / 1000)))].sort((a, b) => a - b)).toEqual([250, 350, 450, 550]);
    expect(new Set(grid.map((g) => Math.round(g.initialBearingDeg) % 360)).size).toBe(24);
    expect(grid.every((g) => Math.round(g.initialBearingDeg) % 15 === 0)).toBe(true);
    expect(screeningGrid(sparta, 100, 600)).toHaveLength(120);
  });
});

describe("duplicate forecast targets", () => {
  const target = (id: string, distanceKm: number, bearingDeg: number, validAt: string, total: number) =>
    ({ id, source: "forecast", coordinates: destinationPoint(sparta, distanceKm, bearingDeg), forecastValidAt: validAt, score: { total } }) as unknown as StormCandidate;

  it("keeps the best of neighbouring cells that show the same storm, and storms elsewhere or later", () => {
    const best = target("best", 300, 90, "2026-07-15T22:00Z", 60);
    const neighbour = target("neighbour", 300, 101, "2026-07-15T23:00Z", 55); // ~58 km away, 1 h later
    const elsewhere = target("elsewhere", 300, 150, "2026-07-15T22:00Z", 50);
    const nextDay = target("next-day", 300, 101, "2026-07-16T20:00Z", 45);
    expect(dropNearbyForecasts([neighbour, elsewhere, best, nextDay]).map((candidate) => candidate.id)).toEqual(["best", "elsewhere", "next-day"]);
  });
});

describe("cloud along the line of sight", () => {
  const time = "2026-07-15T22:00Z";
  const sample = (bearingDeg: number, distanceKm: number, low: number, mid: number, high: number) => ({
    bearingDeg, distanceKm, hours: [{ ...observerHours(0, 0, 30_000)[22], cloudCoverLow: low, cloudCoverMid: mid, cloudCoverHigh: high }],
  });

  it("takes the layer the view crosses at each distance", () => {
    // At 8° the view is ~5.8 km up 40 km out (mid layer) and ~13 km up 90 km out (above the cloud).
    expect(pathCloudPercent([sample(90, 40, 100, 0, 0), sample(90, 90, 100, 0, 100)], 90, 8, time)).toBe(0);
    expect(pathCloudPercent([sample(90, 40, 0, 85, 0), sample(90, 90, 0, 0, 0)], 90, 8, time)).toBe(85);
    // At 2° it is ~1.5 km up 40 km out (low layer) and ~3.8 km 90 km out (mid layer).
    expect(pathCloudPercent([sample(90, 40, 70, 0, 0), sample(90, 90, 0, 40, 0)], 90, 2, time)).toBe(70);
    // At 25° it clears every layer within 40 km.
    expect(pathCloudPercent([sample(90, 40, 100, 100, 100), sample(90, 90, 100, 100, 100)], 90, 25, time)).toBe(0);
  });

  it("uses the samples nearest the target's bearing", () => {
    const samples = [sample(0, 40, 0, 90, 0), sample(30, 40, 0, 10, 0)];
    expect(pathCloudPercent(samples, 25, 8, time)).toBe(10);
    expect(pathCloudPercent([], 25, 8, time)).toBeNull();
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
