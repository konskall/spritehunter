import { z } from "zod";
import type { AviationObservation, Coordinates } from "@/lib/domain";
import { inverseGeodesic } from "@/lib/geodesy";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";

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

function visibilityMeters(value: number | string | null | undefined) {
  if (value == null) return null;
  const miles = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(miles) ? Math.round(miles * 1609.344) : null;
}

function cloudCoverPercent(clouds: z.infer<typeof cloudSchema>[]) {
  if (!clouds.length) return null;
  const fractions: Record<string, number> = { SKC: 0, CLR: 0, NSC: 0, NCD: 0, FEW: 20, SCT: 50, BKN: 80, OVC: 100, VV: 100 };
  return Math.max(...clouds.map((cloud) => fractions[cloud.cover.toUpperCase()] ?? 0));
}

function cloudSummary(clouds: z.infer<typeof cloudSchema>[]) {
  if (!clouds.length) return "Χωρίς δηλωμένες νεφώσεις";
  return clouds.map((cloud) => `${cloud.cover}${cloud.base == null ? "" : ` ${cloud.base} ft`}${cloud.type ? ` ${cloud.type}` : ""}`).join(" · ");
}

export function unavailableAviation(message: string, retrievedAt = new Date().toISOString()): AviationObservation {
  return {
    status: "unavailable", stationId: null, stationName: null, distanceKm: null,
    observedAt: null, retrievedAt, visibilityM: null, cloudCoverPercent: null,
    cloudSummary: null, windDirectionDeg: null, windSpeedKmh: null, weather: null,
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
    headers: { Accept: "application/json", "User-Agent": "SpriteHunter/0.3 (upper-atmosphere-observatory)" },
  });
  const reports = z.array(metarSchema).parse(raw);
  if (!reports.length) return unavailableAviation("Δεν βρέθηκε πρόσφατος σταθμός METAR σε ακτίνα περίπου 280 km.", retrievedAt);
  const ranked = reports.map((report) => ({
    report,
    distanceKm: inverseGeodesic(observer, { latitude: report.lat, longitude: report.lon }).distanceM / 1000,
  })).sort((a, b) => a.distanceKm - b.distanceKm);
  const nearest = ranked[0];
  let taf: z.infer<typeof tafSchema> | null = null;
  try {
    const tafRaw = await fetchJsonWithRetry<unknown>(`https://aviationweather.gov/api/data/taf?ids=${encodeURIComponent(nearest.report.icaoId)}&format=json&time=valid`, {
      retries: 0,
      timeoutMs: 8_000,
      headers: { Accept: "application/json", "User-Agent": "SpriteHunter/0.3 (upper-atmosphere-observatory)" },
    });
    taf = z.array(tafSchema).parse(tafRaw)[0] ?? null;
  } catch {
    taf = null;
  }
  const clouds = nearest.report.clouds ?? [];
  const observedAt = new Date(nearest.report.obsTime * 1000).toISOString();
  const ageMinutes = Math.max(0, Math.round((Date.now() - nearest.report.obsTime * 1000) / 60_000));
  return {
    status: ageMinutes <= 120 ? "available" : "stale",
    stationId: nearest.report.icaoId,
    stationName: nearest.report.name ?? nearest.report.icaoId,
    distanceKm: Math.round(nearest.distanceKm),
    observedAt,
    retrievedAt,
    visibilityM: visibilityMeters(nearest.report.visib),
    cloudCoverPercent: cloudCoverPercent(clouds),
    cloudSummary: cloudSummary(clouds),
    windDirectionDeg: typeof nearest.report.wdir === "number" ? nearest.report.wdir : null,
    windSpeedKmh: nearest.report.wspd == null ? null : Math.round(nearest.report.wspd * 1.852),
    weather: nearest.report.wxString ?? null,
    flightCategory: nearest.report.fltCat ?? null,
    rawMetar: nearest.report.rawOb ?? null,
    rawTaf: taf?.rawTAF ?? null,
    tafValidFrom: taf?.validTimeFrom ? new Date(taf.validTimeFrom * 1000).toISOString() : null,
    tafValidTo: taf?.validTimeTo ? new Date(taf.validTimeTo * 1000).toISOString() : null,
    message: `Πραγματική παρατήρηση ${nearest.report.icaoId}, ${Math.round(nearest.distanceKm)} km μακριά, ηλικίας ${ageMinutes}′. Τοπικό σημείο αναφοράς — όχι μέτρηση ακριβώς στη θέση σου.`,
  };
}
