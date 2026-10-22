import { z } from "zod";
import type { AviationObservation, Coordinates } from "@/lib/domain";
import { inverseGeodesic } from "@/lib/geodesy";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";
import { tx, type Localized } from "@/lib/i18n";
import { APP_VERSION } from "@/lib/version";

const cloudSchema = z.object({
  cover: z.string(),
  base: z.number().nullable().optional(),
  type: z.string().nullable().optional(),
});

const metarSchema = z.object({
  icaoId: z.string(),
  obsTime: z.number(),
  lat: z.number(),
  lon: z.number(),
  name: z.string().optional(),
  visib: z.union([z.number(), z.string()]).nullable().optional(),
  wdir: z.union([z.number(), z.string()]).nullable().optional(),
  wspd: z.number().nullable().optional(),
  wgst: z.number().nullable().optional(),
  temp: z.number().nullable().optional(),
  dewp: z.number().nullable().optional(),
  // QNH in hPa (the API converts US altimeter settings from inHg).
  altim: z.number().nullable().optional(),
  wxString: z.string().nullable().optional(),
  rawOb: z.string().optional(),
  fltCat: z.string().nullable().optional(),
  clouds: z.array(cloudSchema).optional(),
});

const tafSchema = z.object({
  rawTAF: z.string().optional(),
  validTimeFrom: z.number().optional(),
  validTimeTo: z.number().optional(),
});

// The observed part of a METAR, without trend (TEMPO/BECMG/NOSIG) or remarks.
const metarBody = (rawOb: string) => rawOb.split(/\s(?:TEMPO|BECMG|NOSIG|RMK)\b/)[0];

/**
 * Visibility in metres. `9999` and CAVOK mean 10 km or more, and the API's "6+" statute
 * miles is likewise a lower bound, so `atLeast` marks values that are only a minimum.
 */
export function metarVisibility(value: number | string | null | undefined, rawOb: string) {
  if (/\b(9999|CAVOK)\b/.test(metarBody(rawOb))) return { meters: 10_000, atLeast: true };
  if (value == null) return { meters: null, atLeast: false };
  const miles = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(miles)) return { meters: null, atLeast: false };
  return { meters: Math.round(miles * 1609.344), atLeast: typeof value === "string" && value.trim().endsWith("+") };
}

const CLOUD_FRACTIONS: Record<string, number> = { SKC: 0, CLR: 0, NSC: 0, NCD: 0, CAVOK: 0, FEW: 20, SCT: 50, BKN: 80, OVC: 100, VV: 100 };
const FRESH_REPORT_MINUTES = 90;

/** Densest reported layer. METAR describes low/mid cloud only; it cannot confirm clear high cloud. */
export function metarCloudCoverPercent(clouds: Array<{ cover: string }>, rawOb: string) {
  const known = clouds.map((cloud) => CLOUD_FRACTIONS[cloud.cover.toUpperCase()]).filter((value): value is number => value !== undefined);
  if (known.length) return Math.max(...known);
  return /\b(CAVOK|NSC|NCD|SKC|CLR)\b/.test(rawOb) ? 0 : null;
}

interface StationReport {
  icaoId: string;
  obsTime: number;
  lat: number;
  lon: number;
}

/** Newest report per station; nearest fresh station first, otherwise the nearest stale one. */
export function selectAviationReport<T extends StationReport>(reports: T[], observer: Coordinates, nowMs = Date.now()) {
  const newest = new Map<string, T>();
  for (const report of reports) {
    const current = newest.get(report.icaoId);
    if (!current || report.obsTime > current.obsTime) newest.set(report.icaoId, report);
  }
  const ranked = Array.from(newest.values()).map((report) => ({
    report,
    distanceKm: inverseGeodesic(observer, { latitude: report.lat, longitude: report.lon }).distanceM / 1000,
    ageMinutes: Math.max(0, (nowMs - report.obsTime * 1000) / 60_000),
  })).sort((a, b) => a.distanceKm - b.distanceKm);
  return ranked.find((item) => item.ageMinutes <= FRESH_REPORT_MINUTES) ?? ranked[0] ?? null;
}

const CONVECTIVE_CLOUDS: Record<string, Localized> = {
  TCU: tx("πυργωμένοι σωρείτες", "towering cumulus"),
  CB: tx("σωρειτομελανίες", "cumulonimbus"),
};

/** Layers as "FEW 1800 ft (towering cumulus)"; the API drops TCU/CB, so they are read from the raw report. */
export function metarCloudSummary(clouds: Array<{ cover: string; base?: number | null; type?: string | null }>, rawOb: string) {
  if (!clouds.length) return tx("Χωρίς δηλωμένες νεφώσεις", "No cloud reported");
  const types = new Map<string, string>();
  for (const match of metarBody(rawOb).matchAll(/\b(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)\b/g)) types.set(`${match[1]}${Number(match[2]) * 100}`, match[3]);
  const layers = (language: keyof Localized) => clouds.map((cloud) => {
    const type = cloud.type ?? types.get(`${cloud.cover}${cloud.base}`);
    const convective = type ? CONVECTIVE_CLOUDS[type.toUpperCase()] : undefined;
    const label = convective ? ` (${convective[language]})` : type ? ` ${type}` : "";
    return `${cloud.cover}${cloud.base == null ? "" : ` ${cloud.base} ft`}${label}`;
  }).join(" · ");
  return tx(layers("el"), layers("en"));
}

export function unavailableAviation(message: Localized, retrievedAt = new Date().toISOString()): AviationObservation {
  return {
    status: "unavailable", stationId: null, stationName: null, distanceKm: null,
    observedAt: null, retrievedAt, visibilityM: null, visibilityAtLeast: false, cloudCoverPercent: null,
    cloudSummary: null, windDirectionDeg: null, windSpeedKmh: null, windGustKmh: null,
    temperatureC: null, dewPointC: null, pressureHpa: null, weather: null,
    flightCategory: null, rawMetar: null, rawTaf: null, tafValidFrom: null,
    tafValidTo: null, message,
  };
}

export async function fetchNearestAviationWeather(observer: Coordinates): Promise<AviationObservation> {
  const retrievedAt = new Date().toISOString();
  const latitudeRadius = 2.5;
  const longitudeRadius = Math.min(4, latitudeRadius / Math.max(0.35, Math.cos(observer.latitude * Math.PI / 180)));
  const bbox = [
    Math.max(-90, observer.latitude - latitudeRadius),
    Math.max(-180, observer.longitude - longitudeRadius),
    Math.min(90, observer.latitude + latitudeRadius),
    Math.min(180, observer.longitude + longitudeRadius),
  ].map((value) => value.toFixed(3)).join(",");
  const params = new URLSearchParams({ bbox, format: "json", hours: "3" });
  const raw = await fetchJsonWithRetry<unknown>(`https://aviationweather.gov/api/data/metar?${params}`, {
    retries: 1,
    timeoutMs: 12_000,
    headers: { Accept: "application/json", "User-Agent": `SpriteHunter/${APP_VERSION} (upper-atmosphere-observatory)` },
  });
  const reports = z.array(metarSchema).parse(raw);
  const nearest = selectAviationReport(reports, observer);
  if (!nearest) return unavailableAviation(tx("Δεν βρέθηκε πρόσφατος σταθμός METAR σε ακτίνα περίπου 280 km.", "No recent METAR station within about 280 km."), retrievedAt);
  let taf: z.infer<typeof tafSchema> | null = null;
  try {
    const tafRaw = await fetchJsonWithRetry<unknown>(`https://aviationweather.gov/api/data/taf?ids=${encodeURIComponent(nearest.report.icaoId)}&format=json&time=valid`, {
      retries: 0,
      timeoutMs: 8_000,
      headers: { Accept: "application/json", "User-Agent": `SpriteHunter/${APP_VERSION} (upper-atmosphere-observatory)` },
    });
    taf = z.array(tafSchema).parse(tafRaw)[0] ?? null;
  } catch {
    taf = null;
  }
  const clouds = nearest.report.clouds ?? [];
  const rawOb = nearest.report.rawOb ?? "";
  const visibility = metarVisibility(nearest.report.visib, rawOb);
  const observedAt = new Date(nearest.report.obsTime * 1000).toISOString();
  const ageMinutes = Math.round(nearest.ageMinutes);
  return {
    status: ageMinutes <= FRESH_REPORT_MINUTES ? "available" : "stale",
    stationId: nearest.report.icaoId,
    stationName: nearest.report.name ?? nearest.report.icaoId,
    distanceKm: Math.round(nearest.distanceKm),
    observedAt,
    retrievedAt,
    visibilityM: visibility.meters,
    visibilityAtLeast: visibility.atLeast,
    cloudCoverPercent: metarCloudCoverPercent(clouds, rawOb),
    cloudSummary: metarCloudSummary(clouds, rawOb),
    windDirectionDeg: typeof nearest.report.wdir === "number" ? nearest.report.wdir : null,
    windSpeedKmh: nearest.report.wspd == null ? null : Math.round(nearest.report.wspd * 1.852),
    windGustKmh: nearest.report.wgst == null ? null : Math.round(nearest.report.wgst * 1.852),
    temperatureC: nearest.report.temp ?? null,
    dewPointC: nearest.report.dewp ?? null,
    pressureHpa: nearest.report.altim ?? null,
    weather: nearest.report.wxString ?? null,
    flightCategory: nearest.report.fltCat ?? null,
    rawMetar: nearest.report.rawOb ?? null,
    rawTaf: taf?.rawTAF ?? null,
    tafValidFrom: taf?.validTimeFrom ? new Date(taf.validTimeFrom * 1000).toISOString() : null,
    tafValidTo: taf?.validTimeTo ? new Date(taf.validTimeTo * 1000).toISOString() : null,
    message: tx(
      `Πραγματική παρατήρηση ${nearest.report.icaoId}, ${Math.round(nearest.distanceKm)} km μακριά, ηλικίας ${ageMinutes}′. Τοπικό σημείο αναφοράς — όχι μέτρηση ακριβώς στη θέση σου.`,
      `Real observation from ${nearest.report.icaoId}, ${Math.round(nearest.distanceKm)} km away, ${ageMinutes}′ old. A local reference, not a measurement at your exact location.`,
    ),
  };
}
