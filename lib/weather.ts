import type { AirQualityConditions, Coordinates, LightningCluster, StationHour, WeatherHour } from "@/lib/domain";
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

/** Lifted index: below 0 the air at 500 hPa is colder than a lifted parcel, so it can rise. */
export function liftedIndexLevel(li: number | null): Level | null {
  if (li == null) return null;
  if (li > 0) return { level: 0, text: tx("Σταθερή", "Stable"), tone: "good" };
  if (li > -2) return { level: 1, text: tx("Οριακά ασταθής", "Marginally unstable"), tone: "fair" };
  if (li > -4) return { level: 2, text: tx("Ασταθής", "Unstable"), tone: "warn" };
  if (li > -6) return { level: 3, text: tx("Πολύ ασταθής", "Very unstable"), tone: "bad" };
  return { level: 4, text: tx("Ακραία αστάθεια", "Extremely unstable"), tone: "bad" };
}

// Temperature/dew point ("17/12", "M02/M05", dew point may be missing) and pressure groups.
// Remarks are cut first: US remarks carry other numeric groups.
const TEMPERATURE_GROUP = /(?:^|\s)(M?\d{2})\/(M?\d{2})?(?=\s|$)/;
const QNH_GROUP = /(?:^|\s)Q(\d{4})(?=\s|$)/;
const ALTIMETER_GROUP = /(?:^|\s)A(\d{4})(?=\s|$)/;
const HPA_PER_INHG = 33.8639;

const metarNumber = (group: string) => (group.startsWith("M") ? -Number(group.slice(1)) : Number(group));

/** Air temperature, dew point and sea-level pressure (QNH) from a raw METAR. */
export function metarReadings(raw: string | null) {
  const body = raw?.split(" RMK")[0] ?? "";
  const temperature = TEMPERATURE_GROUP.exec(body);
  const qnh = QNH_GROUP.exec(body);
  const altimeter = ALTIMETER_GROUP.exec(body);
  return {
    temperatureC: temperature ? metarNumber(temperature[1]) : null,
    dewPointC: temperature?.[2] ? metarNumber(temperature[2]) : null,
    pressureHpa: qnh ? Number(qnh[1]) : altimeter ? Math.round((Number(altimeter[1]) / 100) * HPA_PER_INHG * 10) / 10 : null,
  };
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
