import type { AuroraResponse } from "@/lib/domain";

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

export function assessAurora(kp: number | null, coordinates: OvationPoint[], latitude: number, longitude: number) {
  let local: number | null = null;
  let northern: number | null = null;
  for (const [pointLon, pointLat, probability] of coordinates) {
    const lonDiff = longitudeDifference(pointLon, longitude);
    if (Math.abs(pointLat - latitude) <= 2 && lonDiff <= 3) local = Math.max(local ?? 0, probability);
    if (pointLat >= latitude && pointLat <= Math.min(90, latitude + 35) && lonDiff <= 18) northern = Math.max(northern ?? 0, probability);
  }
  const level: AuroraResponse["level"] = kp == null
    ? "unknown"
    : kp >= 8 || (local ?? 0) >= 10
      ? "strong"
      : kp >= 7 || (northern ?? 0) >= 20
        ? "possible"
        : kp >= 5
          ? "elevated"
          : "quiet";
  const message = level === "strong"
    ? "Ισχυρή γεωμαγνητική δραστηριότητα. Έλεγξε τον σκοτεινό βόρειο ορίζοντα, χωρίς εγγύηση ορατότητας."
    : level === "possible"
      ? "Υπάρχει ένδειξη αυξημένης δραστηριότητας βόρεια. Η Ελλάδα παραμένει οριακή τοποθεσία."
      : level === "elevated"
        ? "Αυξημένη δραστηριότητα, αλλά συνήθως ανεπαρκής για φωτογραφικό σέλας από την Ελλάδα."
        : "Δεν υπάρχει τώρα αξιόπιστη ένδειξη σέλαος για τη θέση παρατήρησης.";
  return { localProbabilityPercent: local, northernSectorProbabilityPercent: northern, level, message };
}
