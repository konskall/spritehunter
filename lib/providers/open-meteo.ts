import { z } from "zod";
import type {
  AirQualityHour,
  Coordinates,
  OpportunityResponse,
  StormCandidate,
  WeatherHour,
} from "@/lib/domain";
import { altitudeEnvelope, destinationPoint, inverseGeodesic } from "@/lib/geodesy";
import { skyState } from "@/lib/astronomy";
import { scoreOpportunity } from "@/lib/scoring";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";

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
    weather_code: numberArray.optional(),
  }),
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

type WeatherPayload = z.infer<typeof weatherSchema>;
const CACHE_TTL_MS = 15 * 60_000;
const opportunityCache = new Map<string, { expires: number; value: OpportunityResponse }>();

function valueAt(values: Array<number | null> | undefined, index: number) {
  return values?.[index] ?? null;
}

function weatherHours(payload: WeatherPayload): WeatherHour[] {
  return payload.hourly.time.map((time, index) => ({
    time,
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
    weatherCode: valueAt(payload.hourly.weather_code, index),
  }));
}

function airHours(payload: z.infer<typeof airSchema>): AirQualityHour[] {
  return payload.hourly.time.map((time, index) => ({
    time,
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

function stormSignal(hour: WeatherHour) {
  const cape = hour.capeJkg ?? 0;
  const precipitation = hour.precipitationMm ?? 0;
  const thunderCode = hour.weatherCode != null && [95, 96, 99].includes(hour.weatherCode);
  return cape / 80 + precipitation * 2 + (thunderCode ? 8 : 0);
}

function candidateFromPoint(
  observer: Coordinates,
  target: WeatherPayload,
  observerHours: WeatherHour[],
  fetchedAt: string,
): StormCandidate | null {
  const hours = weatherHours(target);
  const now = Date.now() - 60 * 60_000;
  const valid = hours
    .map((hour, index) => ({ hour, index, signal: stormSignal(hour) }))
    .filter(({ hour }) => new Date(hour.time).getTime() >= now)
    .slice(0, 48)
    .sort((a, b) => b.signal - a.signal)[0];
  if (!valid) return null;
  const cape = valid.hour.capeJkg ?? 0;
  const precipitation = valid.hour.precipitationMm ?? 0;
  const thunderCode = valid.hour.weatherCode != null && [95, 96, 99].includes(valid.hour.weatherCode);
  if (!thunderCode && !(cape >= 250 && precipitation >= 0.2) && cape < 600) return null;

  const coordinates: Coordinates = {
    latitude: target.latitude,
    longitude: target.longitude,
    elevationM: target.elevation ?? 0,
  };
  const geometry = inverseGeodesic(observer, coordinates);
  const pointing = altitudeEnvelope(observer, coordinates);
  const observerHour = observerHours[valid.index] ?? observerHours[0];
  const sky = skyState(new Date(valid.hour.time), observer.latitude, observer.longitude, geometry.initialBearingDeg);
  const score = scoreOpportunity({
    capeJkg: valid.hour.capeJkg,
    precipitationMm: valid.hour.precipitationMm,
    thunderCode,
    observerCloudPercent: observerHour?.cloudCover ?? null,
    observerHighCloudPercent: observerHour?.cloudCoverHigh ?? null,
    visibilityM: observerHour?.visibilityM ?? null,
    distanceKm: geometry.distanceM / 1000,
    sunAltitudeDeg: sky.sunAltitudeDeg,
    moonInterference: sky.moonInterference,
    terrain: "unknown",
    lightning: "not_configured",
  });
  const uncertaintyKm = Math.round(35 + Math.min(45, (valid.hour.windSpeedKmh ?? 0) * 1.5));

  return {
    id: `forecast-${target.latitude.toFixed(2)}-${target.longitude.toFixed(2)}-${valid.hour.time}`,
    coordinates,
    forecastValidAt: valid.hour.time,
    distanceKm: Math.round((geometry.distanceM / 1000) * 10) / 10,
    bearingDeg: Math.round(geometry.initialBearingDeg * 10) / 10,
    uncertaintyKm,
    capeJkg: valid.hour.capeJkg,
    precipitationMm: valid.hour.precipitationMm,
    weatherCode: valid.hour.weatherCode,
    highCloudPercent: valid.hour.cloudCoverHigh,
    windSpeedKmh: valid.hour.windSpeedKmh,
    windDirectionDeg: valid.hour.windDirectionDeg,
    pointing,
    score,
    source: "forecast",
    provenance: {
      provider: "Open-Meteo",
      kind: "forecast",
      observedAt: null,
      validAt: valid.hour.time,
      retrievedAt: fetchedAt,
      resolution: "Coarse geographic screening; model-dependent grid",
      status: "available",
      freshnessMinutes: 0,
      quality: "medium",
      message: "Forecast model cell, not an observed storm centroid or lightning event.",
    },
  };
}

export async function fetchOpportunities(
  observer: Coordinates,
  minimumKm = 200,
  maximumKm = 600,
): Promise<OpportunityResponse> {
  const cacheKey = `${observer.latitude.toFixed(3)}:${observer.longitude.toFixed(3)}:${minimumKm}:${maximumKm}`;
  const cached = opportunityCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  const grid = makeScreeningGrid(observer, minimumKm, maximumKm);
  const points = [observer, ...grid];
  const params = new URLSearchParams({
    latitude: points.map((point) => point.latitude.toFixed(5)).join(","),
    longitude: points.map((point) => point.longitude.toFixed(5)).join(","),
    hourly: [
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
      "weather_code",
    ].join(","),
    forecast_days: "3",
    timezone: "UTC",
  });
  const airParams = new URLSearchParams({
    latitude: observer.latitude.toString(),
    longitude: observer.longitude.toString(),
    hourly: "pm10,pm2_5,dust,aerosol_optical_depth",
    forecast_days: "3",
    timezone: "UTC",
  });

  const [weatherResult, airResult] = await Promise.allSettled([
    fetchJsonWithRetry<unknown>(`https://api.open-meteo.com/v1/forecast?${params}`),
    fetchJsonWithRetry<unknown>(`https://air-quality-api.open-meteo.com/v1/air-quality?${airParams}`),
  ]);

  if (weatherResult.status === "rejected") {
    throw new Error(`Open-Meteo forecast unavailable: ${weatherResult.reason instanceof Error ? weatherResult.reason.message : "unknown error"}`);
  }

  const parsedBatch = z.array(weatherSchema).safeParse(weatherResult.value);
  const parsedSingle = weatherSchema.safeParse(weatherResult.value);
  const payloads = parsedBatch.success ? parsedBatch.data : parsedSingle.success ? [parsedSingle.data] : null;
  if (!payloads || payloads.length < 2) throw new Error("Open-Meteo returned an unsupported response shape.");

  const fetchedAt = new Date().toISOString();
  const observerForecast = weatherHours(payloads[0]);
  const airParsed = airResult.status === "fulfilled" ? airSchema.safeParse(airResult.value) : null;
  const airQuality = airParsed?.success ? airHours(airParsed.data) : [];
  const candidates = payloads
    .slice(1)
    .map((payload) => candidateFromPoint(observer, payload, observerForecast, fetchedAt))
    .filter((candidate): candidate is StormCandidate => candidate !== null)
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, 10);

  const xweatherConfigured = Boolean(process.env.XWEATHER_CLIENT_ID && process.env.XWEATHER_CLIENT_SECRET);
  const value: OpportunityResponse = {
    observer,
    fetchedAt,
    observerForecast,
    airQuality,
    candidates,
    providers: [
      { id: "open_meteo", label: "Open-Meteo Forecast", status: "available", checkedAt: fetchedAt, message: "Forecast grid and observer weather available." },
      {
        id: "air_quality",
        label: "Open-Meteo Air Quality",
        status: airQuality.length ? "available" : "unavailable",
        checkedAt: fetchedAt,
        message: airQuality.length ? "CAMS forecast is available." : "Air-quality response was unavailable or unsupported.",
      },
      { id: "rainviewer", label: "RainViewer radar", status: "available", checkedAt: fetchedAt, message: "Public radar metadata is queried on the map; coverage is best-effort." },
      {
        id: "xweather",
        label: "Vaisala Xweather lightning",
        status: xweatherConfigured ? "available" : "not_configured",
        checkedAt: fetchedAt,
        message: xweatherConfigured ? "Credentials configured; queries are limited to selected candidate regions." : "No paid lightning-provider credentials configured.",
      },
      { id: "terrain", label: "OpenTopoData SRTM", status: "available", checkedAt: fetchedAt, message: "Terrain is requested on demand for the selected bearing to conserve the public quota." },
    ],
    warnings: [
      "Οι υποψήφιοι στόχοι είναι προγνωστικές κυψέλες μοντέλου και όχι παρατηρημένες καταιγίδες.",
      "Ο δείκτης 0–100 είναι ευρετική βαθμολογία ευκαιρίας, όχι ποσοστό πιθανότητας εμφάνισης TLE.",
    ],
  };
  opportunityCache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}

