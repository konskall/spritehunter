import { z } from "zod";
import type {
  AirQualityHour,
  AviationObservation,
  CandidateScoreInput,
  Coordinates,
  LightningCluster,
  LightningObservation,
  ObservedLightning,
  OpportunityResponse,
  StormCandidate,
  WeatherHour,
} from "@/lib/domain";
import { altitudeEnvelope, destinationPoint, inverseGeodesic } from "@/lib/geodesy";
import { skyState } from "@/lib/astronomy";
import { scoreOpportunity } from "@/lib/scoring";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";
import { InFlight, TtlCache } from "@/lib/bounded-cache";
import { fetchNearestAviationWeather, unavailableAviation } from "@/lib/providers/aviation-weather";
import { fetchMeteoAlarm, unavailableMeteoAlarm } from "@/lib/providers/meteoalarm";
import { fetchLightningObservation } from "@/lib/providers/mtg-lightning";

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
const CACHE_TTL_MS = 15 * 60_000;
const SERVER_ONLY_MESSAGE = "Διαθέσιμο μόνο μέσω του server της εφαρμογής (ο πάροχος δεν επιτρέπει κλήσεις από browser).";
// Candidates are only searched over the next 48 h; fetching more only slowed the provider.
const FORECAST_HOURS = 48;
const CANDIDATE_WINDOW_HOURS = 48;
// Two screening requests: fewer parallel calls avoid Open-Meteo 429 bursts.
const SCREENING_BATCH_SIZE = 12;
// Forecast data changes hourly; lightning is merged on every request from its own 4-minute cache.
interface ForecastBase {
  fetchedAt: string;
  observerForecast: WeatherHour[];
  airQuality: AirQualityHour[];
  aviation: AviationObservation;
  weatherAlerts: OpportunityResponse["weatherAlerts"];
  payloads: WeatherPayload[];
  screeningFailures: number;
  gridSize: number;
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

function makeScreeningGrid(observer: Coordinates, minimumKm: number, maximumKm: number) {
  const span = maximumKm - minimumKm;
  const distances = [minimumKm + span * 0.2, minimumKm + span * 0.55, minimumKm + span * 0.9];
  return distances.flatMap((distanceKm) =>
    Array.from({ length: 8 }, (_, index) => destinationPoint(observer, distanceKm, index * 45)),
  );
}

function weatherUrl(points: Coordinates[]) {
  const params = new URLSearchParams({
    latitude: points.map((point) => point.latitude.toFixed(5)).join(","),
    longitude: points.map((point) => point.longitude.toFixed(5)).join(","),
    hourly: WEATHER_VARIABLES.join(","),
    minutely_15: "lightning_potential",
    forecast_minutely_15: String(FORECAST_HOURS * 4),
    forecast_hours: String(FORECAST_HOURS),
    timezone: "UTC",
  });
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

async function fetchWeatherBatch(points: Coordinates[]) {
  const raw = await fetchJsonWithRetry<unknown>(weatherUrl(points), {
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

function stormSignal(hour: WeatherHour) {
  const cape = hour.capeJkg ?? 0;
  const precipitation = hour.precipitationMm ?? 0;
  const cinPenalty = Math.min(5, Math.max(0, (hour.convectiveInhibitionJkg ?? 0) - 75) / 35);
  const liftedBoost = Math.max(0, -(hour.liftedIndex ?? 0)) * 1.4;
  const moistureBoost = Math.max(0, (hour.precipitableWaterKgM2 ?? 20) - 24) / 4;
  const thunderCode = hour.weatherCode != null && [95, 96, 99].includes(hour.weatherCode);
  return cape / 80 + precipitation * 2 + liftedBoost + moistureBoost + (thunderCode ? 8 : 0) - cinPenalty;
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

function scoreInputForHour(
  observer: Coordinates,
  hour: WeatherHour,
  thunderCode: boolean,
  lightningPotentialJkg: number | null,
  observerHours: WeatherHour[],
  aviation: AviationObservation,
  geometry: { distanceM: number; initialBearingDeg: number },
): CandidateScoreInput {
  const observerHour = closestHour(observerHours, hour.time) ?? observerHours[0];
  // A METAR is a point observation: only fresh, nearby reports close in time to the
  // valid hour may replace the forecast, and only for what it measures (low/mid cloud,
  // visibility). It cannot see high cirrus, so high cloud always comes from the model.
  const metarRelevant = aviation.status === "available"
    && aviation.observedAt != null
    && (aviation.distanceKm ?? Number.POSITIVE_INFINITY) <= 180
    && Math.abs(new Date(hour.time).getTime() - new Date(aviation.observedAt).getTime()) <= 3 * 60 * 60_000;
  const metarCloud = metarRelevant ? aviation.cloudCoverPercent : null;
  const metarVisibility = metarRelevant ? aviation.visibilityM : null;
  const sky = skyState(new Date(hour.time), observer.latitude, observer.longitude, geometry.initialBearingDeg);
  return {
    capeJkg: hour.capeJkg,
    convectiveInhibitionJkg: hour.convectiveInhibitionJkg,
    liftedIndex: hour.liftedIndex,
    precipitableWaterKgM2: hour.precipitableWaterKgM2,
    precipitationMm: hour.precipitationMm,
    thunderCode,
    lightningPotentialJkg,
    observerCloudPercent: metarCloud ?? observerHour?.cloudCover ?? null,
    observerHighCloudPercent: observerHour?.cloudCoverHigh ?? null,
    visibilityM: metarVisibility ?? observerHour?.visibilityM ?? null,
    atmosphereSource: metarCloud != null || metarVisibility != null ? "observation" : "forecast",
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

  // Score every qualifying hour and keep the best opportunity, so a stronger
  // daytime convective peak (capped at 29 by daylight) cannot hide a usable night.
  const best = hours
    .filter((_, index) => times[index] >= windowStart)
    .slice(0, CANDIDATE_WINDOW_HOURS)
    .flatMap((hour) => {
      const cape = hour.capeJkg ?? 0;
      const precipitation = hour.precipitationMm ?? 0;
      const thunderCode = isThunderCode(hour.weatherCode);
      if (!thunderCode && !(cape >= 250 && precipitation >= 0.2) && cape < 600) return [];
      // Hours near the newest MTG-LI frame are confirmed or contradicted per hour, so a
      // contradicted "now" cannot hide a later hour of the same cell.
      const scoreInput: CandidateScoreInput = {
        ...scoreInputForHour(observer, hour, thunderCode, lightningPotentialAt(target, hour.time), observerHours, aviation, geometry),
        ...lightningForHour(lightningCheck, coordinates, hour.time),
      };
      return [{ hour, scoreInput, score: scoreOpportunity({ ...scoreInput, terrain: "unknown" }), signal: stormSignal(hour) }];
    })
    .sort((a, b) => b.score.total - a.score.total || b.signal - a.signal)[0];
  if (!best) return null;

  const { hour, scoreInput, score } = best;
  const pointing = altitudeEnvelope(observer, coordinates);
  const lightningPotentialJkg = scoreInput.lightningPotentialJkg ?? null;
  const uncertaintyKm = Math.round(35 + Math.min(45, (hour.windSpeedKmh ?? 0) * 1.5));

  return {
    id: `forecast-${target.latitude.toFixed(2)}-${target.longitude.toFixed(2)}-${hour.time}`,
    coordinates,
    forecastValidAt: hour.time,
    distanceKm: Math.round((geometry.distanceM / 1000) * 10) / 10,
    bearingDeg: Math.round(geometry.initialBearingDeg * 10) / 10,
    uncertaintyKm,
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
    ...scoreInputForHour(observer, hour, isThunderCode(hour.weatherCode), model ? lightningPotentialAt(model, cluster.observedAt) : null, context.observerHours, context.aviation, geometry),
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
    uncertaintyKm: Math.round(Math.max(20, Math.min(90, cluster.radiusKm + 15))),
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
      resolution: "Accumulated Flash Area, πλέγμα ~0,04°",
      status: "available",
      freshnessMinutes: detail.ageMinutes,
      quality: "medium",
      message: "Παρατηρημένη κεραυνική δραστηριότητα από δορυφόρο· δεν διακρίνει CG/IC ούτε πολικότητα.",
    },
  };
}

const byScore = (a: StormCandidate, b: StormCandidate) => b.score.total - a.score.total;

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
  const forecast = payloads
    .map((payload) => buildCandidate(observer, payload, context.observerHours, context.aviation, context.fetchedAt, nowMs, check))
    .filter((candidate): candidate is StormCandidate => candidate !== null);
  if (!usable) return forecast.sort(byScore);
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
  const grid = makeScreeningGrid(observer, minimumKm, maximumKm);
  const airParams = new URLSearchParams({
    latitude: observer.latitude.toString(),
    longitude: observer.longitude.toString(),
    hourly: "pm10,pm2_5,dust,aerosol_optical_depth",
    forecast_days: "3",
    timezone: "UTC",
  });

  const screeningBatches = chunks(grid, SCREENING_BATCH_SIZE);
  const [observerResult, airResult, aviationResult, alertResult, ...screeningResults] = await Promise.allSettled([
    fetchWeatherBatch([observer]),
    fetchJsonWithRetry<unknown>(`https://air-quality-api.open-meteo.com/v1/air-quality?${airParams}`, { retries: 1, timeoutMs: 10_000, deadlineMs: 15_000 }),
    // AviationWeather and MeteoAlarm send no CORS headers, so the browser fallback skips them.
    serverOnlySources ? fetchNearestAviationWeather(observer) : Promise.reject(new Error(SERVER_ONLY_MESSAGE)),
    serverOnlySources ? fetchMeteoAlarm(observer) : Promise.reject(new Error(SERVER_ONLY_MESSAGE)),
    ...screeningBatches.map((batch) => fetchWeatherBatch(batch)),
  ]);

  if (observerResult.status === "rejected") {
    throw new Error(`Open-Meteo forecast unavailable: ${observerResult.reason instanceof Error ? observerResult.reason.message : "unknown error"}`);
  }

  const fetchedAt = new Date().toISOString();
  const airParsed = airResult.status === "fulfilled" ? airSchema.safeParse(airResult.value) : null;
  const value: ForecastBase = {
    fetchedAt,
    observerForecast: weatherHours(observerResult.value[0]),
    airQuality: airParsed?.success ? airHours(airParsed.data) : [],
    aviation: aviationResult.status === "fulfilled"
      ? aviationResult.value
      : unavailableAviation(serverOnlySources ? "Η πραγματική παρατήρηση METAR δεν ήταν διαθέσιμη." : SERVER_ONLY_MESSAGE, fetchedAt),
    weatherAlerts: alertResult.status === "fulfilled"
      ? alertResult.value
      : unavailableMeteoAlarm(serverOnlySources ? "Η επίσημη ροή προειδοποιήσεων δεν ήταν διαθέσιμη." : SERVER_ONLY_MESSAGE, fetchedAt),
    payloads: screeningResults.flatMap((result) => result.status === "fulfilled" ? result.value : []),
    screeningFailures: screeningResults.filter((result) => result.status === "rejected").length,
    gridSize: grid.length,
  };
  forecastCache.set(cacheKey, value, CACHE_TTL_MS);
  return value;
}

export async function fetchOpportunities(
  observer: Coordinates,
  minimumKm = 200,
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
  const { fetchedAt, observerForecast, airQuality, aviation, weatherAlerts, payloads, screeningFailures, gridSize } = base;
  const allTargets = buildTargets(observer, payloads, rawLightning, { observerHours: observerForecast, aviation, minimumKm, maximumKm, fetchedAt, nowMs });
  const candidates = selectTopCandidates(allTargets);
  const observedCount = candidates.filter((candidate) => candidate.source === "observed").length;
  // Ages are recomputed per response; the observation itself is cached for a few minutes.
  const lightning: LightningObservation = {
    ...rawLightning,
    clusters: rawLightning.clusters.map((cluster) => ({ ...cluster, ageMinutes: Math.max(0, Math.round((nowMs - Date.parse(cluster.observedAt)) / 60_000)) })),
    inRangeCount: allTargets.filter((candidate) => candidate.source === "observed").length,
  };

  const xweatherConfigured = typeof process !== "undefined" && Boolean(process.env.XWEATHER_CLIENT_ID && process.env.XWEATHER_CLIENT_SECRET);
  const screeningStatus = screeningFailures === 0 ? "available" : payloads.length ? "stale" : "unavailable";
  const hasLightningPotential = candidates.some((candidate) => candidate.lightningPotentialJkg != null);
  const screeningMessage = screeningFailures === 0
    ? `Πρόγνωση θέσης και ${payloads.length} κυψέλες σάρωσης διαθέσιμες.`
    : `Πρόγνωση θέσης διαθέσιμη· απάντησαν ${payloads.length}/${gridSize} κυψέλες σάρωσης (${screeningFailures} αποτυχίες).`;
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
      { id: "open_meteo", label: "Open-Meteo Forecast", status: screeningStatus, checkedAt: fetchedAt, message: screeningMessage },
      { id: "mtg_li", label: "EUMETSAT MTG-LI κεραυνοί", status: lightning.status, checkedAt: lightning.retrievedAt, message: lightning.message },
      {
        id: "open_meteo_lpi",
        label: "Open-Meteo lightning potential",
        status: hasLightningPotential ? "available" : "unsupported",
        checkedAt: fetchedAt,
        message: hasLightningPotential
          ? "Δωρεάν προγνωστικός δείκτης μοντέλου (J/kg) — όχι παρατηρημένα χτυπήματα κεραυνών."
          : "Δεν υποστηρίζεται από το επιλεγμένο μοντέλο/την περιοχή· δεν αντικαθίσταται με τεχνητές τιμές.",
      },
      {
        id: "air_quality",
        label: "Open-Meteo Air Quality",
        status: airQuality.length ? "available" : "unavailable",
        checkedAt: fetchedAt,
        message: airQuality.length ? "Πρόγνωση CAMS για σκόνη, AOD και σωματίδια." : "Η πρόγνωση ποιότητας αέρα δεν ήταν διαθέσιμη.",
      },
      { id: "aviation_weather", label: "AviationWeather METAR / TAF", status: aviation.status, checkedAt: fetchedAt, message: aviation.message },
      { id: "meteoalarm", label: "MeteoAlarm Ελλάδα", status: weatherAlerts.status, checkedAt: fetchedAt, message: weatherAlerts.message },
      { id: "rainviewer", label: "RainViewer radar", status: "stale", checkedAt: fetchedAt, message: "Η live κατάσταση ελέγχεται χωριστά στον χάρτη· η κάλυψη είναι best-effort και χωρίς SLA." },
      {
        id: "xweather",
        label: "Vaisala Xweather (προαιρετικό)",
        status: xweatherConfigured ? "available" : "not_configured",
        checkedAt: fetchedAt,
        message: xweatherConfigured ? "Τα credentials έχουν ρυθμιστεί· οι κλήσεις περιορίζονται σε επιλεγμένες περιοχές στόχων." : "Δεν απαιτείται: το δωρεάν MTG-LI τροφοδοτεί ήδη τη βαθμολογία με παρατηρημένους κεραυνούς. Xweather χρειάζεται μόνο για δεδομένα CG/IC, πολικότητας και peak current.",
      },
      { id: "terrain", label: "OpenTopoData SRTM", status: "stale", checkedAt: fetchedAt, message: "Το DEM ελέγχεται μόνο κατά την επιλογή στόχου, ώστε να προστατεύεται το δημόσιο quota." },
    ],
    warnings: [
      observedCount
        ? "Οι στόχοι «παρατηρημένη καταιγίδα» βασίζονται σε πραγματικούς κεραυνούς MTG-LI· οι υπόλοιποι είναι προγνωστικές κυψέλες μοντέλου."
        : "Οι υποψήφιοι στόχοι είναι προγνωστικές κυψέλες μοντέλου και όχι παρατηρημένες καταιγίδες.",
      "Ο δείκτης 0–100 είναι ευρετική βαθμολογία ευκαιρίας, όχι ποσοστό πιθανότητας εμφάνισης TLE.",
      ...(screeningFailures ? ["Μερικά τμήματα της γεωγραφικής σάρωσης δεν απάντησαν. Τα διαθέσιμα δεδομένα εμφανίζονται χωρίς συνθετική συμπλήρωση."] : []),
    ],
  };
}
