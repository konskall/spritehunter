import type { StormCandidate } from "@/lib/domain";
import { inverseGeodesic } from "@/lib/geodesy";

// A storm or forecast cell that moved less than this between refreshes is the same target.
const FOLLOW_KM = 80;

/** Keeps the user's target across refreshes: the same id, else the nearest target of the same kind. */
export function followSelection(
  previous: Pick<StormCandidate, "id" | "source" | "coordinates"> | null,
  next: StormCandidate[],
): string | null {
  if (!next.length) return null;
  if (!previous) return next[0].id;
  if (next.some((candidate) => candidate.id === previous.id)) return previous.id;
  const nearest = next
    .filter((candidate) => candidate.source === previous.source)
    .map((candidate) => ({ candidate, distanceKm: inverseGeodesic(previous.coordinates, candidate.coordinates).distanceM / 1000 }))
    .sort((a, b) => a.distanceKm - b.distanceKm)[0];
  return nearest && nearest.distanceKm <= FOLLOW_KM ? nearest.candidate.id : next[0].id;
}
