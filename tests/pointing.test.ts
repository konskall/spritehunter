import { describe, expect, it } from "vitest";
import { destinationPoint } from "@/lib/geodesy";
import { elevationSpan, jetEnvelope } from "@/lib/pointing";

// Reference values from a sphere with the local Gaussian radius, not the app's ECEF code.
const athens = { latitude: 37.98, longitude: 23.73, elevationM: 210 };

describe("elevations to frame", () => {
  it("widens the vertical band by the uncertainty in the storm's distance", () => {
    // 300 ± 60 km: sprite bottoms (50 km) as low as from 360 km, tops (90 km) as high as from 240 km.
    const span = elevationSpan(athens, { bearingDeg: 0, distanceKm: 300, uncertaintyKm: 60 });
    expect(span.lowDeg).toBeCloseTo(6.22, 1);
    expect(span.highDeg).toBeCloseTo(19.3, 1);
  });

  it("matches the plain 50–90 km band when the distance is certain", () => {
    const span = elevationSpan(athens, { bearingDeg: 0, distanceKm: 300, uncertaintyKm: 0 });
    expect(span.lowDeg).toBeCloseTo(8.04, 1);
    expect(span.highDeg).toBeCloseTo(15.2, 1);
  });
});

describe("blue and gigantic jets", () => {
  it("places jets between the cloud top (15 km) and 50 km", () => {
    const close = jetEnvelope(athens, destinationPoint(athens, 150, 0));
    expect(close[0].altitudeKm).toBe(15);
    expect(close[0].elevationDeg).toBeCloseTo(4.95, 1);
    expect(close.at(-1)!.altitudeKm).toBe(50);
    expect(close.at(-1)!.elevationDeg).toBeCloseTo(17.62, 1);
    // 450 km away the cloud top, where jets start, is already below the horizon.
    expect(jetEnvelope(athens, destinationPoint(athens, 450, 0))[0].elevationDeg).toBeLessThan(0);
  });
});
