import { z } from "zod";
import type { AirQualityConditions, Coordinates, PollenType, StationConditions, StationDay, StationHour, WeatherStationResponse } from "@/lib/domain";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";
import { InFlight, TtlCache } from "@/lib/bounded-cache";
import { tx } from "@/lib/i18n";

// The weather screen: conditions, 48 hours and 7 days at the observer from Open-Meteo's best
// model mix, and CAMS air quality. Times come as Unix seconds, so hourly values stay exact across
// a clock change. Daily values are summed over Athens days, but Open-Meteo applies one UTC offset
// (the one at request time) to the whole response: after a clock change within the 7 days, those
// days run 23:00–23:00 (or 01:00–01:00) local time. Their dates stay right.

const CACHE_TTL_MS = 15 * 60_000;
// Hours before now, for the 3-hour pressure tendency.
const PAST_HOURS = 6;
const FORECAST_HOURS = 48;
const FORECAST_DAYS = 7;
const AIR_QUALITY_DAYS = 3;
const TIME_ZONE = "Europe/Athens";

const CURRENT_VARIABLES = [
  "temperature_2m", "apparent_temperature", "relative_humidity_2m", "dew_point_2m", "pressure_msl",
  "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "cloud_cover", "precipitation",
  "visibility", "uv_index", "weather_code", "is_day",
];
const HOURLY_VARIABLES = [
  ...CURRENT_VARIABLES, "precipitation_probability", "cloud_cover_low", "cloud_cover_mid",
  "cloud_cover_high", "cape", "lifted_index", "convective_inhibition", "freezing_level_height",
];
const DAILY_VARIABLES = [
  "weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_sum",
  "precipitation_probability_max", "precipitation_hours", "wind_speed_10m_max", "wind_gusts_10m_max",
  "wind_direction_10m_dominant", "uv_index_max", "sunshine_duration",
];
const POLLEN: Record<PollenType, string> = {
  alder: "alder_pollen", birch: "birch_pollen", grass: "grass_pollen", mugwort: "mugwort_pollen", olive: "olive_pollen", ragweed: "ragweed_pollen",
};
const AIR_VARIABLES = [
  "european_aqi", "european_aqi_pm2_5", "european_aqi_pm10", "european_aqi_nitrogen_dioxide", "european_aqi_ozone",
  "european_aqi_sulphur_dioxide", "pm2_5", "pm10", "carbon_monoxide", "nitrogen_dioxide", "sulphur_dioxide", "ozone",
  "dust", "aerosol_optical_depth", ...Object.values(POLLEN),
];

const value = z.number().nullable().optional();
const series = z.array(z.number().nullable()).optional();
const seriesOf = (names: string[]) => z.object({ time: z.array(z.number()), ...Object.fromEntries(names.map((name) => [name, series])) });

const forecastSchema = z.object({
  elevation: z.number().optional(),
  current: z.object({ time: z.number(), ...Object.fromEntries(CURRENT_VARIABLES.map((name) => [name, value])) }).optional(),
  hourly: seriesOf(HOURLY_VARIABLES),
  daily: seriesOf(DAILY_VARIABLES),
});
const airSchema = z.object({
  current: z.object({ time: z.number(), ...Object.fromEntries(AIR_VARIABLES.map((name) => [name, value])) }).optional(),
  hourly: seriesOf(AIR_VARIABLES),
});

type Row = Record<string, number | null | undefined>;

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();
const read = (row: Row, name: string) => row[name] ?? null;

/** Row `index` of a parsed column set, as {variable: value}. */
function rowAt(columns: Record<string, unknown>, index: number): Row {
  const row: Row = {};
  for (const [name, column] of Object.entries(columns)) if (name !== "time" && Array.isArray(column)) row[name] = column[index] as number | null;
  return row;
}

function conditions(time: number, row: Row): StationConditions {
  const isDay = read(row, "is_day");
  return {
    time: iso(time),
    temperatureC: read(row, "temperature_2m"),
    apparentTemperatureC: read(row, "apparent_temperature"),
    relativeHumidity: read(row, "relative_humidity_2m"),
    dewPointC: read(row, "dew_point_2m"),
    pressureHpa: read(row, "pressure_msl"),
    windSpeedKmh: read(row, "wind_speed_10m"),
    windGustsKmh: read(row, "wind_gusts_10m"),
    windDirectionDeg: read(row, "wind_direction_10m"),
    cloudCover: read(row, "cloud_cover"),
    precipitationMm: read(row, "precipitation"),
    visibilityM: read(row, "visibility"),
    uvIndex: read(row, "uv_index"),
    weatherCode: read(row, "weather_code"),
    isDay: isDay == null ? null : isDay === 1,
  };
}

function airConditions(time: number, row: Row): AirQualityConditions {
  return {
    time: iso(time),
    europeanAqi: read(row, "european_aqi"),
    aqiPm2_5: read(row, "european_aqi_pm2_5"),
    aqiPm10: read(row, "european_aqi_pm10"),
    aqiNitrogenDioxide: read(row, "european_aqi_nitrogen_dioxide"),
    aqiOzone: read(row, "european_aqi_ozone"),
    aqiSulphurDioxide: read(row, "european_aqi_sulphur_dioxide"),
    pm2_5: read(row, "pm2_5"),
    pm10: read(row, "pm10"),
    carbonMonoxide: read(row, "carbon_monoxide"),
    nitrogenDioxide: read(row, "nitrogen_dioxide"),
    sulphurDioxide: read(row, "sulphur_dioxide"),
    ozone: read(row, "ozone"),
    dust: read(row, "dust"),
    aerosolOpticalDepth: read(row, "aerosol_optical_depth"),
    pollen: Object.fromEntries(Object.entries(POLLEN).map(([type, name]) => [type, read(row, name)])) as Record<PollenType, number | null>,
  };
}

export function parseStationForecast(raw: unknown) {
  const parsed = forecastSchema.parse(raw);
  const hours: StationHour[] = parsed.hourly.time.map((time, index) => {
    const row = rowAt(parsed.hourly, index);
    return {
      ...conditions(time, row),
      precipitationProbability: read(row, "precipitation_probability"),
      cloudCoverLow: read(row, "cloud_cover_low"),
      cloudCoverMid: read(row, "cloud_cover_mid"),
      cloudCoverHigh: read(row, "cloud_cover_high"),
      capeJkg: read(row, "cape"),
      liftedIndex: read(row, "lifted_index"),
      convectiveInhibitionJkg: read(row, "convective_inhibition"),
      freezingLevelM: read(row, "freezing_level_height"),
    };
  });
  const days: StationDay[] = parsed.daily.time.map((time, index) => {
    const row = rowAt(parsed.daily, index);
    const sunshine = read(row, "sunshine_duration");
    return {
      date: iso(time),
      weatherCode: read(row, "weather_code"),
      temperatureMaxC: read(row, "temperature_2m_max"),
      temperatureMinC: read(row, "temperature_2m_min"),
      precipitationMm: read(row, "precipitation_sum"),
      precipitationProbability: read(row, "precipitation_probability_max"),
      precipitationHours: read(row, "precipitation_hours"),
      windSpeedMaxKmh: read(row, "wind_speed_10m_max"),
      windGustsMaxKmh: read(row, "wind_gusts_10m_max"),
      windDirectionDeg: read(row, "wind_direction_10m_dominant"),
      uvIndexMax: read(row, "uv_index_max"),
      sunshineHours: sunshine == null ? null : Math.round((sunshine / 3600) * 10) / 10,
    };
  });
  const current = parsed.current ? conditions(parsed.current.time, parsed.current as Row) : null;
  return { modelElevationM: parsed.elevation ?? null, current, hours, days };
}

export function parseAirQuality(raw: unknown) {
  const parsed = airSchema.parse(raw);
  return {
    current: parsed.current ? airConditions(parsed.current.time, parsed.current as Row) : null,
    hours: parsed.hourly.time.map((time, index) => airConditions(time, rowAt(parsed.hourly, index))),
  };
}

function forecastUrl(observer: Coordinates) {
  const params = new URLSearchParams({
    latitude: observer.latitude.toFixed(4),
    longitude: observer.longitude.toFixed(4),
    current: CURRENT_VARIABLES.join(","),
    hourly: HOURLY_VARIABLES.join(","),
    daily: DAILY_VARIABLES.join(","),
    past_hours: String(PAST_HOURS),
    forecast_hours: String(FORECAST_HOURS),
    forecast_days: String(FORECAST_DAYS),
    timezone: TIME_ZONE,
    timeformat: "unixtime",
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

function airQualityUrl(observer: Coordinates) {
  const params = new URLSearchParams({
    latitude: observer.latitude.toFixed(4),
    longitude: observer.longitude.toFixed(4),
    current: AIR_VARIABLES.join(","),
    hourly: AIR_VARIABLES.join(","),
    forecast_days: String(AIR_QUALITY_DAYS),
    timezone: TIME_ZONE,
    timeformat: "unixtime",
  });
  return `https://air-quality-api.open-meteo.com/v1/air-quality?${params}`;
}

const cache = new TtlCache<WeatherStationResponse>(200);
const inFlight = new InFlight<WeatherStationResponse>();

/**
 * Weather at the observer, cached for 15 minutes per ~100 m. Fails only when the forecast
 * fails; missing air quality is reported in its own status.
 */
export async function fetchWeatherStation(observer: Coordinates): Promise<WeatherStationResponse> {
  const key = `${observer.latitude.toFixed(3)}:${observer.longitude.toFixed(3)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  return inFlight.run(key, async () => {
    const [forecastResult, airResult] = await Promise.allSettled([
      fetchJsonWithRetry<unknown>(forecastUrl(observer), { retries: 1, timeoutMs: 10_000, deadlineMs: 15_000 }),
      fetchJsonWithRetry<unknown>(airQualityUrl(observer), { retries: 1, timeoutMs: 10_000, deadlineMs: 15_000 }),
    ]);
    if (forecastResult.status === "rejected") throw forecastResult.reason instanceof Error ? forecastResult.reason : new Error("Open-Meteo forecast failed");
    const forecast = parseStationForecast(forecastResult.value);
    const airParsed = airResult.status === "fulfilled" ? (() => {
      try { return parseAirQuality(airResult.value); } catch { return null; }
    })() : null;
    const response: WeatherStationResponse = {
      status: "available",
      retrievedAt: new Date().toISOString(),
      observer: { latitude: observer.latitude, longitude: observer.longitude },
      ...forecast,
      airQuality: airParsed
        ? { status: "available", ...airParsed, message: tx("Πρόγνωση CAMS (Copernicus) για αέρια, σωματίδια, σκόνη και γύρη.", "CAMS (Copernicus) forecast of gases, particles, dust and pollen.") }
        : {
          status: "unavailable",
          current: null,
          hours: [],
          message: airResult.status === "rejected"
            ? tx("Η πρόγνωση ποιότητας αέρα δεν απάντησε.", "The air-quality forecast did not respond.")
            : tx("Η πρόγνωση ποιότητας αέρα επέστρεψε μη αναγνώσιμα δεδομένα.", "The air-quality forecast returned unreadable data."),
        },
      message: tx("Πρόγνωση Open-Meteo (συνδυασμός των καλύτερων μοντέλων για τη θέση).", "Open-Meteo forecast (the best models for the location, combined)."),
    };
    // A failed air-quality request is retried at the next refresh instead of in 15 minutes.
    cache.set(key, response, airParsed ? CACHE_TTL_MS : 2 * 60_000);
    return response;
  });
}
