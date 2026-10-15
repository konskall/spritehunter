import { z } from "zod";
import type {
  AirQualityHour,
  AviationObservation,
  CandidateScoreInput,
  CgLightning,
  Coordinates,
  DataStatus,
  LightningCluster,
  LightningObservation,
  ObservedLightning,
  OpportunityResponse,
  StormCandidate,
  WeatherHour,
} from "@/lib/domain";
import { altitudeEnvelope, destinationPoint, inverseGeodesic, lookAngles } from "@/lib/geodesy";
import { skyState } from "@/lib/astronomy";
import { modelActivity, scoreOpportunity } from "@/lib/scoring";
import { pathCloudPercent, pathSampleGrid, type PathSample } from "@/lib/line-of-sight";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";
import { InFlight, TtlCache } from "@/lib/bounded-cache";
import { tx, type Localized } from "@/lib/i18n";
import { fetchNearestAviationWeather, unavailableAviation } from "@/lib/providers/aviation-weather";
import { fetchMeteoAlarm, unavailableMeteoAlarm } from "@/lib/providers/meteoalarm";
import { fetchLightningObservation } from "@/lib/providers/mtg-lightning";
import { CG_WINDOW_MINUTES, fetchCgLightning, xweatherConfigured, xweatherQuotaAllows } from "@/lib/providers/xweather";
import { cloudAgreement, fetchOpenWeatherHours, fetchWeatherApiHours, mergeCloudSources, openWeatherConfigured, weatherApiConfigured } from "@/lib/providers/sky-sources";

const numberArray = z.array(z.number().nullable());
const weatherSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  elevation: z.number().optional(),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: numberArray.optional(),
    relative_humidity_2m: numberArray.optional(),
    precipitation: numberArray.optional(),
    precipitation_probability: numberArray.optional(),
    cloud_cover: numberArray.optional(),
    cloud_cover_low: numberArray.optional(),
    cloud_cover_mid: numberArray.optional(),
    cloud_cover_high: numberArray.optional(),
    visibility: numberArray.optional(),
    wind_speed_10m: numberArray.optional(),
    wind_direction_10m: numberArray.optional(),
    cape: numberArray.optional(),
    convective_inhibition: numberArray.optional(),
    lifted_index: numberArray.optional(),
    total_column_integrated_water_vapour: numberArray.optional(),
    weather_code: numberArray.optional(),
  }),
  minutely_15: z.object({
    time: z.array(z.string()),
    lightning_potential: numberArray.optional(),
  }).optional(),
});

const airSchema = z.object({
  hourly: z.object({
    time: z.array(z.string()),
    pm10: numberArray.optional(),
    pm2_5: numberArray.optional(),
    dust: numberArray.optional(),
    aerosol_optical_depth: numberArray.optional(),
  }),
});

export type WeatherPayload = z.infer<typeof weatherSchema>;
// Hourly model data changes at most with each model run. An hour of caching keeps the dense
// scan (≈150 locations) at about the Open-Meteo calls of the old 24-cell scan cached for 15
// minutes; lightning has its own 4-minute cache and stays live.
const CACHE_TTL_MS = 60 * 60_000;
// A scan with failed cells is kept only briefly, so the next refresh asks again.
const PARTIAL_CACHE_TTL_MS = 2 * 60_000;
const SERVER_ONLY_MESSAGE = tx("Διαθέσιμο μόνο μέσω του server της εφαρμογής (ο πάροχος δεν επιτρέπει κλήσεις από browser).", "Available only through the app's server (the provider does not allow browser requests).");
// Candidates are only searched over the next 48 h; fetching more only slowed the provider.
const FORECAST_HOURS = 48;
const CANDIDATE_WINDOW_HOURS = 48;
// Few, large requests: many parallel calls caused Open-Meteo 429 bursts.
const SCREENING_BATCH_SIZE = 48;
// The scan: every 15° and one ring per 100 km of range. Checked against MTG-LI for Oct 2025–Feb
// 2026 (Sparta, 200–600 km), 24 cells 45° apart had a target near 27 % of the large storms; this
// grid with the storm-hour rule below, 76 %.
const SCAN_BEARING_STEP_DEG = 15;
const SCAN_RING_SPACING_KM = 100;
// Where a forecast storm will really be: on this grid, cells with lightning nearby were 53 km
// from the storm centre at the median and 78 km at the 75th percentile.
const FORECAST_UNCERTAINTY_KM = 80;
// Neighbouring cells within this distance and these hours show one storm; the best is kept.
const DUPLICATE_DISTANCE_KM = 150;
const DUPLICATE_HOURS = 3;
// An observed storm moves for the ~15 minutes MTG-LI lags, and the satellite's slanted view may
// place its lightning ~10–15 km off: both widen the area around the lit pixels.
const OBSERVED_MARGIN_KM = 25;
// Forecast data changes hourly; lightning is merged on every request from its own 4-minute cache.
interface ForecastBase {
  fetchedAt: string;
  observerForecast: WeatherHour[];
  airQuality: AirQualityHour[];
  aviation: AviationObservation;
  weatherAlerts: OpportunityResponse["weatherAlerts"];
  payloads: WeatherPayload[];
  pathSamples: PathSample[];
  screeningFailures: number;
  screeningError: string | null;
  gridSize: number;
  skySources: { weatherApi: SourceState; openWeather: SourceState };
}
interface SourceState {
  status: DataStatus;
  message: Localized;
}
const forecastCache = new TtlCache<ForecastBase>(100);
const forecastInFlight = new InFlight<ForecastBase>();
// Forecast hours from 60 min before to 30 min after the newest MTG-LI frame are judged
// against it; storms may still develop in later hours.
const NOWCAST_BEFORE_MS = 60 * 60_000;
const NOWCAST_AFTER_MS = 30 * 60_000;
// Lightning this close to a forecast cell, measured to the storm's edge, is the same storm.
const NEAR_STORM_KM = 50;
// Ranked targets returned, and how many places are kept for observed storms.
const TARGET_LIMIT = 10;
const RESERVED_OBSERVED = 3;
// Model context for an observed storm comes from the nearest screening cell within this range.
const MODEL_CONTEXT_KM = 150;
// The lightning box extends past the scan radius so storms straddling its edge are whole.
const LIGHTNING_MARGIN_KM = 60;
// MTG-LI storms included in the response (the largest); scoring uses all of them.
const LISTED_STORMS = 40;

const WEATHER_VARIABLES = [
  "temperature_2m",
  "relative_humidity_2m",
  "precipitation",
  "precipitation_probability",
  "cloud_cover",
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  "visibility",
  "wind_speed_10m",
  "wind_direction_10m",
  "cape",
  "convective_inhibition",
  "lifted_index",
  "total_column_integrated_water_vapour",
  "weather_code",
];
// Scan cells need only the storm signal and what a target shows. Up to 10 variables count as
// one Open-Meteo call per location (with the 15-minute lightning potential, 10 here).
const SCAN_VARIABLES = [
  "precipitation",
  "cloud_cover_high",
  "wind_speed_10m",
  "wind_direction_10m",
  "cape",
  "convective_inhibition",
  "lifted_index",
  "total_column_integrated_water_vapour",
  "weather_code",
];
// The line-of-sight points need the three cloud layers only.
const PATH_VARIABLES = ["cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"];

function valueAt(values: Array<number | null> | undefined, index: number) {
  return values?.[index] ?? null;
}

function utcIso(value: string) {
  return /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`;
}

// Every request re-scores all cells and hours from the cached payloads. Re-parsing the same
// timestamps each time dominated its CPU time (about 16 of 17 ms), so parsed hours and
// times are kept alongside the cached arrays they come from.
const hoursCache = new WeakMap<WeatherPayload, WeatherHour[]>();
const timesCache = new WeakMap<object, Float64Array>();

function cachedWeatherHours(payload: WeatherPayload) {
  let hours = hoursCache.get(payload);
  if (!hours) {
    hours = weatherHours(payload);
    hoursCache.set(payload, hours);
  }
  return hours;
}

function timesOf<T>(list: readonly T[], timeOf: (item: T) => string) {
  let times = timesCache.get(list);
  if (!times) {
    times = Float64Array.from(list, (item) => Date.parse(utcIso(timeOf(item))));
    timesCache.set(list, times);
  }
  return times;
}

/** Index of the time closest to `target` in an ascending series; the earlier one wins a tie. */
function nearestIndex(times: Float64Array, target: number) {
  if (!times.length) return -1;
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low > 0 && target - times[low - 1] <= times[low] - target ? low - 1 : low;
}

function weatherHours(payload: WeatherPayload): WeatherHour[] {
  return payload.hourly.time.map((time, index) => ({
    time: utcIso(time),
    temperatureC: valueAt(payload.hourly.temperature_2m, index),
    relativeHumidity: valueAt(payload.hourly.relative_humidity_2m, index),
    precipitationMm: valueAt(payload.hourly.precipitation, index),
    precipitationProbability: valueAt(payload.hourly.precipitation_probability, index),
    cloudCover: valueAt(payload.hourly.cloud_cover, index),
    cloudCoverLow: valueAt(payload.hourly.cloud_cover_low, index),
    cloudCoverMid: valueAt(payload.hourly.cloud_cover_mid, index),
    cloudCoverHigh: valueAt(payload.hourly.cloud_cover_high, index),
    visibilityM: valueAt(payload.hourly.visibility, index),
    windSpeedKmh: valueAt(payload.hourly.wind_speed_10m, index),
    windDirectionDeg: valueAt(payload.hourly.wind_direction_10m, index),
    capeJkg: valueAt(payload.hourly.cape, index),
    convectiveInhibitionJkg: valueAt(payload.hourly.convective_inhibition, index),
    liftedIndex: valueAt(payload.hourly.lifted_index, index),
    precipitableWaterKgM2: valueAt(payload.hourly.total_column_integrated_water_vapour, index),
    weatherCode: valueAt(payload.hourly.weather_code, index),
  }));
}

function airHours(payload: z.infer<typeof airSchema>): AirQualityHour[] {
  return payload.hourly.time.map((time, index) => ({
    time: utcIso(time),
    pm10: valueAt(payload.hourly.pm10, index),
    pm2_5: valueAt(payload.hourly.pm2_5, index),
    dust: valueAt(payload.hourly.dust, index),
    aerosolOpticalDepth: valueAt(payload.hourly.aerosol_optical_depth, index),
  }));
}

/** Scan cells: every 15°, on rings centred in each ~100 km band of the scan range. */
export function screeningGrid(observer: Coordinates, minimumKm: number, maximumKm: number) {
  const rings = Math.max(1, Math.round((maximumKm - minimumKm) / SCAN_RING_SPACING_KM));
  const spacing = (maximumKm - minimumKm) / rings;
  const distances = Array.from({ length: rings }, (_, index) => minimumKm + spacing * (index + 0.5));
  return distances.flatMap((distanceKm) =>
    Array.from({ length: 360 / SCAN_BEARING_STEP_DEG }, (_, index) => destinationPoint(observer, distanceKm, index * SCAN_BEARING_STEP_DEG)),
  );
}

function weatherUrl(points: Coordinates[], variables = WEATHER_VARIABLES, withLightningPotential = true) {
  const params = new URLSearchParams({
    latitude: points.map((point) => point.latitude.toFixed(5)).join(","),
    longitude: points.map((point) => point.longitude.toFixed(5)).join(","),
    hourly: variables.join(","),
    forecast_hours: String(FORECAST_HOURS),
    timezone: "UTC",
  });
  if (withLightningPotential) {
    params.set("minutely_15", "lightning_potential");
    params.set("forecast_minutely_15", String(FORECAST_HOURS * 4));
  }
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

function lightningPotentialAt(payload: WeatherPayload, time: string) {
  const series = payload.minutely_15;
  if (!series?.lightning_potential?.length) return null;
  const index = nearestIndex(timesOf(series.time, (value) => value), Date.parse(time));
  return index >= 0 ? series.lightning_potential[index] ?? null : null;
}

function parseWeatherPayloads(raw: unknown): WeatherPayload[] {
  const parsedBatch = z.array(weatherSchema).safeParse(raw);
  if (parsedBatch.success) return parsedBatch.data;
  const parsedSingle = weatherSchema.safeParse(raw);
  if (parsedSingle.success) return [parsedSingle.data];
  throw new Error("Open-Meteo returned an unsupported response shape.");
}

async function fetchWeatherBatch(points: Coordinates[], variables = WEATHER_VARIABLES, withLightningPotential = true) {
  const raw = await fetchJsonWithRetry<unknown>(weatherUrl(points, variables, withLightningPotential), {
    retries: 1,
    timeoutMs: 12_000,
    deadlineMs: 20_000,
    headers: { Accept: "application/json" },
  });
  const payloads = parseWeatherPayloads(raw);
  if (payloads.length !== points.length) {
    throw new Error(`Open-Meteo returned ${payloads.length} of ${points.length} requested locations.`);
  }
  return payloads;
}

function chunks<T>(values: T[], size: number) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
}

/** The model's storm signal for an hour, the same one the score uses. */
const stormSignal = (hour: WeatherHour) => modelActivity({ ...hour, thunderCode: isThunderCode(hour.weatherCode) });

/**
 * A model hour worth a target: a thunderstorm code, or rain with some instability. Instability
 * alone was a poor sign (2–12 % of such cells had lightning nearby); with this rule the scan found
 * 88 % of the large storms, against 76 % before, and more of its cells were right (48 % vs 38 %).
 */
export function isStormHour(hour: Pick<WeatherHour, "capeJkg" | "precipitationMm" | "weatherCode">) {
  return isThunderCode(hour.weatherCode) || ((hour.capeJkg ?? 0) >= 100 && (hour.precipitationMm ?? 0) >= 0.2);
}

function emptyHour(time: string): WeatherHour {
  return {
    time, temperatureC: null, relativeHumidity: null, precipitationMm: null, precipitationProbability: null,
    cloudCover: null, cloudCoverLow: null, cloudCoverMid: null, cloudCoverHigh: null, visibilityM: null,
    windSpeedKmh: null, windDirectionDeg: null, capeJkg: null, convectiveInhibitionJkg: null, liftedIndex: null,
    precipitableWaterKgM2: null, weatherCode: null,
  };
}

const isThunderCode = (code: number | null) => code != null && [95, 96, 99].includes(code);

function closestHour(hours: WeatherHour[], time: string) {
  const index = nearestIndex(timesOf(hours, (hour) => hour.time), Date.parse(time));
  return index >= 0 ? hours[index] : null;
}

// The line of sight is judged towards the lower body of a sprite, ~60 km up.
const SIGHTLINE_ALTITUDE_M = 60_000;
const sightlineElevation = (observer: Coordinates, target: Coordinates) =>
  lookAngles(observer, { ...target, elevationM: SIGHTLINE_ALTITUDE_M }).elevationDeg;

function scoreInputForHour(
  observer: Coordinates,
  hour: WeatherHour,
  thunderCode: boolean,
  lightningPotentialJkg: number | null,
  observerHours: WeatherHour[],
  aviation: AviationObservation,
  geometry: { distanceM: number; initialBearingDeg: number },
  sightline: { samples: PathSample[]; elevationDeg: number },
): CandidateScoreInput {
  const observerHour = closestHour(observerHours, hour.time) ?? observerHours[0];
  // A METAR is a point observation: only fresh, nearby reports close in time to the
  // valid hour may replace the forecast, and only for what it measures. European METARs
  // report cloud below ~1,500 m (CAVOK and NSC say nothing above), so mid and high cloud
  // always come from the model.
  const metarRelevant = aviation.status === "available"
    && aviation.observedAt != null
    && (aviation.distanceKm ?? Number.POSITIVE_INFINITY) <= 180
    && Math.abs(new Date(hour.time).getTime() - new Date(aviation.observedAt).getTime()) <= 3 * 60 * 60_000;
  const metarCloud = metarRelevant && aviation.cloudCoverPercent != null
    ? Math.max(aviation.cloudCoverPercent, observerHour?.cloudCoverMid ?? 0, observerHour?.cloudCoverHigh ?? 0)
    : null;
  // "10 km or more" (9999, CAVOK) is only a minimum and must not lower a clearer forecast.
  const metarVisibility = !metarRelevant || aviation.visibilityM == null
    ? null
    : aviation.visibilityAtLeast ? Math.max(aviation.visibilityM, observerHour?.visibilityM ?? 0) : aviation.visibilityM;
  const agreement = cloudAgreement(observerHour);
  const sky = skyState(new Date(hour.time), observer.latitude, observer.longitude, geometry.initialBearingDeg);
  return {
    capeJkg: hour.capeJkg,
    convectiveInhibitionJkg: hour.convectiveInhibitionJkg,
    liftedIndex: hour.liftedIndex,
    precipitableWaterKgM2: hour.precipitableWaterKgM2,
    precipitationMm: hour.precipitationMm,
    thunderCode,
    lightningPotentialJkg,
    // Total cloud is the median of the configured forecasts; high cloud only Open-Meteo gives.
    observerCloudPercent: metarCloud ?? observerHour?.cloudConsensus ?? observerHour?.cloudCover ?? null,
    observerHighCloudPercent: observerHour?.cloudCoverHigh ?? null,
    visibilityM: metarVisibility ?? observerHour?.visibilityM ?? null,
    atmosphereSource: metarCloud != null || metarVisibility != null ? "observation" : "forecast",
    observerCloudSources: agreement.sources,
    observerCloudSpread: agreement.spread,
    pathCloudPercent: pathCloudPercent(sightline.samples, geometry.initialBearingDeg, sightline.elevationDeg, hour.time),
    distanceKm: geometry.distanceM / 1000,
    sunAltitudeDeg: sky.sunAltitudeDeg,
    moonInterference: sky.moonInterference,
    lightning: "not_configured",
  };
}

/** The newest MTG-LI storms, used to judge forecast hours close to the observation time. */
export interface LightningCheck {
  frameMs: number;
  clusters: LightningCluster[];
  nowMs: number;
}

function lightningForHour(check: LightningCheck | null, coordinates: Coordinates, time: string): Pick<CandidateScoreInput, "lightning" | "observedLightning"> | null {
  if (!check) return null;
  const offset = Date.parse(utcIso(time)) - check.frameMs;
  if (offset < -NOWCAST_BEFORE_MS || offset > NOWCAST_AFTER_MS) return null;
  const nearest = check.clusters
    .map((cluster) => ({ cluster, edgeKm: distanceKmBetween(coordinates, cluster.centroid) - cluster.radiusKm }))
    .sort((a, b) => a.edgeKm - b.edgeKm)[0];
  return nearest && nearest.edgeKm <= NEAR_STORM_KM
    ? { lightning: "observed", observedLightning: observedDetail(nearest.cluster, check.nowMs) }
    : { lightning: "not_detected", observedLightning: null };
}

export function buildCandidate(
  observer: Coordinates,
  target: WeatherPayload,
  observerHours: WeatherHour[],
  aviation: AviationObservation,
  fetchedAt: string,
  nowMs = Date.now(),
  lightningCheck: LightningCheck | null = null,
  pathSamples: PathSample[] = [],
): StormCandidate | null {
  const hours = cachedWeatherHours(target);
  const times = timesOf(hours, (hour) => hour.time);
  const windowStart = nowMs - 60 * 60_000;
  const coordinates: Coordinates = {
    latitude: target.latitude,
    longitude: target.longitude,
    elevationM: target.elevation ?? 0,
  };
  const geometry = inverseGeodesic(observer, coordinates);
  const sightline = { samples: pathSamples, elevationDeg: sightlineElevation(observer, coordinates) };

  // Score every qualifying hour and keep the best opportunity, so a stronger
  // daytime convective peak (capped at 29 by daylight) cannot hide a usable night.
  const best = hours
    .filter((_, index) => times[index] >= windowStart)
    .slice(0, CANDIDATE_WINDOW_HOURS)
    .flatMap((hour) => {
      if (!isStormHour(hour)) return [];
      // Hours near the newest MTG-LI frame are confirmed or contradicted per hour, so a
      // contradicted "now" cannot hide a later hour of the same cell.
      const scoreInput: CandidateScoreInput = {
        ...scoreInputForHour(observer, hour, isThunderCode(hour.weatherCode), lightningPotentialAt(target, hour.time), observerHours, aviation, geometry, sightline),
        ...lightningForHour(lightningCheck, coordinates, hour.time),
      };
      return [{ hour, scoreInput, score: scoreOpportunity({ ...scoreInput, terrain: "unknown" }), signal: stormSignal(hour) }];
    })
    .sort((a, b) => b.score.total - a.score.total || b.signal - a.signal)[0];
  if (!best) return null;

  const { hour, scoreInput, score } = best;
  const pointing = altitudeEnvelope(observer, coordinates);
  const lightningPotentialJkg = scoreInput.lightningPotentialJkg ?? null;

  return {
    id: `forecast-${target.latitude.toFixed(2)}-${target.longitude.toFixed(2)}-${hour.time}`,
    coordinates,
    forecastValidAt: hour.time,
    distanceKm: Math.round((geometry.distanceM / 1000) * 10) / 10,
    bearingDeg: Math.round(geometry.initialBearingDeg * 10) / 10,
    uncertaintyKm: FORECAST_UNCERTAINTY_KM,
    capeJkg: hour.capeJkg,
    convectiveInhibitionJkg: hour.convectiveInhibitionJkg,
    liftedIndex: hour.liftedIndex,
    precipitableWaterKgM2: hour.precipitableWaterKgM2,
    precipitationMm: hour.precipitationMm,
    weatherCode: hour.weatherCode,
    lightningPotentialJkg,
    highCloudPercent: hour.cloudCoverHigh,
    windSpeedKmh: hour.windSpeedKmh,
    windDirectionDeg: hour.windDirectionDeg,
    pointing,
    score,
    scoreInput,
    source: "forecast",
    observedLightning: scoreInput.observedLightning ?? null,
    provenance: {
      provider: "Open-Meteo",
      kind: "forecast",
      observedAt: null,
      validAt: hour.time,
      retrievedAt: fetchedAt,
      resolution: "Coarse geographic screening; model-dependent grid",
      status: "available",
      freshnessMinutes: 0,
      quality: "medium",
      message: "Forecast model cell, not an observed storm centroid or lightning event.",
    },
  };
}

function observedDetail(cluster: LightningCluster, nowMs: number): ObservedLightning {
  return {
    stormId: cluster.id,
    observedAt: cluster.observedAt,
    ageMinutes: Math.max(0, Math.round((nowMs - Date.parse(cluster.observedAt)) / 60_000)),
    areaKm2: cluster.areaKm2,
    maxFlashesPer5Min: cluster.maxFlashesPer5Min,
    frames: cluster.frames,
    windowMinutes: cluster.windowMinutes,
  };
}

const distanceKmBetween = (a: Coordinates, b: Coordinates) => inverseGeodesic(a, b).distanceM / 1000;

export interface TargetContext {
  observerHours: WeatherHour[];
  aviation: AviationObservation;
  minimumKm: number;
  maximumKm: number;
  fetchedAt: string;
  nowMs?: number;
  /** Cloud layers along the lines of sight (see lib/line-of-sight). */
  pathSamples?: PathSample[];
}

function buildObservedCandidate(observer: Coordinates, cluster: LightningCluster, payloads: WeatherPayload[], context: TargetContext, nowMs: number): StormCandidate | null {
  const coordinates: Coordinates = { latitude: cluster.centroid.latitude, longitude: cluster.centroid.longitude, elevationM: 0 };
  const geometry = inverseGeodesic(observer, coordinates);
  const distanceKm = geometry.distanceM / 1000;
  if (distanceKm < context.minimumKm || distanceKm > context.maximumKm) return null;

  const nearest = payloads
    .map((payload) => ({ payload, distanceKm: distanceKmBetween(coordinates, payload) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)[0];
  const model = nearest && nearest.distanceKm <= MODEL_CONTEXT_KM ? nearest.payload : null;
  const modelHour = model ? closestHour(cachedWeatherHours(model), cluster.observedAt) : null;
  const hour: WeatherHour = { ...(modelHour ?? emptyHour(cluster.observedAt)), time: cluster.observedAt };
  const detail = observedDetail(cluster, nowMs);
  const scoreInput: CandidateScoreInput = {
    ...scoreInputForHour(observer, hour, isThunderCode(hour.weatherCode), model ? lightningPotentialAt(model, cluster.observedAt) : null, context.observerHours, context.aviation, geometry,
      { samples: context.pathSamples ?? [], elevationDeg: sightlineElevation(observer, coordinates) }),
    lightning: "observed",
    observedLightning: detail,
  };
  return {
    id: cluster.id,
    coordinates,
    forecastValidAt: cluster.observedAt,
    distanceKm: Math.round(distanceKm * 10) / 10,
    bearingDeg: Math.round(geometry.initialBearingDeg * 10) / 10,
    // Sprites appear over the storm's stratiform region, often tens of km from the lightning core.
    uncertaintyKm: Math.round(Math.max(OBSERVED_MARGIN_KM, Math.min(90, cluster.radiusKm + OBSERVED_MARGIN_KM))),
    capeJkg: hour.capeJkg,
    convectiveInhibitionJkg: hour.convectiveInhibitionJkg,
    liftedIndex: hour.liftedIndex,
    precipitableWaterKgM2: hour.precipitableWaterKgM2,
    precipitationMm: hour.precipitationMm,
    weatherCode: hour.weatherCode,
    lightningPotentialJkg: scoreInput.lightningPotentialJkg ?? null,
    highCloudPercent: hour.cloudCoverHigh,
    windSpeedKmh: hour.windSpeedKmh,
    windDirectionDeg: hour.windDirectionDeg,
    pointing: altitudeEnvelope(observer, coordinates),
    score: scoreOpportunity({ ...scoreInput, terrain: "unknown" }),
    scoreInput,
    source: "observed",
    observedLightning: detail,
    provenance: {
      provider: "EUMETSAT MTG-LI",
      kind: "observation",
      observedAt: cluster.observedAt,
      validAt: cluster.observedAt,
      retrievedAt: context.fetchedAt,
      resolution: "Accumulated Flash Area, ~0.04° grid",
      status: "available",
      freshnessMinutes: detail.ageMinutes,
      quality: "medium",
      message: "Satellite-observed lightning activity; does not distinguish CG/IC or polarity.",
    },
  };
}

const byScore = (a: StormCandidate, b: StormCandidate) => b.score.total - a.score.total;

/**
 * Neighbouring scan cells often show the same forecast storm. Keeps the best-scored cell and
 * drops forecast cells near it (≤ 150 km) whose valid time is within 3 hours of it.
 */
export function dropNearbyForecasts(candidates: StormCandidate[]) {
  const kept: StormCandidate[] = [];
  for (const candidate of [...candidates].sort(byScore)) {
    const time = Date.parse(utcIso(candidate.forecastValidAt));
    const duplicate = kept.some((other) =>
      Math.abs(Date.parse(utcIso(other.forecastValidAt)) - time) <= DUPLICATE_HOURS * 3_600_000
      && distanceKmBetween(other.coordinates, candidate.coordinates) <= DUPLICATE_DISTANCE_KM);
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}

/**
 * All targets for one scan: forecast cells (hours near the newest MTG-LI frame confirmed
 * or damped by it) plus every observed storm inside the scan range. A forecast cell whose
 * chosen hour is confirmed by a storm that is itself a target is dropped as a duplicate.
 */
export function buildTargets(
  observer: Coordinates,
  payloads: WeatherPayload[],
  observation: LightningObservation | null,
  context: TargetContext,
): StormCandidate[] {
  const nowMs = context.nowMs ?? Date.now();
  const usable = observation?.status === "available" && observation.latestFrameAt ? observation : null;
  const check = usable ? { frameMs: Date.parse(usable.latestFrameAt!), clusters: usable.clusters, nowMs } : null;
  const forecast = dropNearbyForecasts(payloads
    .map((payload) => buildCandidate(observer, payload, context.observerHours, context.aviation, context.fetchedAt, nowMs, check, context.pathSamples))
    .filter((candidate): candidate is StormCandidate => candidate !== null));
  if (!usable) return forecast;
  const observed = usable.clusters
    .map((cluster) => buildObservedCandidate(observer, cluster, payloads, context, nowMs))
    .filter((candidate): candidate is StormCandidate => candidate !== null);
  const observedIds = new Set(observed.map((candidate) => candidate.id));
  const kept = forecast.filter((candidate) => !observedIds.has(candidate.observedLightning?.stormId ?? ""));
  return [...observed, ...kept].sort(byScore);
}

/**
 * The best `limit` targets, keeping up to `reservedObserved` places for observed storms:
 * by day they are capped low but should stay visible as live context.
 */
export function selectTopCandidates(candidates: StormCandidate[], limit = TARGET_LIMIT, reservedObserved = RESERVED_OBSERVED) {
  const sorted = [...candidates].sort(byScore);
  const observed = sorted.filter((candidate) => candidate.source === "observed").slice(0, reservedObserved);
  const rest = sorted.filter((candidate) => !observed.includes(candidate)).slice(0, Math.max(0, limit - observed.length));
  return [...observed, ...rest].sort(byScore);
}

// Each storm costs one Xweather access (15,000 a month on the current plan), so only
// observed storms that made the ranked list are checked, best first.
const CG_STORM_LIMIT = 4;
// Sprites need a dark sky and daytime scores are capped anyway, so CG is checked only
// from civil dusk on at the observer.
const CG_MAX_SUN_ALTITUDE_DEG = -6;

/** Adds Xweather CG polarity to the observed storms among `candidates` and re-scores them. */
async function addCgLightning(candidates: StormCandidate[], clusters: LightningCluster[]) {
  const radiusById = new Map(clusters.map((cluster) => [cluster.id, cluster.radiusKm]));
  const checked = candidates.filter((candidate) => candidate.source === "observed" && candidate.observedLightning).slice(0, CG_STORM_LIMIT);
  // The radius covers the lit area plus a margin for strokes at its edge.
  const results = await Promise.allSettled(checked.map((candidate) => fetchCgLightning(candidate.coordinates, (radiusById.get(candidate.id) ?? 30) + 10)));
  const cgById = new Map<string, CgLightning>();
  results.forEach((result, index) => { if (result.status === "fulfilled") cgById.set(checked[index].id, result.value); });
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  const enriched = candidates.map((candidate) => {
    const cg = cgById.get(candidate.id);
    if (!cg || !candidate.observedLightning) return candidate;
    const observedLightning = { ...candidate.observedLightning, cg };
    const scoreInput = { ...candidate.scoreInput, observedLightning };
    return { ...candidate, observedLightning, scoreInput, score: scoreOpportunity({ ...scoreInput, terrain: "unknown" }) };
  });
  return {
    candidates: enriched.sort(byScore),
    checked: checked.length,
    succeeded: cgById.size,
    error: failure ? (failure.reason instanceof Error ? failure.reason.message : "unknown error") : null,
  };
}

// A timed-out fetch rejects with the bare AbortError message; name it plainly.
const errorDetail = (reason: unknown) => (reason instanceof Error ? (reason.name === "AbortError" ? "timeout" : reason.message) : "unknown error");

const serverOnlyLightning = (retrievedAt: string): LightningObservation => ({
  status: "unavailable", retrievedAt, latestFrameAt: null, windowMinutes: 0, clusters: [], message: SERVER_ONLY_MESSAGE,
});

async function loadForecastBase(observer: Coordinates, minimumKm: number, maximumKm: number, serverOnlySources: boolean): Promise<ForecastBase> {
  const cacheKey = `${observer.latitude.toFixed(3)}:${observer.longitude.toFixed(3)}:${minimumKm}:${maximumKm}:${serverOnlySources}`;
  const cached = forecastCache.get(cacheKey);
  if (cached) return cached;
  return forecastInFlight.run(cacheKey, () => fetchForecastBase(cacheKey, observer, minimumKm, maximumKm, serverOnlySources));
}

async function fetchForecastBase(cacheKey: string, observer: Coordinates, minimumKm: number, maximumKm: number, serverOnlySources: boolean): Promise<ForecastBase> {
  const grid = screeningGrid(observer, minimumKm, maximumKm);
  const pathGrid = pathSampleGrid(observer);
  const airParams = new URLSearchParams({
    latitude: observer.latitude.toString(),
    longitude: observer.longitude.toString(),
    hourly: "pm10,pm2_5,dust,aerosol_optical_depth",
    forecast_days: "3",
    timezone: "UTC",
  });

  const screeningBatches = chunks(grid, SCREENING_BATCH_SIZE);
  const useWeatherApi = serverOnlySources && weatherApiConfigured();
  const useOpenWeather = serverOnlySources && openWeatherConfigured();
  const [observerResult, airResult, aviationResult, alertResult, weatherApiResult, openWeatherResult, pathResult, ...screeningResults] = await Promise.allSettled([
    fetchWeatherBatch([observer]),
    fetchJsonWithRetry<unknown>(`https://air-quality-api.open-meteo.com/v1/air-quality?${airParams}`, { retries: 1, timeoutMs: 10_000, deadlineMs: 15_000 }),
    // AviationWeather and MeteoAlarm send no CORS headers, so the browser fallback skips them.
    serverOnlySources ? fetchNearestAviationWeather(observer) : Promise.reject(new Error(SERVER_ONLY_MESSAGE.en)),
    serverOnlySources ? fetchMeteoAlarm(observer) : Promise.reject(new Error(SERVER_ONLY_MESSAGE.en)),
    // Keyed sources stay on the server; the browser fallback never has the keys.
    useWeatherApi ? fetchWeatherApiHours(observer) : Promise.resolve(null),
    useOpenWeather ? fetchOpenWeatherHours(observer) : Promise.resolve(null),
    fetchWeatherBatch(pathGrid, PATH_VARIABLES, false),
    ...screeningBatches.map((batch) => fetchWeatherBatch(batch, SCAN_VARIABLES)),
  ]);

  if (observerResult.status === "rejected") {
    throw new Error(`Open-Meteo forecast unavailable: ${observerResult.reason instanceof Error ? observerResult.reason.message : "unknown error"}`);
  }

  const fetchedAt = new Date().toISOString();
  const airParsed = airResult.status === "fulfilled" ? airSchema.safeParse(airResult.value) : null;
  const sourceState = (result: PromiseSettledResult<unknown>, configured: boolean): SourceState => {
    if (!serverOnlySources) return { status: "unavailable", message: SERVER_ONLY_MESSAGE };
    if (!configured) return { status: "not_configured", message: tx("Χωρίς κλειδί· η νέφωση της θέσης σου βασίζεται στις υπόλοιπες προγνώσεις.", "No key; cloud at your location comes from the other forecasts.") };
    return result.status === "fulfilled"
      ? { status: "available", message: tx("Επιπλέον πρόγνωση νέφωσης για τη θέση σου· η βαθμολογία χρησιμοποιεί τη διάμεσο των πηγών.", "An extra cloud forecast for your location; the score uses the median of the sources.") }
      : { status: "unavailable", message: tx(`Η πρόγνωση δεν απάντησε (${errorDetail(result.reason)}).`, `The forecast did not respond (${errorDetail(result.reason)}).`) };
  };
  const value: ForecastBase = {
    fetchedAt,
    observerForecast: mergeCloudSources(
      weatherHours(observerResult.value[0]),
      weatherApiResult.status === "fulfilled" ? weatherApiResult.value : null,
      openWeatherResult.status === "fulfilled" ? openWeatherResult.value : null,
    ),
    skySources: {
      weatherApi: sourceState(weatherApiResult, useWeatherApi),
      openWeather: sourceState(openWeatherResult, useOpenWeather),
    },
    airQuality: airParsed?.success ? airHours(airParsed.data) : [],
    aviation: aviationResult.status === "fulfilled"
      ? aviationResult.value
      : unavailableAviation(serverOnlySources ? tx("Η πραγματική παρατήρηση METAR δεν ήταν διαθέσιμη.", "The real METAR observation was unavailable.") : SERVER_ONLY_MESSAGE, fetchedAt),
    weatherAlerts: alertResult.status === "fulfilled"
      ? alertResult.value
      : unavailableMeteoAlarm(serverOnlySources ? tx("Η επίσημη ροή προειδοποιήσεων δεν ήταν διαθέσιμη.", "The official warnings feed was unavailable.") : SERVER_ONLY_MESSAGE, fetchedAt),
    payloads: screeningResults.flatMap((result) => result.status === "fulfilled" ? result.value : []),
    // Without them the score falls back to the observer's own sky only.
    pathSamples: pathResult.status === "fulfilled"
      ? pathResult.value.map((payload, index) => ({ bearingDeg: pathGrid[index].bearingDeg, distanceKm: pathGrid[index].distanceKm, hours: weatherHours(payload) }))
      : [],
    screeningFailures: screeningResults.filter((result) => result.status === "rejected").length,
    screeningError: screeningResults.flatMap((result) => result.status === "rejected" ? [errorDetail(result.reason)] : [])[0] ?? null,
    gridSize: grid.length,
  };
  forecastCache.set(cacheKey, value, value.screeningFailures ? PARTIAL_CACHE_TTL_MS : CACHE_TTL_MS);
  return value;
}

export async function fetchOpportunities(
  observer: Coordinates,
  minimumKm = 100,
  maximumKm = 600,
  { serverOnlySources = true }: { serverOnlySources?: boolean } = {},
): Promise<OpportunityResponse> {
  const [base, rawLightning] = await Promise.all([
    loadForecastBase(observer, minimumKm, maximumKm, serverOnlySources),
    // EUMETView frames are decoded on the server; the browser fallback does not repeat that work.
    serverOnlySources
      ? fetchLightningObservation(observer, maximumKm + LIGHTNING_MARGIN_KM)
      : Promise.resolve(serverOnlyLightning(new Date().toISOString())),
  ]);
  const nowMs = Date.now();
  const { fetchedAt, observerForecast, airQuality, aviation, weatherAlerts, payloads, pathSamples, screeningFailures, screeningError, gridSize, skySources } = base;
  const allTargets = buildTargets(observer, payloads, rawLightning, { observerHours: observerForecast, aviation, minimumKm, maximumKm, fetchedAt, nowMs, pathSamples });
  const xweatherReady = serverOnlySources && xweatherConfigured();
  const darkEnough = skyState(new Date(nowMs), observer.latitude, observer.longitude, 0).sunAltitudeDeg <= CG_MAX_SUN_ALTITUDE_DEG;
  const quotaLeft = xweatherQuotaAllows(nowMs);
  const useXweather = xweatherReady && darkEnough && quotaLeft;
  const cgCheck = useXweather ? await addCgLightning(selectTopCandidates(allTargets), rawLightning.clusters) : null;
  const candidates = cgCheck?.candidates ?? selectTopCandidates(allTargets);
  const observedCount = candidates.filter((candidate) => candidate.source === "observed").length;
  // Ages are recomputed per response; the observation itself is cached for a few minutes.
  // Scoring used every storm; the response lists the largest only.
  const lightning: LightningObservation = {
    ...rawLightning,
    clusters: rawLightning.clusters.slice(0, LISTED_STORMS).map((cluster) => ({ ...cluster, ageMinutes: Math.max(0, Math.round((nowMs - Date.parse(cluster.observedAt)) / 60_000)) })),
    inRangeCount: allTargets.filter((candidate) => candidate.source === "observed").length,
  };

  const xweather: { status: DataStatus; message: Localized } = !xweatherReady
    ? { status: "not_configured", message: tx("Χωρίς κλειδί. Με κλειδί Xweather η εφαρμογή ελέγχει τους θετικούς κεραυνούς +CG και την ένταση ρεύματος σε κάθε παρατηρημένη καταιγίδα, που είναι ο κύριος εκκινητής των sprites.", "No key. With an Xweather key the app checks positive +CG strokes and their peak current in every observed storm, the main trigger of sprites.") }
    : !darkEnough
      ? { status: "available", message: tx("Ρυθμισμένο· οι θετικοί κεραυνοί +CG ελέγχονται μόλις σκοτεινιάσει (ήλιος κάτω από −6°), ώστε να μην ξοδεύονται μονάδες τη μέρα.", "Configured; positive +CG strokes are checked once it is dark (Sun below −6°) so no accesses are spent by day.") }
    : !quotaLeft
      ? { status: "stale", message: tx("Το σημερινό μερίδιο ή το μηνιαίο όριο του Xweather εξαντλήθηκε· οι έλεγχοι +CG ξαναρχίζουν την επόμενη μέρα (UTC) ή με την ανανέωση της περιόδου.", "Today's share or the monthly Xweather allowance is used up; +CG checks resume the next UTC day or when the period resets.") }
    : !cgCheck?.checked
      ? { status: "available", message: tx("Ρυθμισμένο· δεν υπάρχει παρατηρημένη καταιγίδα στην ακτίνα σάρωσης για έλεγχο +CG.", "Configured; no observed storm in the scan range to check for +CG.") }
      : cgCheck.succeeded
        ? { status: "available", message: tx(`Θετικοί και αρνητικοί κεραυνοί CG με ένταση ρεύματος για ${cgCheck.succeeded} ${cgCheck.succeeded === 1 ? "καταιγίδα" : "καταιγίδες"} (τελευταία ${CG_WINDOW_MINUTES}′).`, `Positive and negative CG strokes with peak current for ${cgCheck.succeeded} ${cgCheck.succeeded === 1 ? "storm" : "storms"} (last ${CG_WINDOW_MINUTES}′).`) }
        : { status: "unavailable", message: tx(`Το Xweather δεν απάντησε (${cgCheck.error ?? "άγνωστο σφάλμα"}).`, `Xweather did not respond (${cgCheck.error ?? "unknown error"}).`) };
  const screeningStatus = screeningFailures === 0 ? "available" : payloads.length ? "stale" : "unavailable";
  const hasLightningPotential = candidates.some((candidate) => candidate.lightningPotentialJkg != null);
  const screeningMessage = screeningFailures === 0
    ? tx(`Πρόγνωση θέσης και ${payloads.length} κυψέλες σάρωσης διαθέσιμες.`, `Observer forecast and ${payloads.length} scan cells available.`)
    : tx(`Πρόγνωση θέσης διαθέσιμη· απάντησαν ${payloads.length}/${gridSize} κυψέλες σάρωσης (${screeningFailures} αποτυχημένα αιτήματα: ${screeningError}). Νέα προσπάθεια στην επόμενη ανανέωση.`, `Observer forecast available; ${payloads.length}/${gridSize} scan cells answered (${screeningFailures} failed requests: ${screeningError}). Retried on the next refresh.`);
  return {
    observer,
    fetchedAt,
    observerForecast,
    airQuality,
    aviation,
    weatherAlerts,
    lightning,
    candidates,
    providers: [
      { id: "open_meteo", label: tx("Open-Meteo Forecast", "Open-Meteo Forecast"), status: screeningStatus, checkedAt: fetchedAt, message: screeningMessage },
      { id: "mtg_li", label: tx("EUMETSAT MTG-LI κεραυνοί", "EUMETSAT MTG-LI lightning"), status: lightning.status, checkedAt: lightning.retrievedAt, message: lightning.message },
      {
        id: "open_meteo_lpi",
        label: tx("Open-Meteo lightning potential", "Open-Meteo lightning potential"),
        status: hasLightningPotential ? "available" : "unsupported",
        checkedAt: fetchedAt,
        message: hasLightningPotential
          ? tx("Δωρεάν προγνωστικός δείκτης μοντέλου (J/kg) — όχι παρατηρημένα χτυπήματα κεραυνών.", "Free model forecast index (J/kg), not observed lightning strikes.")
          : tx("Δεν υποστηρίζεται από το επιλεγμένο μοντέλο/την περιοχή· δεν αντικαθίσταται με τεχνητές τιμές.", "Not supported by the selected model or region; no artificial values are substituted."),
      },
      {
        id: "air_quality",
        label: tx("Open-Meteo Air Quality", "Open-Meteo Air Quality"),
        status: airQuality.length ? "available" : "unavailable",
        checkedAt: fetchedAt,
        message: airQuality.length ? tx("Πρόγνωση CAMS για σκόνη, AOD και σωματίδια.", "CAMS forecast for dust, AOD and particles.") : tx("Η πρόγνωση ποιότητας αέρα δεν ήταν διαθέσιμη.", "The air-quality forecast was unavailable."),
      },
      { id: "aviation_weather", label: tx("AviationWeather METAR / TAF", "AviationWeather METAR / TAF"), status: aviation.status, checkedAt: fetchedAt, message: aviation.message },
      { id: "meteoalarm", label: tx("MeteoAlarm Ελλάδα", "MeteoAlarm Greece"), status: weatherAlerts.status, checkedAt: fetchedAt, message: weatherAlerts.message },
      { id: "rainviewer", label: tx("RainViewer radar", "RainViewer radar"), status: "stale", checkedAt: fetchedAt, message: tx("Η live κατάσταση ελέγχεται χωριστά στον χάρτη· η κάλυψη είναι best-effort και χωρίς SLA.", "Live status is checked separately on the map; coverage is best-effort with no SLA.") },
      { id: "xweather", label: tx("Vaisala Xweather +CG", "Vaisala Xweather +CG"), status: xweather.status, checkedAt: fetchedAt, message: xweather.message },
      { id: "weatherapi", label: tx("WeatherAPI.com νέφωση", "WeatherAPI.com cloud"), status: skySources.weatherApi.status, checkedAt: fetchedAt, message: skySources.weatherApi.message },
      { id: "openweather", label: tx("OpenWeatherMap νέφωση", "OpenWeatherMap cloud"), status: skySources.openWeather.status, checkedAt: fetchedAt, message: skySources.openWeather.message },
      { id: "terrain", label: tx("OpenTopoData SRTM", "OpenTopoData SRTM"), status: "stale", checkedAt: fetchedAt, message: tx("Ο ορίζοντας DEM ελέγχεται μετά τη σάρωση για όλους τους στόχους της λίστας, με ένα αίτημα και cache μίας εβδομάδας ανά διεύθυνση.", "The DEM horizon is checked after the scan for every listed target, in one request with a week-long cache per bearing.") },
    ],
    warnings: [
      observedCount
        ? tx("Οι στόχοι «παρατηρημένη καταιγίδα» βασίζονται σε πραγματικούς κεραυνούς MTG-LI· οι υπόλοιποι είναι προγνωστικές κυψέλες μοντέλου.", "\"Observed storm\" targets are based on real MTG-LI lightning; the rest are model forecast cells.")
        : tx("Οι υποψήφιοι στόχοι είναι προγνωστικές κυψέλες μοντέλου και όχι παρατηρημένες καταιγίδες.", "The candidate targets are model forecast cells, not observed storms."),
      tx("Ο δείκτης 0–100 είναι ευρετική βαθμολογία ευκαιρίας, όχι ποσοστό πιθανότητας εμφάνισης TLE.", "The 0–100 index is a heuristic opportunity score, not a probability of seeing a TLE."),
      ...(screeningFailures ? [tx("Μερικά τμήματα της γεωγραφικής σάρωσης δεν απάντησαν. Τα διαθέσιμα δεδομένα εμφανίζονται χωρίς συνθετική συμπλήρωση.", "Some parts of the geographic scan did not respond. The available data is shown without synthetic filling.")] : []),
    ],
  };
}
