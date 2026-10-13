import type { CandidateScoreInput, ObservedLightning, ScoreBreakdown, TerrainStatus } from "@/lib/domain";
import { darknessScore } from "@/lib/astronomy";
import { tx, type Localized } from "@/lib/i18n";

type ScoreInput = CandidateScoreInput & { terrain: TerrainStatus };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

// Sprite-producing strokes are mostly positive CG; peak currents of +50 kA and more are
// common among them, so such a stroke is the strongest real-time sign a target has.
const STRONG_POSITIVE_KA = 50;
// Activity points that only positive CG strokes can earn once Xweather data is known.
const CG_ACTIVITY_SHARE = 8;

/**
 * Activity added by observed lightning (6–19). Sprites come mostly from large,
 * long-lived storm systems, so lit area and persistence count more than one hot pixel.
 */
function observedActivityBonus(detail: ObservedLightning | null | undefined) {
  if (!detail) return 8;
  return 6
    + clamp(4 * Math.log10(detail.areaKm2 / 50), 0, 10)
    + (detail.maxFlashesPer5Min >= 10 ? 2 : 0)
    + (detail.frames >= 2 ? 1 : 0);
}

export function scoreOpportunity(input: ScoreInput): ScoreBreakdown {
  const reasons: Localized[] = [];
  const limitations: Localized[] = [];
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
  const observed = input.lightning === "observed";
  if (observed) {
    // No model cell near an observed storm is missing context, not evidence against it.
    const modelActivity = input.capeJkg == null ? 8 : activity;
    if (input.capeJkg == null) limitations.push(tx("Δεν υπάρχει κοντινή κυψέλη μοντέλου· η αστάθεια της καταιγίδας δεν αξιολογήθηκε.", "No model cell near the storm, so its instability was not assessed."));
    activity = clamp(modelActivity + observedActivityBonus(input.observedLightning), 0, 35);
    const detail = input.observedLightning;
    const flashes = detail && (detail.maxFlashesPer5Min >= 20 ? "20+" : String(Math.round(detail.maxFlashesPer5Min)));
    reasons.push(detail
      ? tx(
        `Το MTG-LI κατέγραψε κεραυνούς σε ~${Math.round(detail.areaKm2).toLocaleString("el-GR")} km² (έως ${flashes} κεραυνοί/5′ ανά pixel, πριν από ${detail.ageMinutes}′).`,
        `MTG-LI recorded lightning over ~${Math.round(detail.areaKm2).toLocaleString("en-GB")} km² (up to ${flashes} flashes/5′ per pixel, ${detail.ageMinutes}′ ago).`,
      )
      : tx("Παρατηρημένοι κεραυνοί κοντά στον στόχο.", "Observed lightning near the target."));
    if (detail && detail.frames < 2) limitations.push(tx("Η κεραυνική δραστηριότητα εμφανίστηκε σε ένα μόνο 5λεπτο καρέ· μπορεί να είναι βραχύβια.", "Lightning appeared in a single 5-minute frame only; the storm may be short-lived."));
    const cg = detail?.cg;
    // Large storms already reach the activity maximum from MTG-LI alone. With CG polarity
    // known, the top of the scale is kept for positive strokes so it can rank them.
    if (cg) activity = Math.min(activity, 35 - CG_ACTIVITY_SHARE);
    if (cg && cg.positiveCount > 0) {
      const strong = (cg.maxPositiveKa ?? 0) >= STRONG_POSITIVE_KA;
      activity = clamp(activity + (strong ? CG_ACTIVITY_SHARE : CG_ACTIVITY_SHARE / 2), 0, 35);
      reasons.push(tx(
        `Xweather: ${cg.positiveCount} θετικοί κεραυνοί +CG τα τελευταία ${cg.windowMinutes}′${cg.maxPositiveKa != null ? ` (ισχυρότερος +${cg.maxPositiveKa} kA)` : ""}${strong ? " — οι ισχυροί +CG είναι ο κύριος εκκινητής των sprites." : "."}`,
        `Xweather: ${cg.positiveCount} positive +CG strokes in the last ${cg.windowMinutes}′${cg.maxPositiveKa != null ? ` (strongest +${cg.maxPositiveKa} kA)` : ""}${strong ? " — strong +CG strokes are the main trigger of sprites." : "."}`,
      ));
    } else if (cg && cg.cgCount > 0) {
      limitations.push(tx(
        `Xweather: μόνο αρνητικοί κεραυνοί CG τα τελευταία ${cg.windowMinutes}′· τα sprites προκαλούνται κυρίως από θετικούς.`,
        `Xweather: only negative CG strokes in the last ${cg.windowMinutes}′; sprites are triggered mostly by positive ones.`,
      ));
    } else if (cg) {
      limitations.push(tx(
        `Xweather: κανένας κεραυνός προς το έδαφος τα τελευταία ${cg.windowMinutes}′· η καταιγίδα έχει κυρίως ενδονεφικούς κεραυνούς.`,
        `Xweather: no cloud-to-ground strokes in the last ${cg.windowMinutes}′; the storm is mostly intra-cloud lightning.`,
      ));
    }
  } else if (input.lightning === "not_detected") {
    activity = Math.min(activity, 12);
    limitations.push(tx("Το MTG-LI δεν ανιχνεύει αυτή τη στιγμή κεραυνούς κοντά στον στόχο· η πρόγνωση δεν επιβεβαιώνεται.", "MTG-LI sees no lightning near the target right now, so the forecast is not confirmed."));
  } else {
    activity = Math.min(activity, 27);
    limitations.push(tx("Δεν υπάρχουν πραγματικές παρατηρήσεις κεραυνών· ο στόχος είναι μόνο προγνωστικός.", "No observed lightning; this target is a forecast only."));
  }

  if (cape >= 800) reasons.push(tx("Ισχυρό προγνωστικό σήμα αστάθειας (CAPE).", "Strong forecast instability signal (CAPE)."));
  else if (cape >= 300) reasons.push(tx("Μέτριο προγνωστικό σήμα αστάθειας.", "Moderate forecast instability signal."));
  if (lightningPotential >= 100) reasons.push(tx("Το αριθμητικό μοντέλο δείχνει αυξημένο προγνωστικό lightning potential.", "The model shows elevated forecast lightning potential."));
  if (liftedIndex <= -2) reasons.push(tx("Αρνητικός Lifted Index ενισχύει το προγνωστικό σήμα αστάθειας.", "A negative Lifted Index strengthens the instability signal."));
  if (cin >= 150) limitations.push(tx("Ισχυρή convective inhibition μπορεί να καταστείλει την ανάπτυξη καταιγίδων.", "Strong convective inhibition may suppress storm development."));

  const cloud = input.observerCloudPercent ?? 65;
  const highCloud = input.observerHighCloudPercent ?? cloud;
  const visibility = input.visibilityM ?? 10_000;
  const blockingCloud = Math.max(highCloud, cloud * 0.85);
  const atmosphere = clamp(20 * (1 - blockingCloud / 100) + 10 * (visibility / 30_000), 0, 30);
  if (input.atmosphereSource === "observation") reasons.push(tx("Η τοπική νέφωση και ορατότητα προέρχονται από πρόσφατη πραγματική παρατήρηση METAR.", "Local cloud and visibility come from a recent real METAR observation."));
  const cloudSources = input.observerCloudSources ?? 0;
  if (input.atmosphereSource !== "observation" && cloudSources >= 2) {
    const spread = input.observerCloudSpread ?? 0;
    if (spread >= 40) {
      limitations.push(tx(
        `Οι ${cloudSources} προγνώσεις νέφωσης για τη θέση σου διαφωνούν (διαφορά ${Math.round(spread)} μονάδων)· ο ουρανός είναι αβέβαιος.`,
        `The ${cloudSources} cloud forecasts for your location disagree (${Math.round(spread)} points apart); the sky is uncertain.`,
      ));
    } else if (cloud <= 30) {
      reasons.push(tx(`${cloudSources} ανεξάρτητες προγνώσεις συμφωνούν σε λίγα σύννεφα στη θέση σου.`, `${cloudSources} independent forecasts agree on little cloud at your location.`));
    }
  }
  if (highCloud < 25) reasons.push(tx("Λίγες υψηλές νεφώσεις στη θέση παρατήρησης.", "Little high cloud at the observing site."));
  if (highCloud > 70) limitations.push(tx("Οι υψηλές νεφώσεις μπορεί να κρύψουν την ανώτερη ατμόσφαιρα.", "High cloud may hide the upper atmosphere."));

  let terrain = 5;
  if (input.terrain === "clear") terrain = 20;
  if (input.terrain === "partial") terrain = 10;
  if (input.terrain === "blocked") terrain = 0;
  if (input.terrain === "unknown") limitations.push(tx("Η ορατότητα εδάφους δεν έχει ακόμη επαληθευτεί με DEM.", "The terrain line of sight has not been checked against the DEM yet."));

  const distance = input.distanceKm;
  const distanceScore =
    distance < 100 ? 0 : distance <= 250 ? 6 : distance <= 550 ? 10 : distance <= 700 ? 7 : 3;
  if (distance >= 200 && distance <= 600) reasons.push(tx("Η απόσταση είναι πρακτική για μακρινή φωτογράφιση.", "The distance suits long-range photography."));

  const darkness = darknessScore(input.sunAltitudeDeg, input.moonInterference);
  if (darkness >= 4.5) reasons.push(tx("Επικρατεί αστρονομικό σκοτάδι.", "Astronomical darkness."));
  if (input.moonInterference) limitations.push(tx("Η Σελήνη βρίσκεται κοντά στον προτεινόμενο τομέα λήψης.", "The Moon is close to the suggested shooting sector."));

  let total = Math.round(activity + atmosphere + terrain + distanceScore + darkness);
  if (!observed) total = Math.min(total, 69);
  if (input.terrain === "blocked" || input.sunAltitudeDeg > -6 || distance < 80) total = Math.min(total, 29);

  const terrainKnown = input.terrain !== "unknown";
  const cg = input.observedLightning?.cg;
  const strongPositiveCg = observed && cg != null && cg.positiveCount > 0 && (cg.maxPositiveKa ?? 0) >= STRONG_POSITIVE_KA;
  const confidence = observed && (terrainKnown || strongPositiveCg) ? "high" : observed || terrainKnown ? "medium" : "low";
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
