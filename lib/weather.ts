import type { AirQualityConditions, AlertLevel, Coordinates, LightningCluster, StationHour, WeatherAlert, WeatherHour } from "@/lib/domain";
import { inverseGeodesic } from "@/lib/geodesy";
import { tx, type Language, type Localized } from "@/lib/i18n";

/** WMO weather codes 95, 96 and 99: a thunderstorm, with hail for the last two. */
export const isThunderCode = (code: number | null) => code === 95 || code === 96 || code === 99;

/**
 * A model hour worth a target: a thunderstorm code, or rain with some instability. Instability
 * alone was a poor sign (2–12 % of such cells had lightning nearby); with this rule the scan found
 * 88 % of the large storms, against 76 % before, and more of its cells were right (48 % vs 38 %).
 */
export function isStormHour(hour: Pick<WeatherHour, "capeJkg" | "precipitationMm" | "weatherCode">) {
  return isThunderCode(hour.weatherCode) || ((hour.capeJkg ?? 0) >= 100 && (hour.precipitationMm ?? 0) >= 0.2);
}

/** Runs of model storm hours at the observer from `fromMs` on, merged when an hour apart. */
export function stormPeriods(hours: Array<Pick<StationHour, "time" | "capeJkg" | "precipitationMm" | "weatherCode">>, fromMs: number) {
  const periods: Array<{ start: string; end: string; thunder: boolean }> = [];
  for (const hour of hours) {
    if (Date.parse(hour.time) < fromMs - 30 * 60_000 || !isStormHour(hour)) continue;
    const thunder = isThunderCode(hour.weatherCode);
    const last = periods.at(-1);
    if (last && Date.parse(hour.time) - Date.parse(last.end) <= 3_600_000) {
      last.end = hour.time;
      last.thunder ||= thunder;
    } else {
      periods.push({ start: hour.time, end: hour.time, thunder });
    }
  }
  return periods;
}

// Observed lightning this close (to the storm's edge) is a danger at the site; up to the second, it is near.
const LIGHTNING_CLOSE_KM = 20;
const LIGHTNING_NEAR_KM = 60;
// An atmosphere this unstable can grow storms that the model's hours do not show.
const UNSTABLE_CAPE_JKG = 500;
const UNSTABLE_LIFTED_INDEX = -2;

export type LocalStormStatus = "lightning_close" | "lightning_near" | "thunder" | "rain_unstable" | "unstable" | "quiet";

/** Storm risk at the site: observed lightning first, then the model's storm hours, then instability. */
export function localStormStatus({ periods, lightningKm, capeMax, liftedMin }: {
  periods: Array<{ thunder: boolean }>; lightningKm: number | null; capeMax: number | null; liftedMin: number | null;
}): LocalStormStatus {
  if (lightningKm != null && lightningKm <= LIGHTNING_CLOSE_KM) return "lightning_close";
  if (lightningKm != null && lightningKm <= LIGHTNING_NEAR_KM) return "lightning_near";
  if (periods.some((period) => period.thunder)) return "thunder";
  if (periods.length) return "rain_unstable";
  if ((capeMax ?? 0) >= UNSTABLE_CAPE_JKG && (liftedMin ?? 0) <= UNSTABLE_LIFTED_INDEX) return "unstable";
  return "quiet";
}

/** Whether two sites are the same place; a scan answers for the exact coordinates it was asked for. */
export function isSameSite(a: Coordinates, b: Coordinates) {
  return Math.abs(a.latitude - b.latitude) < 1e-6 && Math.abs(a.longitude - b.longitude) < 1e-6;
}

type RainHour = Pick<StationHour, "time" | "precipitationMm" | "precipitationProbability">;

/**
 * Open-Meteo stamps each hour's precipitation and its probability at the end of the hour: the
 * 10:00 value is the 09:00–10:00 sum. This gives every hour the rain of the hour that follows it.
 */
export function rainAhead(hours: RainHour[]) {
  return hours.map((hour, index) => {
    const next = hours[index + 1];
    const follows = next != null && Date.parse(next.time) - Date.parse(hour.time) === 3_600_000;
    return { mm: follows ? next.precipitationMm : null, chance: follows ? next.precipitationProbability : null };
  });
}

/** Rain in the coming hour: the clock hour that holds most of the next 60 minutes. */
export function rainNextHour(hours: RainHour[], nowMs: number) {
  const start = Math.floor((nowMs + 30 * 60_000) / 3_600_000) * 3_600_000;
  const row = hours.find((hour) => Date.parse(hour.time) === start + 3_600_000);
  return row ? { mm: row.precipitationMm, chance: row.precipitationProbability } : null;
}

const ALERT_LEVEL_TEXT: Record<AlertLevel, Localized> = {
  green: tx("Πράσινη", "Green"),
  yellow: tx("Κίτρινη", "Yellow"),
  orange: tx("Πορτοκαλί", "Orange"),
  red: tx("Κόκκινη", "Red"),
};
// MeteoAlarm's awareness types, keyed by their name in lower case without spaces or hyphens.
const ALERT_HAZARD_TEXT: Record<string, Localized> = {
  thunderstorm: tx("Καταιγίδα", "Thunderstorm"),
  thunderstorms: tx("Καταιγίδες", "Thunderstorms"),
  rain: tx("Βροχή", "Rain"),
  wind: tx("Άνεμος", "Wind"),
  snowice: tx("Χιόνι και πάγος", "Snow and ice"),
  snow: tx("Χιόνι", "Snow"),
  fog: tx("Ομίχλη", "Fog"),
  hightemperature: tx("Υψηλές θερμοκρασίες", "High temperature"),
  hightemperatures: tx("Υψηλές θερμοκρασίες", "High temperature"),
  lowtemperature: tx("Χαμηλές θερμοκρασίες", "Low temperature"),
  lowtemperatures: tx("Χαμηλές θερμοκρασίες", "Low temperature"),
  coastalevent: tx("Παράκτια φαινόμενα", "Coastal event"),
  forestfire: tx("Κίνδυνος πυρκαγιάς", "Forest fire"),
  avalanche: tx("Χιονοστιβάδες", "Avalanches"),
  avalanches: tx("Χιονοστιβάδες", "Avalanches"),
  flood: tx("Πλημμύρα", "Flood"),
  flooding: tx("Πλημμύρα", "Flood"),
  rainflood: tx("Βροχή και πλημμύρα", "Rain and flood"),
};

/** A MeteoAlarm warning's colour and hazard in both languages; unknown hazards stay as reported. */
export function alertText(alert: Pick<WeatherAlert, "hazard" | "level">) {
  const key = alert.hazard?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  return {
    level: alert.level ? ALERT_LEVEL_TEXT[alert.level] : null,
    hazard: ALERT_HAZARD_TEXT[key] ?? (alert.hazard ? tx(alert.hazard, alert.hazard) : tx("Προειδοποίηση", "Warning")),
  };
}

/**
 * The MTG-LI storm whose lit area comes closest to the observer. `distanceKm` runs to the edge
 * of the circle around its centre that holds all its lit pixels (0 when the site is inside it);
 * the pixels themselves may lie farther, so `centerKm` is given too.
 */
export function nearestLightning(observer: Coordinates, clusters: LightningCluster[]) {
  let nearest: { distanceKm: number; centerKm: number; bearingDeg: number; cluster: LightningCluster } | null = null;
  for (const cluster of clusters) {
    const { distanceM, initialBearingDeg } = inverseGeodesic(observer, cluster.centroid);
    const centerKm = distanceM / 1000;
    const distanceKm = Math.max(0, centerKm - cluster.radiusKm);
    if (!nearest || distanceKm < nearest.distanceKm) nearest = { distanceKm, centerKm, bearingDeg: initialBearingDeg, cluster };
  }
  return nearest;
}

export type WeatherIcon ="clear" | "partly" | "overcast" | "fog" | "drizzle" | "rain" | "showers" | "snow" | "thunder" | "hail";

// The WMO codes Open-Meteo reports.
const WEATHER_CODES: Record<number, [WeatherIcon, Localized]> = {
  0: ["clear", tx("Αίθριος", "Clear sky")],
  1: ["partly", tx("Κυρίως αίθριος", "Mainly clear")],
  2: ["partly", tx("Μερικώς νεφελώδης", "Partly cloudy")],
  3: ["overcast", tx("Συννεφιά", "Overcast")],
  45: ["fog", tx("Ομίχλη", "Fog")],
  48: ["fog", tx("Ομίχλη με πάχνη", "Freezing fog")],
  51: ["drizzle", tx("Ασθενές ψιλόβροχο", "Light drizzle")],
  53: ["drizzle", tx("Ψιλόβροχο", "Drizzle")],
  55: ["drizzle", tx("Πυκνό ψιλόβροχο", "Dense drizzle")],
  56: ["drizzle", tx("Παγωμένο ψιλόβροχο", "Freezing drizzle")],
  57: ["drizzle", tx("Πυκνό παγωμένο ψιλόβροχο", "Dense freezing drizzle")],
  61: ["rain", tx("Ασθενής βροχή", "Light rain")],
  63: ["rain", tx("Βροχή", "Rain")],
  65: ["rain", tx("Ισχυρή βροχή", "Heavy rain")],
  66: ["rain", tx("Ασθενής παγωμένη βροχή", "Light freezing rain")],
  67: ["rain", tx("Παγωμένη βροχή", "Freezing rain")],
  71: ["snow", tx("Ασθενής χιονόπτωση", "Light snow")],
  73: ["snow", tx("Χιονόπτωση", "Snow")],
  75: ["snow", tx("Ισχυρή χιονόπτωση", "Heavy snow")],
  77: ["snow", tx("Χιονόκοκκοι", "Snow grains")],
  80: ["showers", tx("Ασθενείς μπόρες", "Light showers")],
  81: ["showers", tx("Μπόρες", "Showers")],
  82: ["showers", tx("Ισχυρές μπόρες", "Violent showers")],
  85: ["snow", tx("Ασθενείς χιονοπτώσεις", "Light snow showers")],
  86: ["snow", tx("Χιονοπτώσεις", "Snow showers")],
  95: ["thunder", tx("Καταιγίδα", "Thunderstorm")],
  96: ["hail", tx("Καταιγίδα με χαλάζι", "Thunderstorm with hail")],
  99: ["hail", tx("Ισχυρή καταιγίδα με χαλάζι", "Thunderstorm with heavy hail")],
};

export function weatherCodeInfo(code: number | null): { icon: WeatherIcon; text: Localized } | null {
  const entry = code == null ? undefined : WEATHER_CODES[code];
  return entry ? { icon: entry[0], text: entry[1] } : null;
}

const COMPASS_EL = ["Β", "ΒΒΑ", "ΒΑ", "ΑΒΑ", "Α", "ΑΝΑ", "ΝΑ", "ΝΝΑ", "Ν", "ΝΝΔ", "ΝΔ", "ΔΝΔ", "Δ", "ΔΒΔ", "ΒΔ", "ΒΒΔ"];
const COMPASS_EN = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** The 16-point compass name of a bearing. */
export function directionLabel(degrees: number, language: Language) {
  const index = Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16;
  return (language === "el" ? COMPASS_EL : COMPASS_EN)[index];
}

// Upper limits (exclusive) of Beaufort forces 0–11 in km/h; 118 km/h and above is force 12.
const BEAUFORT_LIMITS_KMH = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];

export function beaufort(speedKmh: number) {
  const force = BEAUFORT_LIMITS_KMH.findIndex((limit) => speedKmh < limit);
  return force === -1 ? 12 : force;
}

export type Tendency = "steady" | "rising" | "falling";
export type TendencyRate = "slowly" | "moderately" | "quickly" | "very_rapidly";

/**
 * Sea-level pressure change over the last 3 hours, named with the Met Office terms
 * (steady below 0.1 hPa, slowly to 1.5, quickly from 3.6 and very rapidly above 6).
 */
export function pressureTendency(hours: Array<Pick<StationHour, "time" | "pressureHpa">>, nowMs: number) {
  const now = valueNear(hours, nowMs, (hour) => hour.pressureHpa);
  const before = valueNear(hours, nowMs - 3 * 3_600_000, (hour) => hour.pressureHpa);
  if (now == null || before == null) return null;
  const changeHpa = Math.round((now - before) * 10) / 10;
  const size = Math.abs(changeHpa);
  const tendency: Tendency = size < 0.1 ? "steady" : changeHpa > 0 ? "rising" : "falling";
  const rate: TendencyRate = size <= 1.5 ? "slowly" : size <= 3.5 ? "moderately" : size <= 6 ? "quickly" : "very_rapidly";
  return { changeHpa, tendency, rate };
}

/** The value of the hour nearest `targetMs`, if one lies within 45 minutes of it. */
export function valueNear<T extends { time: string }>(items: T[], targetMs: number, read: (item: T) => number | null, toleranceMs = 45 * 60_000) {
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const distance = Math.abs(Date.parse(item.time) - targetMs);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return best && bestDistance <= toleranceMs ? read(best) : null;
}

/** A 0-based level and its name; `tone` picks the colour (good → bad). */
export interface Level {
  level: number;
  text: Localized;
  tone: "good" | "fair" | "warn" | "bad";
}

const AQI_LEVELS: Array<[number, Localized, Level["tone"]]> = [
  [20, tx("Καλή", "Good"), "good"],
  [40, tx("Ικανοποιητική", "Fair"), "good"],
  [60, tx("Μέτρια", "Moderate"), "fair"],
  [80, tx("Κακή", "Poor"), "warn"],
  [100, tx("Πολύ κακή", "Very poor"), "bad"],
  [Number.POSITIVE_INFINITY, tx("Εξαιρετικά κακή", "Extremely poor"), "bad"],
];

/** The European Air Quality Index band (Open-Meteo scale: 0–20 good … above 100 extremely poor). */
export function aqiLevel(aqi: number | null): Level | null {
  if (aqi == null) return null;
  const level = AQI_LEVELS.findIndex(([limit]) => aqi < limit);
  const [, text, tone] = AQI_LEVELS[level];
  return { level, text, tone };
}

const UV_LEVELS: Array<[number, Localized, Level["tone"]]> = [
  [3, tx("Χαμηλός", "Low"), "good"],
  [6, tx("Μέτριος", "Moderate"), "fair"],
  [8, tx("Υψηλός", "High"), "warn"],
  [11, tx("Πολύ υψηλός", "Very high"), "bad"],
  [Number.POSITIVE_INFINITY, tx("Ακραίος", "Extreme"), "bad"],
];

/** WHO UV index bands; the index is rounded first, as it is reported. */
export function uvLevel(uv: number | null): Level | null {
  if (uv == null) return null;
  const rounded = Math.round(uv);
  const level = UV_LEVELS.findIndex(([limit]) => rounded < limit);
  const [, text, tone] = UV_LEVELS[level];
  return { level, text, tone };
}

/** Convective energy: what a rising parcel could gain, J/kg. */
export function capeLevel(cape: number | null): Level | null {
  if (cape == null) return null;
  if (cape < 100) return { level: 0, text: tx("Ασήμαντη", "Negligible"), tone: "good" };
  if (cape < 500) return { level: 1, text: tx("Ασθενής", "Weak"), tone: "good" };
  if (cape < 1000) return { level: 2, text: tx("Μέτρια", "Moderate"), tone: "fair" };
  if (cape < 2500) return { level: 3, text: tx("Ισχυρή", "Strong"), tone: "warn" };
  return { level: 4, text: tx("Ακραία", "Extreme"), tone: "bad" };
}

/**
 * Convective inhibition: the energy a rising parcel must first overcome, J/kg (Open-Meteo gives
 * it as a positive number). Little of it lets storms start; a lot holds them back.
 */
export function cinLevel(cin: number | null): Level | null {
  if (cin == null) return null;
  if (cin < 25) return { level: 0, text: tx("Χωρίς φρένο: οι καταιγίδες ξεκινούν εύκολα", "No cap: storms start easily"), tone: "warn" };
  if (cin < 100) return { level: 1, text: tx("Μέτριο φρένο στις καταιγίδες", "Moderate cap on storms"), tone: "fair" };
  if (cin < 250) return { level: 2, text: tx("Ισχυρό φρένο στις καταιγίδες", "Strong cap on storms"), tone: "good" };
  return { level: 3, text: tx("Πολύ ισχυρό φρένο: οι καταιγίδες δύσκολα ξεκινούν", "Very strong cap: storms struggle to start"), tone: "good" };
}

/** Lifted index: below 0 the air at 500 hPa is colder than a lifted parcel, so it can rise. */
export function liftedIndexLevel(li: number | null): Level | null {
  if (li == null) return null;
  if (li > 0) return { level: 0, text: tx("Σταθερή", "Stable"), tone: "good" };
  if (li > -2) return { level: 1, text: tx("Οριακά ασταθής", "Marginally unstable"), tone: "fair" };
  if (li > -4) return { level: 2, text: tx("Ασταθής", "Unstable"), tone: "warn" };
  if (li > -6) return { level: 3, text: tx("Πολύ ασταθής", "Very unstable"), tone: "bad" };
  return { level: 4, text: tx("Ακραία αστάθεια", "Extremely unstable"), tone: "bad" };
}

/** Conditions that matter for a night of photography, over the model hours in a window. */
export interface NightOutlook {
  hours: number;
  cloudMean: number | null;
  cloudHighMean: number | null;
  precipitationProbabilityMax: number | null;
  /** Smallest gap between air temperature and dew point: dew forms on the lens near 0. */
  dewSpreadMin: number | null;
  humidityMax: number | null;
  gustMax: number | null;
  temperatureMin: number | null;
  aerosolOpticalDepthMean: number | null;
  dustMax: number | null;
  sky: Level["tone"] | null;
  dew: Level["tone"] | null;
  wind: Level["tone"] | null;
  cold: Level["tone"] | null;
  transparency: Level["tone"] | null;
}

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const present = (values: Array<number | null>) => values.filter((value): value is number => value != null);
const maxOf = (values: number[]) => (values.length ? Math.max(...values) : null);
const minOf = (values: number[]) => (values.length ? Math.min(...values) : null);

// Thresholds of the night outlook. Lenses radiate to a clear sky and run 1–3 °C below the air,
// so dew is likely once the air is within ~2 °C of its dew point. Gusts from ~25 km/h shake a
// tripod during long exposures. Cold drains camera batteries, quickly below 0 °C. An aerosol
// optical depth below ~0.15 is a clear Mediterranean sky; above ~0.3 haze or dust dims faint light.
const DEW_POOR_C = 2;
const DEW_FAIR_C = 4;
const GUST_FAIR_KMH = 25;
const GUST_POOR_KMH = 40;
const COLD_FAIR_C = 5;
const COLD_POOR_C = 0;
const AOD_GOOD = 0.15;
const AOD_FAIR = 0.3;
const CLOUD_GOOD = 25;
const CLOUD_FAIR = 60;

/** Summarises the model hours (and CAMS hours) between `startMs` and `endMs`. */
export function nightOutlook(hours: StationHour[], air: AirQualityConditions[], startMs: number, endMs: number): NightOutlook {
  const inside = <T extends { time: string }>(list: T[]) => list.filter((item) => {
    const time = Date.parse(item.time);
    return time >= startMs && time <= endMs;
  });
  const night = inside(hours);
  const nightAir = inside(air);
  const cloudMean = mean(present(night.map((hour) => hour.cloudCover)));
  const spreads = present(night.map((hour) => (hour.temperatureC != null && hour.dewPointC != null ? hour.temperatureC - hour.dewPointC : null)));
  const dewSpreadMin = minOf(spreads);
  const gustMax = maxOf(present(night.map((hour) => hour.windGustsKmh)));
  const temperatureMin = minOf(present(night.map((hour) => hour.temperatureC)));
  const aod = mean(present(nightAir.map((hour) => hour.aerosolOpticalDepth)));
  const round = (value: number | null, digits = 0) => (value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits);
  return {
    hours: night.length,
    cloudMean: round(cloudMean),
    cloudHighMean: round(mean(present(night.map((hour) => hour.cloudCoverHigh)))),
    precipitationProbabilityMax: maxOf(present(night.map((hour) => hour.precipitationProbability))),
    dewSpreadMin: round(dewSpreadMin, 1),
    humidityMax: maxOf(present(night.map((hour) => hour.relativeHumidity))),
    gustMax: round(gustMax),
    temperatureMin: round(temperatureMin, 1),
    aerosolOpticalDepthMean: round(aod, 2),
    dustMax: round(maxOf(present(nightAir.map((hour) => hour.dust)))),
    sky: cloudMean == null ? null : cloudMean <= CLOUD_GOOD ? "good" : cloudMean <= CLOUD_FAIR ? "fair" : "bad",
    dew: dewSpreadMin == null ? null : dewSpreadMin < DEW_POOR_C ? "bad" : dewSpreadMin < DEW_FAIR_C ? "fair" : "good",
    wind: gustMax == null ? null : gustMax >= GUST_POOR_KMH ? "bad" : gustMax >= GUST_FAIR_KMH ? "fair" : "good",
    cold: temperatureMin == null ? null : temperatureMin <= COLD_POOR_C ? "bad" : temperatureMin <= COLD_FAIR_C ? "fair" : "good",
    transparency: aod == null ? null : aod <= AOD_GOOD ? "good" : aod <= AOD_FAIR ? "fair" : "bad",
  };
}
