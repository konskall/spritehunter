import { z } from "zod";
import type { Coordinates, WeatherHour } from "@/lib/domain";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";

// Second and third opinions on the observer's cloud cover. Each model misses cloud in
// its own way, so the score uses the median of the available forecasts and flags hours
// where they disagree.

export interface SourceHour {
  timeMs: number;
  cloudPercent: number;
}

const weatherApiSchema = z.object({
  forecast: z.object({
    forecastday: z.array(z.object({ hour: z.array(z.object({ time_epoch: z.number(), cloud: z.number() }).passthrough()) }).passthrough()),
  }).passthrough(),
}).passthrough();

const openWeatherSchema = z.object({
  list: z.array(z.object({ dt: z.number(), clouds: z.object({ all: z.number() }).passthrough() }).passthrough()),
}).passthrough();

export function parseWeatherApiHours(raw: unknown): SourceHour[] {
  return weatherApiSchema.parse(raw).forecast.forecastday
    .flatMap((day) => day.hour)
    .map((hour) => ({ timeMs: hour.time_epoch * 1000, cloudPercent: hour.cloud }));
}

export function parseOpenWeatherHours(raw: unknown): SourceHour[] {
  return openWeatherSchema.parse(raw).list.map((step) => ({ timeMs: step.dt * 1000, cloudPercent: step.clouds.all }));
}

// The browser fallback imports this module too; it has no process and never gets the keys.
const env = (name: string) => (typeof process === "undefined" ? undefined : process.env[name]);

export const weatherApiConfigured = () => Boolean(env("WEATHERAPI_KEY"));
export const openWeatherConfigured = () => Boolean(env("OPENWEATHER_API_KEY"));

/** WeatherAPI.com hourly forecast for today and tomorrow (free plan allows 3 days). */
export async function fetchWeatherApiHours(observer: Coordinates): Promise<SourceHour[]> {
  const params = new URLSearchParams({
    key: env("WEATHERAPI_KEY") ?? "",
    q: `${observer.latitude.toFixed(4)},${observer.longitude.toFixed(4)}`,
    days: "3",
    aqi: "no",
    alerts: "no",
  });
  const raw = await fetchJsonWithRetry<unknown>(`https://api.weatherapi.com/v1/forecast.json?${params}`, { retries: 1, timeoutMs: 8_000, deadlineMs: 12_000 });
  return parseWeatherApiHours(raw);
}

/** OpenWeatherMap 5-day forecast in 3-hour steps (free plan). */
export async function fetchOpenWeatherHours(observer: Coordinates): Promise<SourceHour[]> {
  const params = new URLSearchParams({
    lat: observer.latitude.toFixed(4),
    lon: observer.longitude.toFixed(4),
    appid: env("OPENWEATHER_API_KEY") ?? "",
    units: "metric",
  });
  const raw = await fetchJsonWithRetry<unknown>(`https://api.openweathermap.org/data/2.5/forecast?${params}`, { retries: 1, timeoutMs: 8_000, deadlineMs: 12_000 });
  return parseOpenWeatherHours(raw);
}

function nearestWithin(hours: SourceHour[] | null, timeMs: number, toleranceMs: number) {
  if (!hours?.length) return null;
  let best: SourceHour | null = null;
  for (const hour of hours) {
    const distance = Math.abs(hour.timeMs - timeMs);
    if (distance <= toleranceMs && (!best || distance < Math.abs(best.timeMs - timeMs))) best = hour;
  }
  return best ? best.cloudPercent : null;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// WeatherAPI is hourly; OpenWeatherMap steps are 3 h apart, so it covers ±90 min.
const WEATHER_API_TOLERANCE_MS = 30 * 60_000;
const OPEN_WEATHER_TOLERANCE_MS = 90 * 60_000;

/** Adds every source's total cloud to each Open-Meteo hour and the median as consensus. */
export function mergeCloudSources(hours: WeatherHour[], weatherApi: SourceHour[] | null, openWeather: SourceHour[] | null): WeatherHour[] {
  return hours.map((hour) => {
    const timeMs = Date.parse(hour.time);
    const cloudSources = {
      openMeteo: hour.cloudCover,
      weatherApi: nearestWithin(weatherApi, timeMs, WEATHER_API_TOLERANCE_MS),
      openWeather: nearestWithin(openWeather, timeMs, OPEN_WEATHER_TOLERANCE_MS),
    };
    const values = Object.values(cloudSources).filter((value): value is number => value != null);
    return { ...hour, cloudSources, cloudConsensus: values.length ? median(values) : null };
  });
}

/** Number of sources and their spread (max − min) for one observer hour. */
export function cloudAgreement(hour: WeatherHour | null | undefined) {
  const values = hour?.cloudSources ? Object.values(hour.cloudSources).filter((value): value is number => value != null) : [];
  return { sources: values.length, spread: values.length >= 2 ? Math.max(...values) - Math.min(...values) : null };
}
