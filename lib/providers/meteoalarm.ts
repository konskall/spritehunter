import type { Coordinates, WeatherAlert, WeatherAlertResponse } from "@/lib/domain";
import { inverseGeodesic } from "@/lib/geodesy";

const FEED_URL = "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-greece";
const MAX_LISTED_ALERTS = 40;
const NEARBY_KM = 150;

// Approximate centroids of the 16 MeteoAlarm warning regions for Greece. Used
// only to order alerts by relevance; areas are not geofenced to the observer.
const AREA_CENTROIDS: Record<string, Coordinates> = {
  "attiki": { latitude: 38.05, longitude: 23.75 },
  "central makedonia": { latitude: 40.65, longitude: 22.95 },
  "dodekanisa islands": { latitude: 36.4, longitude: 27.6 },
  "east makedonia": { latitude: 41.1, longitude: 24.3 },
  "east peloponnisos": { latitude: 37.45, longitude: 22.55 },
  "east sterea & evvoia": { latitude: 38.6, longitude: 23.3 },
  "epirus": { latitude: 39.6, longitude: 20.8 },
  "ionion islands": { latitude: 38.6, longitude: 20.4 },
  "kriti": { latitude: 35.25, longitude: 24.9 },
  "kyklades": { latitude: 37.0, longitude: 25.2 },
  "north east aegean islands": { latitude: 38.9, longitude: 26.2 },
  "thessalia": { latitude: 39.4, longitude: 22.3 },
  "thraki": { latitude: 41.1, longitude: 25.6 },
  "west makedonia": { latitude: 40.4, longitude: 21.5 },
  "west peloponnisos": { latitude: 37.6, longitude: 21.6 },
  "west sterea": { latitude: 38.6, longitude: 21.6 },
};

const SEVERITY_RANK: Record<string, number> = { extreme: 4, severe: 3, moderate: 2, minor: 1 };

function decodeXml(value: string) {
  return value
    .replaceAll("&amp;amp;", "&")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function valueOf(entry: string, tag: string) {
  const value = entry.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1];
  return value ? decodeXml(value.trim()) : null;
}

function areaDistanceKm(area: string, observer?: Coordinates) {
  const centroid = AREA_CENTROIDS[area.toLowerCase()];
  return observer && centroid ? Math.round(inverseGeodesic(observer, centroid).distanceM / 1000) : null;
}

export function parseMeteoAlarmFeed(xml: string, retrievedAt = new Date().toISOString(), observer?: Coordinates): WeatherAlertResponse {
  const updatedAt = valueOf(xml, "updated");
  const now = Date.now();
  const active = Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)).map((match): WeatherAlert | null => {
    const entry = match[1];
    const id = valueOf(entry, "cap:identifier") ?? valueOf(entry, "id");
    const area = valueOf(entry, "cap:areaDesc");
    const event = valueOf(entry, "cap:event");
    const severity = valueOf(entry, "cap:severity") ?? "Unknown";
    const onset = valueOf(entry, "cap:onset");
    const expires = valueOf(entry, "cap:expires");
    const capLink = entry.match(/<link\b[^>]*type=["']application\/cap\+xml["'][^>]*href=["']([^"']+)["']/i)?.[1];
    if (!id || !area || !event || (expires && new Date(expires).getTime() < now)) return null;
    return { id, area, event, severity, onset, expires, distanceKm: areaDistanceKm(area, observer), link: decodeXml(capLink ?? "https://meteoalarm.org/?lang=el_GR") };
  }).filter((alert): alert is WeatherAlert => alert !== null);

  const isNearby = (alert: WeatherAlert) => alert.distanceKm != null && alert.distanceKm <= NEARBY_KM;
  const alerts = active.sort((a, b) =>
    Number(isNearby(b)) - Number(isNearby(a))
    || (SEVERITY_RANK[b.severity.toLowerCase()] ?? 0) - (SEVERITY_RANK[a.severity.toLowerCase()] ?? 0)
    || Number(/thunder/i.test(b.event)) - Number(/thunder/i.test(a.event))
    || (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY)
    || new Date(a.expires ?? 0).getTime() - new Date(b.expires ?? 0).getTime(),
  ).slice(0, MAX_LISTED_ALERTS);
  const nearbyCount = active.filter(isNearby).length;

  return {
    status: "available",
    retrievedAt,
    updatedAt,
    totalCount: active.length,
    nearbyCount,
    alerts,
    message: active.length
      ? `${active.length} προειδοποιήσεις σε ισχύ ή επικείμενες για την Ελλάδα${observer ? ` · ${nearbyCount} σε περιοχές κοντά στη θέση σου` : ""}. Η εγγύτητα βασίζεται σε προσεγγιστικό κέντρο κάθε περιοχής.`
      : "Δεν υπάρχουν ενεργές προειδοποιήσεις στη ροή της Ελλάδας.",
  };
}

export function unavailableMeteoAlarm(message: string, retrievedAt = new Date().toISOString()): WeatherAlertResponse {
  return { status: "unavailable", retrievedAt, updatedAt: null, totalCount: 0, nearbyCount: 0, alerts: [], message };
}

export async function fetchMeteoAlarm(observer?: Coordinates): Promise<WeatherAlertResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    // The legacy Atom endpoint currently returns 406 for an explicit Atom Accept header.
    const response = await fetch(FEED_URL, { headers: { Accept: "*/*" }, signal: controller.signal });
    if (!response.ok) throw new Error(`MeteoAlarm ${response.status}`);
    return parseMeteoAlarmFeed(await response.text(), new Date().toISOString(), observer);
  } finally {
    clearTimeout(timeout);
  }
}
