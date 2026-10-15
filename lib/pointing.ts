import type { Coordinates, PointingAltitude } from "@/lib/domain";
import { altitudeEnvelope, destinationPoint, lookAngles } from "@/lib/geodesy";

// Sprites span roughly 50–90 km; blue and gigantic jets rise from the cloud top (~15 km) to ~50 km.
const SPRITE_BOTTOM_M = 50_000;
const SPRITE_TOP_M = 90_000;
export const JET_ALTITUDES_KM = [15, 20, 30, 40, 50];
// The near edge never comes closer than this, so a large uncertainty cannot put it overhead.
const NEAREST_KM = 30;

/**
 * The elevations a frame must cover when the storm may be `uncertaintyKm` nearer or farther:
 * sprite bottoms seen from the far edge, sprite tops from the near edge.
 */
export function elevationSpan(observer: Coordinates, target: { bearingDeg: number; distanceKm: number; uncertaintyKm: number }) {
  const far = destinationPoint(observer, target.distanceKm + target.uncertaintyKm, target.bearingDeg);
  const near = destinationPoint(observer, Math.max(NEAREST_KM, target.distanceKm - target.uncertaintyKm), target.bearingDeg);
  return {
    lowDeg: lookAngles(observer, { ...far, elevationM: SPRITE_BOTTOM_M }).elevationDeg,
    highDeg: lookAngles(observer, { ...near, elevationM: SPRITE_TOP_M }).elevationDeg,
  };
}

/** Where blue and gigantic jets would appear above the storm: from the cloud top up to 50 km. */
export function jetEnvelope(observer: Coordinates, target: Coordinates): PointingAltitude[] {
  return altitudeEnvelope(observer, target, JET_ALTITUDES_KM);
}
