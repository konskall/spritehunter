import type { Coordinates, WeatherHour } from "@/lib/domain";
import { destinationPoint } from "@/lib/geodesy";

/** Forecast cloud layers at one point along the way to the targets. */
export interface PathSample {
  bearingDeg: number;
  distanceKm: number;
  hours: WeatherHour[];
}

// A view 2–15° up towards a storm crosses the low and mid cloud layers 20–100 km out; beyond
// ~100 km it is above them. The observer's own sky covers the first kilometres.
const PATH_DISTANCES_KM = [40, 90];
const PATH_BEARING_STEP_DEG = 30;
const EARTH_RADIUS_KM = 6_371;
// Layer tops as Open-Meteo defines them: low up to ~2 km, mid ~2–6 km, high ~6–12 km.
const LOW_TOP_KM = 2;
const MID_TOP_KM = 6;
const HIGH_TOP_KM = 12;
const MATCH_WINDOW_MS = 90 * 60_000;

const angularDifference = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Points where the cloud along the line of sight is sampled: every 30°, 40 and 90 km out. */
export function pathSampleGrid(observer: Coordinates) {
  return PATH_DISTANCES_KM.flatMap((distanceKm) =>
    Array.from({ length: 360 / PATH_BEARING_STEP_DEG }, (_, index) => ({
      bearingDeg: index * PATH_BEARING_STEP_DEG,
      distanceKm,
      ...destinationPoint(observer, distanceKm, index * PATH_BEARING_STEP_DEG),
    })));
}

function layerAt(heightKm: number): "cloudCoverLow" | "cloudCoverMid" | "cloudCoverHigh" | null {
  if (heightKm < LOW_TOP_KM) return "cloudCoverLow";
  if (heightKm < MID_TOP_KM) return "cloudCoverMid";
  if (heightKm < HIGH_TOP_KM) return "cloudCoverHigh";
  return null;
}

/**
 * Forecast cloud (%) in the layer a view at `elevationDeg` crosses towards `bearingDeg`,
 * the worst of the sampled distances on the nearest sampled bearing. Null without samples.
 */
export function pathCloudPercent(samples: PathSample[], bearingDeg: number, elevationDeg: number, time: string) {
  if (!samples.length) return null;
  const nearest = Math.min(...samples.map((sample) => angularDifference(sample.bearingDeg, bearingDeg)));
  const timeMs = Date.parse(time);
  const tanElevation = Math.tan((elevationDeg * Math.PI) / 180);
  let worst: number | null = null;
  for (const sample of samples) {
    if (angularDifference(sample.bearingDeg, bearingDeg) !== nearest) continue;
    const hour = sample.hours.reduce<WeatherHour | null>((best, candidate) => {
      const offset = Math.abs(Date.parse(candidate.time) - timeMs);
      return offset <= MATCH_WINDOW_MS && (!best || offset < Math.abs(Date.parse(best.time) - timeMs)) ? candidate : best;
    }, null);
    if (!hour) continue;
    // Height of the view above the ground at that distance, Earth's curvature included.
    const heightKm = sample.distanceKm * tanElevation + sample.distanceKm ** 2 / (2 * EARTH_RADIUS_KM);
    const layer = layerAt(heightKm);
    worst = Math.max(worst ?? 0, layer ? hour[layer] ?? 0 : 0);
  }
  return worst;
}
