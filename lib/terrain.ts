import type { PointingAltitude, TerrainProfile } from "@/lib/domain";

export function terrainVisibility(profile: TerrainProfile | null, envelope: PointingAltitude[]) {
  if (!profile || profile.status !== "available" || profile.horizonAngleDeg == null) {
    return { status: "unknown" as const, visibleAltitudesKm: [] as number[], clearanceDeg: null };
  }
  const visible = envelope.filter((point) => point.elevationDeg > profile.horizonAngleDeg!);
  const minTarget = Math.min(...envelope.map((point) => point.elevationDeg));
  const maxTarget = Math.max(...envelope.map((point) => point.elevationDeg));
  const status = visible.length === 0 ? "blocked" : visible.length === envelope.length ? "clear" : "partial";
  return {
    status,
    visibleAltitudesKm: visible.map((point) => point.altitudeKm),
    clearanceDeg: Math.round((maxTarget - profile.horizonAngleDeg) * 10) / 10,
    lowerClearanceDeg: Math.round((minTarget - profile.horizonAngleDeg) * 10) / 10,
  };
}

