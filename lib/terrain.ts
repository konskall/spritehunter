import type { PointingAltitude, TerrainProfile, TerrainStatus } from "@/lib/domain";

export function terrainVisibility(profile: TerrainProfile | null, envelope: PointingAltitude[]) {
  if (!profile || profile.status !== "available" || profile.horizonAngleDeg == null) {
    return { status: "unknown" as const, visibleAltitudesKm: [] as number[], clearanceDeg: null };
  }
  const visible = envelope.filter((point) => point.elevationDeg > profile.horizonAngleDeg!);
  const minTarget = Math.min(...envelope.map((point) => point.elevationDeg));
  const maxTarget = Math.max(...envelope.map((point) => point.elevationDeg));
  const status: TerrainStatus = visible.length === 0 ? "blocked" : visible.length === envelope.length ? "clear" : "partial";
  return {
    status,
    visibleAltitudesKm: visible.map((point) => point.altitudeKm),
    clearanceDeg: Math.round((maxTarget - profile.horizonAngleDeg) * 10) / 10,
    lowerClearanceDeg: Math.round((minTarget - profile.horizonAngleDeg) * 10) / 10,
  };
}


/**
 * Terrain profiles are requested per whole degree: a 0.5° offset moves the profile by
 * ~1 km at 120 km, while a moving storm would otherwise spend the shared DEM quota on
 * every refresh.
 */
export function terrainBearingKey(bearingDeg: number) {
  const rounded = Math.round(bearingDeg) % 360;
  return rounded < 0 ? rounded + 360 : rounded;
}
