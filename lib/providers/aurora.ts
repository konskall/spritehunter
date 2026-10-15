import type { AuroraResponse } from "@/lib/domain";
import { tx } from "@/lib/i18n";

export type OvationPoint = [longitude: number, latitude: number, probability: number];

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Validates the ~65k OVATION tuples with a plain loop; per-element zod parsing cost ~90 ms of CPU. */
export function parseOvationCoordinates(raw: unknown): OvationPoint[] {
  const coordinates = (raw as { coordinates?: unknown } | null)?.coordinates;
  if (!Array.isArray(coordinates)) throw new Error("OVATION response has no coordinate array.");
  for (const point of coordinates) {
    if (!Array.isArray(point) || point.length < 3 || !isFiniteNumber(point[0]) || !isFiniteNumber(point[1]) || !isFiniteNumber(point[2])) {
      throw new Error("OVATION response contains a malformed coordinate.");
    }
  }
  return coordinates as OvationPoint[];
}

function longitudeDifference(a: number, b: number) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

// Aurora ~300 km up stands ≥3° above the horizon out to ~1,600 km (it sets at ~1,900 km).
// The OVATION oval beyond that, usually over Lapland, cannot be seen from Greece at all.
const VISIBLE_RANGE_KM = 1_600;
// OVATION gives the chance of aurora overhead; ≥10 % near the edge of view is a real chance of a glow low in the north.
const VISIBLE_PROBABILITY = 10;
const EARTH_RADIUS_KM = 6_371;
const toRad = (degrees: number) => (degrees * Math.PI) / 180;

function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const h = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function assessAurora(kp: number | null, coordinates: OvationPoint[], latitude: number, longitude: number) {
  let local: number | null = null;
  let northern: number | null = null;
  const maxLatitudeOffset = VISIBLE_RANGE_KM / 111;
  for (const [pointLon, pointLat, probability] of coordinates) {
    const lonDiff = longitudeDifference(pointLon, longitude);
    if (Math.abs(pointLat - latitude) <= 2 && lonDiff <= 3) local = Math.max(local ?? 0, probability);
    if (pointLat >= latitude && pointLat - latitude <= maxLatitudeOffset && greatCircleKm(latitude, longitude, pointLat, pointLon) <= VISIBLE_RANGE_KM) {
      northern = Math.max(northern ?? 0, probability);
    }
  }
  const level: AuroraResponse["level"] = kp == null
    ? "unknown"
    : kp >= 8 || (local ?? 0) >= 10
      ? "strong"
      : kp >= 7 || (northern ?? 0) >= VISIBLE_PROBABILITY
        ? "possible"
        : kp >= 5
          ? "elevated"
          : "quiet";
  const message = level === "strong"
    ? tx("Ισχυρή γεωμαγνητική δραστηριότητα. Έλεγξε τον σκοτεινό βόρειο ορίζοντα, χωρίς εγγύηση ορατότητας.", "Strong geomagnetic activity. Check the dark northern horizon; visibility is not guaranteed.")
    : level === "possible"
      ? tx("Υπάρχει ένδειξη αυξημένης δραστηριότητας βόρεια. Η Ελλάδα παραμένει οριακή τοποθεσία.", "There are signs of increased activity to the north. Greece remains a marginal location.")
      : level === "elevated"
        ? tx("Αυξημένη δραστηριότητα, αλλά συνήθως ανεπαρκής για φωτογραφικό σέλας από την Ελλάδα.", "Elevated activity, but usually not enough for a photographic aurora from Greece.")
        : tx("Δεν υπάρχει τώρα αξιόπιστη ένδειξη σέλαος για τη θέση παρατήρησης.", "No reliable sign of aurora for the observing site right now.");
  return { localProbabilityPercent: local, northernSectorProbabilityPercent: northern, level, message };
}
