import { describe, expect, it } from "vitest";
import {
  altitudeEnvelope,
  apparentTerrainAngle,
  destinationPoint,
  geodeticToEcef,
  inverseGeodesic,
  lookAngles,
} from "@/lib/geodesy";
import { CANON_750D, DEFAULT_LENSES, effectiveMaxAperture, fieldOfView, framingAssessment } from "@/lib/camera";
import { scoreOpportunity } from "@/lib/scoring";
import { terrainVisibility } from "@/lib/terrain";
import { shouldNotify } from "@/lib/notifications";
import { clusterLightning, deduplicateLightning, estimateMotion } from "@/lib/storm-detection";
import { athensUtcOffsetMinutes, dataFreshness } from "@/lib/time";
import { skyState } from "@/lib/astronomy";

const sparta = { latitude: 37.075, longitude: 22.43, elevationM: 210 };

describe("WGS84 geodesy and pointing", () => {
  it("returns the WGS84 semi-major axis at the equator", () => {
    const ecef = geodeticToEcef({ latitude: 0, longitude: 0, elevationM: 0 });
    expect(ecef.x).toBeCloseTo(6_378_137, 3);
    expect(ecef.y).toBeCloseTo(0, 6);
    expect(ecef.z).toBeCloseTo(0, 6);
  });

  it("calculates a realistic Sparta-to-Athens distance and bearing", () => {
    const result = inverseGeodesic(sparta, { latitude: 37.9838, longitude: 23.7275 });
    expect(result.distanceM / 1000).toBeGreaterThan(140);
    expect(result.distanceM / 1000).toBeLessThan(180);
    expect(result.initialBearingDeg).toBeGreaterThan(35);
    expect(result.initialBearingDeg).toBeLessThan(60);
  });

  it("round-trips a spherical destination over long range", () => {
    const target = destinationPoint(sparta, 500, 180);
    const inverse = inverseGeodesic(sparta, target);
    expect(inverse.distanceM / 1000).toBeCloseTo(500, 0);
    expect(inverse.initialBearingDeg).toBeCloseTo(180, 0);
  });

  it("keeps high-altitude targets visible beyond the ground horizon", () => {
    const target = destinationPoint(sparta, 500, 210);
    const ground = lookAngles(sparta, { ...target, elevationM: 0 });
    const sprite = lookAngles(sparta, { ...target, elevationM: 90_000 });
    expect(ground.elevationDeg).toBeLessThan(0);
    expect(sprite.elevationDeg).toBeGreaterThan(0);
  });

  it("orders the TLE altitude envelope by apparent elevation", () => {
    const envelope = altitudeEnvelope(sparta, destinationPoint(sparta, 350, 150));
    expect(envelope).toHaveLength(5);
    expect(envelope[4].elevationDeg).toBeGreaterThan(envelope[0].elevationDeg);
  });

  it("accounts for curvature in terrain angles", () => {
    expect(apparentTerrainAngle(200, 200, 100)).toBeLessThan(0);
    expect(apparentTerrainAngle(200, 1_000, 5)).toBeGreaterThan(8);
  });
});

describe("terrain visibility", () => {
  const envelope = [
    { altitudeKm: 50, elevationDeg: 2, slantRangeKm: 400 },
    { altitudeKm: 70, elevationDeg: 5, slantRangeKm: 400 },
    { altitudeKm: 90, elevationDeg: 8, slantRangeKm: 400 },
  ];
  it("detects partial horizon visibility", () => {
    const result = terrainVisibility({ status: "available", provider: "test", bearingDeg: 0, observerElevationM: 200, horizonAngleDeg: 4, samples: [], retrievedAt: new Date().toISOString(), message: "" }, envelope);
    expect(result.status).toBe("partial");
    expect(result.visibleAltitudesKm).toEqual([70, 90]);
  });
  it("does not claim visibility when terrain data is absent", () => {
    expect(terrainVisibility(null, envelope).status).toBe("unknown");
  });
});

describe("camera framing", () => {
  it("loads the eight owned lenses in the equipment list", () => {
    expect(DEFAULT_LENSES).toHaveLength(8);
    expect(DEFAULT_LENSES.every((lens) => lens.owned)).toBe(true);
    expect(DEFAULT_LENSES.map((lens) => lens.id)).toContain("tokina-atxi-11-16");
  });
  it("calculates Canon 750D field of view", () => {
    const fov = fieldOfView(CANON_750D, 24);
    expect(fov.horizontalDeg).toBeCloseTo(49.8, 1);
    expect(fov.verticalDeg).toBeCloseTo(34.5, 1);
  });
  it("flags a narrow lens for a broad uncertainty sector", () => {
    const fov = fieldOfView(CANON_750D, 200);
    expect(framingAssessment(fov.horizontalDeg, fov.verticalDeg, 12, 2, 9).fits).toBe(false);
  });
  it("updates the working aperture estimate across a variable-aperture zoom", () => {
    const sigma = DEFAULT_LENSES.find((lens) => lens.id === "sigma-17-70-c013")!;
    expect(effectiveMaxAperture(sigma)).toBe(2.8);
    expect(effectiveMaxAperture({ ...sigma, focalLengthMm: 70 })).toBe(4);
  });
});

describe("astronomy, timezone, and freshness", () => {
  it("uses north-clockwise azimuths and valid lunar illumination", () => {
    const state = skyState(new Date("2026-06-21T22:00:00Z"), sparta.latitude, sparta.longitude, 180);
    expect(state.sunAzimuthDeg).toBeGreaterThanOrEqual(0);
    expect(state.sunAzimuthDeg).toBeLessThan(360);
    expect(state.moonIllumination).toBeGreaterThanOrEqual(0);
    expect(state.moonIllumination).toBeLessThanOrEqual(1);
  });
  it("handles Athens standard and daylight-saving offsets", () => {
    expect(athensUtcOffsetMinutes(new Date("2026-01-15T12:00:00Z"))).toBe(120);
    expect(athensUtcOffsetMinutes(new Date("2026-07-15T12:00:00Z"))).toBe(180);
  });
  it("distinguishes stale from unavailable data", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    expect(dataFreshness("2026-01-01T10:00:00Z", now, 30).status).toBe("stale");
    expect(dataFreshness(null, now).status).toBe("unavailable");
  });
});

describe("storm detection, scoring, and notification", () => {
  const events = [
    { id: "a", latitude: 35, longitude: 20, timestamp: "2026-01-01T00:00:00Z" },
    { id: "b", latitude: 35.02, longitude: 20.01, timestamp: "2026-01-01T00:01:00Z" },
    { id: "c", latitude: 35.01, longitude: 20.03, timestamp: "2026-01-01T00:02:00Z" },
    { id: "a", latitude: 35, longitude: 20, timestamp: "2026-01-01T00:00:00Z" },
  ];
  it("deduplicates events before clustering", () => {
    expect(deduplicateLightning(events)).toHaveLength(3);
    expect(clusterLightning(deduplicateLightning(events), 10, 3)).toHaveLength(1);
  });
  it("requires two track points for storm motion", () => {
    const motion = estimateMotion(
      { latitude: 35, longitude: 20, timestamp: "2026-01-01T00:00:00Z" },
      { latitude: 35.1, longitude: 20.1, timestamp: "2026-01-01T01:00:00Z" },
    );
    expect(motion?.speedKmh).toBeGreaterThan(10);
  });
  it("separates a heuristic score from data confidence", () => {
    const result = scoreOpportunity({ capeJkg: 1_500, precipitationMm: 8, thunderCode: true, observerCloudPercent: 5, observerHighCloudPercent: 5, visibilityM: 40_000, distanceKm: 400, sunAltitudeDeg: -25, moonInterference: false, terrain: "unknown", lightning: "not_configured" });
    expect(result.total).toBeLessThanOrEqual(69);
    expect(result.confidence).toBe("low");
    expect(result.limitations.length).toBeGreaterThan(0);
  });
  it("enforces notification cooldown unless score escalates", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    expect(shouldNotify("2026-01-01T11:50:00Z", now, 60, 60, 65, 60)).toBe(false);
    expect(shouldNotify("2026-01-01T11:50:00Z", now, 60, 60, 80, 60)).toBe(true);
  });
});
