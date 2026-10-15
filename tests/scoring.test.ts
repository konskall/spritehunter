import { describe, expect, it } from "vitest";
import type { CandidateScoreInput, CgLightning, ObservedLightning } from "@/lib/domain";
import { scoreOpportunity } from "@/lib/scoring";

// Dark, clear night, storm at a good distance: only the parameter under test changes.
const base: CandidateScoreInput = {
  capeJkg: 300, precipitationMm: 1, thunderCode: false, observerCloudPercent: 5, observerHighCloudPercent: 5, visibilityM: 30_000,
  distanceKm: 250, sunAltitudeDeg: -30, moonInterference: false, lightning: "not_configured",
};
const mcs: ObservedLightning = { observedAt: "2026-11-09T22:10:00.000Z", ageMinutes: 15, areaKm2: 9_000, maxFlashesPer5Min: 20, frames: 3, windowMinutes: 15 };
const observed = (detail: ObservedLightning = mcs): Partial<CandidateScoreInput> => ({ lightning: "observed", observedLightning: detail });
const cg = (overrides: Partial<CgLightning>): CgLightning => ({
  windowMinutes: 15, cgCount: 20, positiveCount: 0, negativeCount: 20, maxPositiveKa: null, maxNegativeKa: 30, retrievedAt: "2026-11-09T22:20:00.000Z", ...overrides,
});

describe("the sky at the observer limits the score", () => {
  it("keeps a real storm out of the promising range under an overcast sky", () => {
    const clear = scoreOpportunity({ ...base, ...observed(), terrain: "clear" });
    const overcast = scoreOpportunity({ ...base, ...observed(), observerCloudPercent: 100, observerHighCloudPercent: 100, terrain: "clear" });
    expect(clear.total).toBeGreaterThanOrEqual(85);
    expect(overcast.total).toBeLessThanOrEqual(29);
    expect(overcast.limitations.some((text) => text.en.includes("overcast"))).toBe(true);
  });

  it("lowers the ceiling step by step as the cloud closes in", () => {
    // Blocking cloud 80 %: halfway between no ceiling (70 %) and 29 (90 %).
    const broken = scoreOpportunity({ ...base, ...observed(), observerCloudPercent: 80, observerHighCloudPercent: 80, terrain: "clear" });
    expect(broken.total).toBeLessThanOrEqual(49);
    expect(broken.total).toBeGreaterThan(29);
  });

  it("counts cloud along the line of sight towards the target", () => {
    const pathClear = scoreOpportunity({ ...base, ...observed(), pathCloudPercent: 0, terrain: "clear" });
    const pathCloudy = scoreOpportunity({ ...base, ...observed(), pathCloudPercent: 95, terrain: "clear" });
    expect(pathCloudy.atmosphere).toBeLessThan(pathClear.atmosphere);
    expect(pathCloudy.total).toBeLessThanOrEqual(29);
    expect(pathCloudy.limitations.some((text) => text.en.includes("line of sight"))).toBe(true);
  });
});

describe("forecast targets", () => {
  it("scores a forecast cell that MTG-LI sees no lightning near as low", () => {
    const contradicted = scoreOpportunity({ ...base, capeJkg: 1_200, precipitationMm: 4, thunderCode: true, lightning: "not_detected", terrain: "clear" });
    expect(contradicted.total).toBeLessThanOrEqual(49);
  });

  it("ranks forecast targets by their storm signal instead of capping them all at 69", () => {
    // With a clear sky, verified terrain and a good distance, both used to hit the 69 cap.
    const strong = scoreOpportunity({ ...base, distanceKm: 300, capeJkg: 800, precipitationMm: 4, thunderCode: true, terrain: "clear" });
    const moderate = scoreOpportunity({ ...base, distanceKm: 300, capeJkg: 600, precipitationMm: 1.5, terrain: "clear" });
    expect(strong.total).toBeLessThanOrEqual(69);
    expect(strong.total).toBeGreaterThan(moderate.total);
  });

  it("weighs model rain and thunder above dry instability", () => {
    // Verified Oct 2025–Feb 2026: cells with rain and CAPE 250–600 had lightning nearby 44–58 % of
    // the time, cells with CAPE ≥ 1,000 and no rain 12 %.
    const rainy = scoreOpportunity({ ...base, capeJkg: 300, precipitationMm: 2, terrain: "unknown" });
    const dry = scoreOpportunity({ ...base, capeJkg: 2_000, precipitationMm: 0, terrain: "unknown" });
    expect(rainy.activity).toBeGreaterThan(dry.activity);
    const thunder = scoreOpportunity({ ...base, capeJkg: 300, precipitationMm: 2, thunderCode: true, terrain: "unknown" });
    expect(thunder.activity).toBeGreaterThan(rainy.activity);
  });
});

describe("distance", () => {
  it("prefers a close storm, where sprites are brighter and higher, over a distant one", () => {
    const close = scoreOpportunity({ ...base, ...observed(), distanceKm: 150, terrain: "clear" });
    const far = scoreOpportunity({ ...base, ...observed(), distanceKm: 500, terrain: "clear" });
    expect(close.distance).toBeGreaterThan(far.distance);
  });
});

describe("observed storms", () => {
  it("bases an observed storm's activity on its lightning more than on the nearest model cell", () => {
    const small: ObservedLightning = { ...mcs, areaKm2: 300, maxFlashesPer5Min: 3, frames: 2 };
    const wetModel = scoreOpportunity({ ...base, capeJkg: 2_000, precipitationMm: 6, thunderCode: true, ...observed(small), terrain: "unknown" });
    const noModel = scoreOpportunity({ ...base, capeJkg: null, precipitationMm: null, ...observed(small), terrain: "unknown" });
    expect(Math.abs(wetModel.activity - noModel.activity)).toBeLessThanOrEqual(5);
    const large = scoreOpportunity({ ...base, capeJkg: null, precipitationMm: null, ...observed(), terrain: "unknown" });
    expect(large.activity - noModel.activity).toBeGreaterThanOrEqual(6);
  });

  it("does not credit positive strokes too weak to be ground strokes", () => {
    const weakPositive = scoreOpportunity({ ...base, ...observed({ ...mcs, cg: cg({ positiveCount: 1, maxPositiveKa: 6 }) }), terrain: "unknown" });
    const negativeOnly = scoreOpportunity({ ...base, ...observed({ ...mcs, cg: cg({}) }), terrain: "unknown" });
    expect(weakPositive.activity).toBe(negativeOnly.activity);
    expect(weakPositive.limitations.some((text) => text.en.includes("15 kA"))).toBe(true);
  });

  it("credits a moderate positive stroke, and a strong one more", () => {
    const negativeOnly = scoreOpportunity({ ...base, ...observed({ ...mcs, cg: cg({}) }), terrain: "unknown" });
    const moderate = scoreOpportunity({ ...base, ...observed({ ...mcs, cg: cg({ positiveCount: 2, maxPositiveKa: 32 }) }), terrain: "unknown" });
    const strong = scoreOpportunity({ ...base, ...observed({ ...mcs, cg: cg({ positiveCount: 2, maxPositiveKa: 85 }) }), terrain: "unknown" });
    expect(moderate.activity).toBeGreaterThan(negativeOnly.activity);
    expect(strong.activity).toBeGreaterThan(moderate.activity);
  });

  it("notes a very strong negative stroke as a sign of ELVES and halos", () => {
    const ordinary = scoreOpportunity({ ...base, ...observed({ ...mcs, cg: cg({ maxNegativeKa: 40 }) }), terrain: "unknown" });
    const intense = scoreOpportunity({ ...base, ...observed({ ...mcs, cg: cg({ maxNegativeKa: 140 }) }), terrain: "unknown" });
    expect(intense.activity).toBeGreaterThan(ordinary.activity);
    expect(intense.reasons.some((text) => text.en.includes("ELVES"))).toBe(true);
  });
});
