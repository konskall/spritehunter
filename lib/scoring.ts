import type { CandidateScoreInput, ScoreBreakdown, TerrainStatus } from "@/lib/domain";
import { darknessScore } from "@/lib/astronomy";

type ScoreInput = CandidateScoreInput & { terrain: TerrainStatus };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function scoreOpportunity(input: ScoreInput): ScoreBreakdown {
  const reasons: string[] = [];
  const limitations: string[] = [];
  const cape = input.capeJkg ?? 0;
  const precipitation = input.precipitationMm ?? 0;
  const cin = input.convectiveInhibitionJkg ?? 0;
  const liftedIndex = input.liftedIndex ?? 0;
  const precipitableWater = input.precipitableWaterKgM2 ?? 20;
  let activity = clamp(cape / 100, 0, 15)
    + clamp(precipitation * 1.5, 0, 4)
    + (input.thunderCode ? 4 : 0)
    + clamp(-liftedIndex, 0, 3)
    + clamp((precipitableWater - 24) / 4, 0, 2)
    - clamp((cin - 75) / 35, 0, 4);
  const lightningPotential = input.lightningPotentialJkg ?? 0;
  activity += clamp(lightningPotential / 90, 0, 5);
  activity = Math.max(0, activity);
  if (input.lightning === "observed") activity = clamp(activity + 8, 0, 35);
  else {
    activity = Math.min(activity, 27);
    limitations.push("Δεν υπάρχουν πραγματικές παρατηρήσεις κεραυνών· ο στόχος είναι μόνο προγνωστικός.");
  }

  if (cape >= 800) reasons.push("Ισχυρό προγνωστικό σήμα αστάθειας (CAPE).");
  else if (cape >= 300) reasons.push("Μέτριο προγνωστικό σήμα αστάθειας.");
  if (lightningPotential >= 100) reasons.push("Το αριθμητικό μοντέλο δείχνει αυξημένο προγνωστικό lightning potential.");
  if (liftedIndex <= -2) reasons.push("Αρνητικός Lifted Index ενισχύει το προγνωστικό σήμα αστάθειας.");
  if (cin >= 150) limitations.push("Ισχυρή convective inhibition μπορεί να καταστείλει την ανάπτυξη καταιγίδων.");

  const cloud = input.observerCloudPercent ?? 65;
  const highCloud = input.observerHighCloudPercent ?? cloud;
  const visibility = input.visibilityM ?? 10_000;
  const blockingCloud = Math.max(highCloud, cloud * 0.85);
  const atmosphere = clamp(20 * (1 - blockingCloud / 100) + 10 * (visibility / 30_000), 0, 30);
  if (input.atmosphereSource === "observation") reasons.push("Η τοπική νέφωση και ορατότητα προέρχονται από πρόσφατη πραγματική παρατήρηση METAR.");
  if (highCloud < 25) reasons.push("Λίγες υψηλές νεφώσεις στη θέση παρατήρησης.");
  if (highCloud > 70) limitations.push("Οι υψηλές νεφώσεις μπορεί να κρύψουν την ανώτερη ατμόσφαιρα.");

  let terrain = 5;
  if (input.terrain === "clear") terrain = 20;
  if (input.terrain === "partial") terrain = 10;
  if (input.terrain === "blocked") terrain = 0;
  if (input.terrain === "unknown") limitations.push("Η ορατότητα εδάφους δεν έχει ακόμη επαληθευτεί με DEM.");

  const distance = input.distanceKm;
  const distanceScore =
    distance < 100 ? 0 : distance <= 250 ? 6 : distance <= 550 ? 10 : distance <= 700 ? 7 : 3;
  if (distance >= 200 && distance <= 600) reasons.push("Η απόσταση είναι πρακτική για μακρινή φωτογράφιση.");

  const darkness = darknessScore(input.sunAltitudeDeg, input.moonInterference);
  if (darkness >= 4.5) reasons.push("Επικρατεί αστρονομικό σκοτάδι.");
  if (input.moonInterference) limitations.push("Η Σελήνη βρίσκεται κοντά στον προτεινόμενο τομέα λήψης.");

  let total = Math.round(activity + atmosphere + terrain + distanceScore + darkness);
  if (input.lightning !== "observed") total = Math.min(total, 69);
  if (input.terrain === "blocked" || input.sunAltitudeDeg > -6 || distance < 80) total = Math.min(total, 29);

  const confidence =
    input.lightning === "observed" && input.terrain !== "unknown"
      ? "high"
      : input.terrain !== "unknown"
        ? "medium"
        : "low";
  const category =
    total >= 85 ? "very_promising" : total >= 70 ? "promising" : total >= 50 ? "possible" : total >= 30 ? "low" : "poor";

  return {
    activity: Math.round(activity),
    atmosphere: Math.round(atmosphere),
    terrain,
    distance: distanceScore,
    darkness: Math.round(darkness * 10) / 10,
    total,
    confidence,
    category,
    reasons,
    limitations,
  };
}

/** Re-score a candidate once the DEM line-of-sight check for its bearing is known. */
export function rescoreWithTerrain(input: CandidateScoreInput, terrain: TerrainStatus) {
  return scoreOpportunity({ ...input, terrain });
}
