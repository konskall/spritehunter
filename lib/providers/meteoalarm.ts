import type { WeatherAlert, WeatherAlertResponse } from "@/lib/domain";

const FEED_URL = "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-greece";

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

export function parseMeteoAlarmFeed(xml: string, retrievedAt = new Date().toISOString()): WeatherAlertResponse {
  const updatedAt = valueOf(xml, "updated");
  const now = Date.now();
  const alerts = Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)).map((match): WeatherAlert | null => {
    const entry = match[1];
    const id = valueOf(entry, "cap:identifier") ?? valueOf(entry, "id");
    const area = valueOf(entry, "cap:areaDesc");
    const event = valueOf(entry, "cap:event");
    const severity = valueOf(entry, "cap:severity") ?? "Unknown";
    const onset = valueOf(entry, "cap:onset");
    const expires = valueOf(entry, "cap:expires");
    const capLink = entry.match(/<link\b[^>]*type=["']application\/cap\+xml["'][^>]*href=["']([^"']+)["']/i)?.[1];
    if (!id || !area || !event || (expires && new Date(expires).getTime() < now)) return null;
    return { id, area, event, severity, onset, expires, link: decodeXml(capLink ?? "https://meteoalarm.org/?lang=el_GR") };
  }).filter((alert): alert is WeatherAlert => alert !== null)
    .sort((a, b) => Number(/thunder/i.test(b.event)) - Number(/thunder/i.test(a.event)) || (new Date(a.expires ?? 0).getTime() - new Date(b.expires ?? 0).getTime()))
    .slice(0, 16);
  return {
    status: "available",
    retrievedAt,
    updatedAt,
    alerts,
    message: alerts.length
      ? `${alerts.length} ενεργές επίσημες προειδοποιήσεις για την Ελλάδα· οι περιοχές προέρχονται από τη ροή και δεν γεωφιλτράρονται σε επίπεδο συντεταγμένων.`
      : "Δεν υπάρχουν ενεργές προειδοποιήσεις στη ροή της Ελλάδας.",
  };
}

export function unavailableMeteoAlarm(message: string, retrievedAt = new Date().toISOString()): WeatherAlertResponse {
  return { status: "unavailable", retrievedAt, updatedAt: null, alerts: [], message };
}

export async function fetchMeteoAlarm(): Promise<WeatherAlertResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    // The legacy Atom endpoint currently returns 406 for an explicit Atom Accept header.
    const response = await fetch(FEED_URL, { headers: { Accept: "*/*" }, signal: controller.signal });
    if (!response.ok) throw new Error(`MeteoAlarm ${response.status}`);
    return parseMeteoAlarmFeed(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}
