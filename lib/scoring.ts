import type { CandidateScoreInput, CgLightning, ObservedLightning, ScoreBreakdown, TerrainStatus } from "@/lib/domain";
import { darknessScore } from "@/lib/astronomy";
import { tx, type Localized } from "@/lib/i18n";

type ScoreInput = CandidateScoreInput & { terrain: TerrainStatus };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

// Sprite-producing strokes are mostly positive CG; peak currents of +50 kA and more are
// common among them, so such a stroke is the strongest real-time sign a target has.
const STRONG_POSITIVE_KA = 50;
// Positive "ground strokes" weaker than this are often intra-cloud pulses classified wrongly.
const MIN_POSITIVE_KA = 15;
// A stroke this strong, of either polarity, drives ELVES and sprite halos.
const ELVES_KA = 100;
// Activity points that only CG strokes can add, on top of the lightning and model share (≤ 27).
const CG_ACTIVITY_SHARE = 8;
const ACTIVITY_BEFORE_CG = 35 - CG_ACTIVITY_SHARE;
// An observed storm's activity comes from its own lightning; the nearest model cell (up to
// 150 km away) only adds context, and a neutral share when there is none.
const OBSERVED_MODEL_SHARE = 6;
const NEUTRAL_MODEL_SHARE = 3;
// Forecast-only targets are scaled into 0–69 rather than capped, so a strong storm signal still
// outranks a weak one when sky, terrain and distance are all good.
const FORECAST_MAX_TOTAL = 69;
const FORECAST_ACTIVITY_CAP = 27;
const FORECAST_RAW_MAX = FORECAST_ACTIVITY_CAP + 30 + 20 + 10 + 5;
// Cloud that blocks the view sets a ceiling: none below 70 %, 49 at 80 %, 29 from 90 %.
const CLOUD_CEILING_FROM = 70;
const CLOUD_CLOSED = 90;
// MTG-LI sees no lightning near a forecast cell right now: at most "low".
const CONTRADICTED_MAX_TOTAL = 49;

/**
 * Storm signal of one model hour (0–35). Checked against MTG-LI for Oct 2025–Feb 2026 at 22:00:
 * the share of cells with lightning nearby rose with the model's rain (14 % with none, 47 % at
 * 0.2–1 mm, 62 % at 1–3 mm, 77 % above) and with its thunderstorm code (63 % vs 29 %), while
 * instability without rain hardly mattered (CAPE ≥ 1,000 J/kg and no rain: 12 %).
 */
export function modelActivity(input: Pick<CandidateScoreInput, "capeJkg" | "precipitationMm" | "thunderCode" | "liftedIndex" | "precipitableWaterKgM2" | "convectiveInhibitionJkg" | "lightningPotentialJkg">) {
  const rain = input.precipitationMm ?? 0;
  const cape = input.capeJkg ?? 0;
  const rainPoints = rain >= 3 ? 13 : rain >= 1 ? 10 : rain >= 0.2 ? 6 : 0;
  const capePoints = cape >= 1_000 ? 8 : cape >= 600 ? 7 : cape >= 250 ? 5 : cape >= 100 ? 3 : 0;
  return clamp(
    rainPoints
      + (rain >= 0.2 ? capePoints : Math.min(capePoints, 2))
      + (input.thunderCode ? 6 : 0)
      + clamp(-(input.liftedIndex ?? 0), 0, 2)
      + clamp(((input.precipitableWaterKgM2 ?? 20) - 24) / 4, 0, 2)
      + clamp((input.lightningPotentialJkg ?? 0) / 90, 0, 5)
      - clamp(((input.convectiveInhibitionJkg ?? 0) - 75) / 35, 0, 4),
    0,
    35,
  );
}

/**
 * Activity of the observed lightning itself (9–21). Sprites come mostly from large,
 * long-lived storm systems, so lit area and persistence count more than one hot pixel.
 */
function observedLightningActivity(detail: ObservedLightning | null | undefined) {
  if (!detail) return 9;
  return 9
    + clamp(3.5 * Math.log10(detail.areaKm2 / 50), 0, 9)
    + (detail.maxFlashesPer5Min >= 10 ? 2 : 0)
    + (detail.frames >= 2 ? 1 : 0);
}

/** Points from CG strokes and the reason for them, on top of an activity of at most 27. */
function cgActivity(cg: CgLightning, reasons: Localized[], limitations: Localized[]) {
  const positiveKa = cg.positiveCount > 0 ? cg.maxPositiveKa ?? 0 : 0;
  const negativeKa = cg.maxNegativeKa ?? 0;
  let points = 0;
  if (positiveKa >= MIN_POSITIVE_KA) {
    const strong = positiveKa >= STRONG_POSITIVE_KA;
    points = strong ? CG_ACTIVITY_SHARE : CG_ACTIVITY_SHARE / 2;
    reasons.push(tx(
      `Xweather: ${cg.positiveCount} θετικοί κεραυνοί +CG τα τελευταία ${cg.windowMinutes}′ (ισχυρότερος +${positiveKa} kA)${strong ? " — οι ισχυροί +CG είναι ο κύριος εκκινητής των sprites." : "."}`,
      `Xweather: ${cg.positiveCount} positive +CG strokes in the last ${cg.windowMinutes}′ (strongest +${positiveKa} kA)${strong ? " — strong +CG strokes are the main trigger of sprites." : "."}`,
    ));
  } else if (cg.positiveCount > 0) {
    limitations.push(tx(
      `Xweather: μόνο ασθενείς θετικοί κεραυνοί (κάτω από ${MIN_POSITIVE_KA} kA) τα τελευταία ${cg.windowMinutes}′· συχνά είναι ενδονεφικοί, όχι κεραυνοί προς το έδαφος.`,
      `Xweather: only weak positive strokes (below ${MIN_POSITIVE_KA} kA) in the last ${cg.windowMinutes}′; these are often intra-cloud, not ground strokes.`,
    ));
  } else if (cg.cgCount > 0) {
    limitations.push(tx(
      `Xweather: μόνο αρνητικοί κεραυνοί CG τα τελευταία ${cg.windowMinutes}′· τα sprites προκαλούνται κυρίως από θετικούς.`,
      `Xweather: only negative CG strokes in the last ${cg.windowMinutes}′; sprites are triggered mostly by positive ones.`,
    ));
  } else {
    limitations.push(tx(
      `Xweather: κανένας κεραυνός προς το έδαφος τα τελευταία ${cg.windowMinutes}′· η καταιγίδα έχει κυρίως ενδονεφικούς κεραυνούς.`,
      `Xweather: no cloud-to-ground strokes in the last ${cg.windowMinutes}′; the storm is mostly intra-cloud lightning.`,
    ));
  }
  if (negativeKa >= ELVES_KA) {
    points = Math.max(points, CG_ACTIVITY_SHARE / 2);
    reasons.push(tx(
      `Xweather: πολύ ισχυρός αρνητικός κεραυνός (−${negativeKa} kA)· τόσο ισχυροί κεραυνοί προκαλούν ELVES και halos.`,
      `Xweather: a very strong negative stroke (−${negativeKa} kA); strokes this strong drive ELVES and halos.`,
    ));
  }
  return points;
}

/** Distance points: sprites are brighter and higher up close, lower and dimmer far away. */
function distancePoints(distanceKm: number) {
  if (distanceKm < 80) return 0;
  if (distanceKm < 100) return 5;
  if (distanceKm <= 300) return 10;
  if (distanceKm <= 450) return 8;
  if (distanceKm <= 600) return 6;
  if (distanceKm <= 750) return 4;
  return 2;
}

export function scoreOpportunity(input: ScoreInput): ScoreBreakdown {
  const reasons: Localized[] = [];
  const limitations: Localized[] = [];
  const cape = input.capeJkg ?? 0;
  const cin = input.convectiveInhibitionJkg ?? 0;
  const liftedIndex = input.liftedIndex ?? 0;
  const model = modelActivity(input);
  let activity: number;
  const observed = input.lightning === "observed";
  if (observed) {
    // No model cell near an observed storm is missing context, not evidence against it.
    if (input.capeJkg == null) limitations.push(tx("Δεν υπάρχει κοντινή κυψέλη μοντέλου· η αστάθεια της καταιγίδας δεν αξιολογήθηκε.", "No model cell near the storm, so its instability was not assessed."));
    const modelShare = input.capeJkg == null ? NEUTRAL_MODEL_SHARE : Math.min(model, OBSERVED_MODEL_SHARE);
    activity = clamp(modelShare + observedLightningActivity(input.observedLightning), 0, ACTIVITY_BEFORE_CG);
    const detail = input.observedLightning;
    const flashes = detail && (detail.maxFlashesPer5Min >= 20 ? "20+" : String(Math.round(detail.maxFlashesPer5Min)));
    reasons.push(detail
      ? tx(
        `Το MTG-LI κατέγραψε κεραυνούς σε ~${Math.round(detail.areaKm2).toLocaleString("el-GR")} km² (έως ${flashes} κεραυνοί/5′ ανά pixel, πριν από ${detail.ageMinutes}′).`,
        `MTG-LI recorded lightning over ~${Math.round(detail.areaKm2).toLocaleString("en-GB")} km² (up to ${flashes} flashes/5′ per pixel, ${detail.ageMinutes}′ ago).`,
      )
      : tx("Παρατηρημένοι κεραυνοί κοντά στον στόχο.", "Observed lightning near the target."));
    if (detail && detail.frames < 2) limitations.push(tx("Η κεραυνική δραστηριότητα εμφανίστηκε σε ένα μόνο 5λεπτο καρέ· μπορεί να είναι βραχύβια.", "Lightning appeared in a single 5-minute frame only; the storm may be short-lived."));
    // CG polarity and peak current can only add: a storm without them is not marked down.
    if (detail?.cg) activity = clamp(activity + cgActivity(detail.cg, reasons, limitations), 0, 35);
  } else if (input.lightning === "not_detected") {
    activity = Math.min(model, 12);
    limitations.push(tx("Το MTG-LI δεν ανιχνεύει αυτή τη στιγμή κεραυνούς κοντά στον στόχο· η πρόγνωση δεν επιβεβαιώνεται.", "MTG-LI sees no lightning near the target right now, so the forecast is not confirmed."));
  } else {
    activity = Math.min(model, FORECAST_ACTIVITY_CAP);
    limitations.push(tx("Δεν υπάρχουν πραγματικές παρατηρήσεις κεραυνών· ο στόχος είναι μόνο προγνωστικός.", "No observed lightning; this target is a forecast only."));
  }

  if ((input.precipitationMm ?? 0) >= 1) reasons.push(tx("Το μοντέλο δίνει βροχή καταιγίδας στον στόχο.", "The model gives storm rain at the target."));
  if (input.thunderCode) reasons.push(tx("Το μοντέλο προβλέπει καταιγίδα με κεραυνούς (κωδικός καιρού).", "The model forecasts a thunderstorm (weather code)."));
  if (cape >= 800) reasons.push(tx("Ισχυρό προγνωστικό σήμα αστάθειας (CAPE).", "Strong forecast instability signal (CAPE)."));
  else if (cape >= 300) reasons.push(tx("Μέτριο προγνωστικό σήμα αστάθειας.", "Moderate forecast instability signal."));
  if ((input.lightningPotentialJkg ?? 0) >= 100) reasons.push(tx("Το αριθμητικό μοντέλο δείχνει αυξημένο προγνωστικό lightning potential.", "The model shows elevated forecast lightning potential."));
  if (liftedIndex <= -2) reasons.push(tx("Αρνητικός Lifted Index ενισχύει το προγνωστικό σήμα αστάθειας.", "A negative Lifted Index strengthens the instability signal."));
  if (cin >= 150) limitations.push(tx("Ισχυρή convective inhibition μπορεί να καταστείλει την ανάπτυξη καταιγίδων.", "Strong convective inhibition may suppress storm development."));

  const cloud = input.observerCloudPercent ?? 65;
  const highCloud = input.observerHighCloudPercent ?? cloud;
  const pathCloud = input.pathCloudPercent ?? 0;
  const visibility = input.visibilityM ?? 10_000;
  const blockingCloud = Math.max(highCloud, cloud * 0.85, pathCloud);
  const atmosphere = clamp(20 * (1 - blockingCloud / 100) + 10 * (visibility / 30_000), 0, 30);
  if (input.atmosphereSource === "observation") reasons.push(tx("Η χαμηλή νέφωση και η ορατότητα στη θέση σου προέρχονται από πρόσφατη πραγματική παρατήρηση METAR.", "Low cloud and visibility at your location come from a recent real METAR observation."));
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
  if (pathCloud >= 60) {
    limitations.push(tx(
      `Νέφη στη γραμμή θέασης προς τον στόχο (~${Math.round(pathCloud)}% στα 40–90 km)· μπορεί να κρύψουν τα TLE χαμηλά στον ορίζοντα.`,
      `Cloud along the line of sight to the target (~${Math.round(pathCloud)}% at 40–90 km); it may hide TLEs low on the horizon.`,
    ));
  }
  if (blockingCloud >= CLOUD_CLOSED) {
    limitations.push(tx(`Ο ουρανός είναι σχεδόν εντελώς κλειστός από σύννεφα (~${Math.round(blockingCloud)}%)· ο δείκτης περιορίζεται στο 29.`, `The sky is almost fully overcast (~${Math.round(blockingCloud)}%); the index is capped at 29.`));
  } else if (blockingCloud >= CLOUD_CEILING_FROM) {
    limitations.push(tx(`Πολλά σύννεφα (~${Math.round(blockingCloud)}%) περιορίζουν τον δείκτη.`, `Heavy cloud (~${Math.round(blockingCloud)}%) limits the index.`));
  }

  let terrain = 5;
  if (input.terrain === "clear") terrain = 20;
  if (input.terrain === "partial") terrain = 10;
  if (input.terrain === "blocked") terrain = 0;
  if (input.terrain === "unknown") limitations.push(tx("Η ορατότητα εδάφους δεν έχει ακόμη επαληθευτεί με DEM.", "The terrain line of sight has not been checked against the DEM yet."));

  const distance = input.distanceKm;
  const distanceScore = distancePoints(distance);
  if (distance >= 100 && distance <= 450) reasons.push(tx("Η απόσταση είναι πρακτική: τα TLE φαίνονται αρκετά ψηλά και φωτεινά.", "A practical distance: TLEs appear high and bright enough."));

  const darkness = darknessScore(input.sunAltitudeDeg, input.moonInterference);
  if (darkness >= 4.5) reasons.push(tx("Επικρατεί αστρονομικό σκοτάδι.", "Astronomical darkness."));
  if (input.moonInterference) limitations.push(tx("Η Σελήνη βρίσκεται κοντά στον προτεινόμενο τομέα λήψης.", "The Moon is close to the suggested shooting sector."));

  const raw = activity + atmosphere + terrain + distanceScore + darkness;
  let total = Math.round(observed ? raw : (raw * FORECAST_MAX_TOTAL) / FORECAST_RAW_MAX);
  if (input.lightning === "not_detected") total = Math.min(total, CONTRADICTED_MAX_TOTAL);
  if (blockingCloud >= CLOUD_CEILING_FROM) {
    total = Math.min(total, Math.round(69 - (Math.min(blockingCloud, CLOUD_CLOSED) - CLOUD_CEILING_FROM) * 2));
  }
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
