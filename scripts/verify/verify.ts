// Measures how well the app's targets match what happened, with the app's own code.
//
//   npm run verify -- forecast [--site 37.075,22.43] [--from 2025-10-01] [--to 2026-02-28] [--hour 20] [--range 100,600]
//     Forecast targets (scan grid + storm-hour rule + score) against the storms MTG-LI saw at
//     the same hour each night.
//   npm run verify -- tle [--range 100,600]
//     Verified TLE photos from NASA Spritacular (public gallery) against the storms the app
//     would have listed from the photographer's site at that moment.
//
// Downloads are cached in .verify-cache/. The Spritacular gallery also returns names and e-mail
// addresses; only position, time, azimuth and category are kept.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Coordinates, LightningCluster } from "@/lib/domain";
import { decodePng } from "@/lib/png";
import { inverseGeodesic } from "@/lib/geodesy";
import { skyState } from "@/lib/astronomy";
import { scoreOpportunity } from "@/lib/scoring";
import { clusterLightningFrames, lightningBounds, lightningFrameSize, parseWmsTimeHeader, type GeoBounds } from "@/lib/providers/mtg-lightning";
import { isStormHour, screeningGrid } from "@/lib/providers/open-meteo";

const CACHE = new URL("../../.verify-cache/", import.meta.url);
const WMS = "https://view.eumetsat.int/geoserver/wms";
// MTG-LI frames on EUMETView start here.
const MTG_START = "2025-05-30T15:00:00Z";
// The app's own rule: lightning this close to a cell, measured to the storm's edge, is that storm.
const NEAR_STORM_KM = 50;
const LARGE_STORM_KM2 = 1_000;

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const [minKm, maxKm] = option("range", "100,600").split(",").map(Number);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const km = (a: Coordinates, b: Coordinates) => inverseGeodesic(a, b).distanceM / 1000;
const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}% (${part}/${whole})` : "—");
const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.floor(q * (values.length - 1))] ?? NaN;

/** The app's three newest-frame storms at `timeMs`, or null without exact frames. */
async function storms(bounds: GeoBounds, timeMs: number): Promise<LightningCluster[] | null> {
  const { width, height } = lightningFrameSize(bounds);
  const latest = Math.floor(timeMs / 300_000) * 300_000;
  const frames = [];
  for (const offset of [0, 5, 10]) {
    const wanted = new Date(latest - offset * 60_000).toISOString();
    const params = new URLSearchParams({
      service: "WMS", version: "1.3.0", request: "GetMap", layers: "mtg_fd:li_afa", styles: "mtg_li_afa", format: "image/png8", transparent: "true",
      crs: "CRS:84", bbox: [bounds.west, bounds.south, bounds.east, bounds.north].join(","), width: String(width), height: String(height), time: wanted,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${WMS}?${params}`);
        if (!(response.headers.get("content-type") ?? "").startsWith("image/png")) throw new Error((await response.text()).slice(0, 120));
        const time = parseWmsTimeHeader(response.headers.get("warning")) ?? wanted;
        // As in the app: a missing frame is not replaced by the nearest one.
        if (Date.parse(time) === Date.parse(wanted)) frames.push({ time, image: await decodePng(new Uint8Array(await response.arrayBuffer())) });
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await sleep(2_000);
      }
    }
  }
  return frames.length ? clusterLightningFrames(frames, bounds, latest) : null;
}

type ForecastPayload = { latitude: number; longitude: number; hourly: { time: string[]; cape: Array<number | null>; precipitation: Array<number | null>; weather_code: Array<number | null> } };

async function forecastCommand() {
  const [latitude, longitude] = option("site", "37.075,22.43").split(",").map(Number);
  const site = { latitude, longitude };
  const from = option("from", "2025-10-01");
  const to = option("to", "2026-02-28");
  const hour = Number(option("hour", "20"));
  const dir = new URL(`forecast-${latitude}-${longitude}-${from}-${to}-${hour}-${minKm}-${maxKm}/`, CACHE);
  mkdirSync(dir, { recursive: true });
  const grid = screeningGrid(site, minKm, maxKm);

  // Open-Meteo's archive of past forecasts: for each hour, the forecast issued shortly before.
  const forecastFile = new URL("forecast.json", dir);
  const payloads: ForecastPayload[] = existsSync(forecastFile) ? JSON.parse(readFileSync(forecastFile, "utf8")) : [];
  if (!payloads.length) {
    for (let start = 0; start < grid.length; start += 48) {
      const chunk = grid.slice(start, start + 48);
      const params = new URLSearchParams({
        latitude: chunk.map((point) => point.latitude.toFixed(4)).join(","), longitude: chunk.map((point) => point.longitude.toFixed(4)).join(","),
        hourly: "cape,precipitation,weather_code", start_date: from, end_date: to, timezone: "UTC",
      });
      const response = await fetch(`https://historical-forecast-api.open-meteo.com/v1/forecast?${params}`);
      if (!response.ok) throw new Error(`Open-Meteo ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const json = await response.json();
      payloads.push(...(Array.isArray(json) ? json : [json]));
      console.log(`forecast archive: ${payloads.length}/${grid.length} cells`);
      // The free plan allows 600 weighted calls a minute; 48 cells over five months weigh ~500.
      if (start + 48 < grid.length) await sleep(60_000);
    }
    writeFileSync(forecastFile, JSON.stringify(payloads));
  }

  const mtgFile = new URL("mtg.json", dir);
  const nights: Record<string, LightningCluster[] | null> = existsSync(mtgFile) ? JSON.parse(readFileSync(mtgFile, "utf8")) : {};
  const bounds = lightningBounds(site, maxKm + 60);
  if (!bounds) throw new Error("The site is outside MTG-LI coverage.");
  const pad = String(hour).padStart(2, "0");
  for (let t = Date.parse(`${from}T${pad}:00:00Z`); t <= Date.parse(`${to}T${pad}:00:00Z`); t += 86_400_000) {
    const key = new Date(t).toISOString();
    if (key in nights) continue;
    try { nights[key] = await storms(bounds, t); } catch { nights[key] = null; }
    writeFileSync(mtgFile, JSON.stringify(nights));
    if (Object.keys(nights).length % 20 === 0) console.log(`MTG-LI: ${Object.keys(nights).length} nights`);
  }

  const cells = payloads.map((payload) => ({ payload, ...inverseGeodesic(site, payload) }));
  let stormCount = 0, found = 0, passingCount = 0, passingHit = 0, stormNights = 0, foreseen = 0, topNights = 0, topHit = 0, usable = 0;
  const bearingErrors: number[] = [];
  const centreKm: number[] = [];
  for (const [night, clusters] of Object.entries(nights)) {
    const index = payloads[0].hourly.time.indexOf(night.slice(0, 16));
    if (!clusters || index < 0) continue;
    usable += 1;
    const hourOf = (cell: (typeof cells)[number]) => ({
      capeJkg: cell.payload.hourly.cape[index], precipitationMm: cell.payload.hourly.precipitation[index], weatherCode: cell.payload.hourly.weather_code[index],
    });
    const nearby = (point: Coordinates) => clusters.filter((cluster) => km(point, cluster.centroid) - cluster.radiusKm <= NEAR_STORM_KM);
    const passing = cells.filter((cell) => isStormHour(hourOf(cell)));
    passingCount += passing.length;
    for (const cell of passing) {
      const hits = nearby(cell.payload);
      if (!hits.length) continue;
      passingHit += 1;
      centreKm.push(Math.min(...hits.map((cluster) => km(cell.payload, cluster.centroid))));
    }
    const large = clusters.filter((cluster) => cluster.areaKm2 >= LARGE_STORM_KM2 && km(site, cluster.centroid) >= minKm && km(site, cluster.centroid) <= maxKm);
    if (large.length) { stormNights += 1; if (passing.length) foreseen += 1; }
    for (const storm of large) {
      stormCount += 1;
      const matches = passing.filter((cell) => km(cell.payload, storm.centroid) - storm.radiusKm <= NEAR_STORM_KM);
      if (!matches.length) continue;
      found += 1;
      const bearing = inverseGeodesic(site, storm.centroid).initialBearingDeg;
      bearingErrors.push(Math.min(...matches.map((cell) => angle(cell.initialBearingDeg, bearing))));
    }
    if (!passing.length) continue;
    // The forecast target the app ranks first, with the same sky everywhere and terrain unchecked.
    const ranked = passing.map((cell) => {
      const { capeJkg, precipitationMm, weatherCode } = hourOf(cell);
      const total = scoreOpportunity({
        capeJkg, precipitationMm, thunderCode: weatherCode != null && [95, 96, 99].includes(weatherCode),
        observerCloudPercent: 10, observerHighCloudPercent: 5, visibilityM: 20_000, distanceKm: cell.distanceM / 1000,
        sunAltitudeDeg: -25, moonInterference: false, lightning: "not_configured", terrain: "unknown",
      }).total;
      return { cell, total };
    }).sort((a, b) => b.total - a.total);
    topNights += 1;
    if (nearby(ranked[0].cell.payload).length) topHit += 1;
  }
  console.log(`\nForecast targets, ${site.latitude},${site.longitude}, ${from}…${to} at ${pad}:00 UTC, ${minKm}–${maxKm} km, ${grid.length} scan cells, ${usable} nights with MTG-LI`);
  console.log(`  large storms (≥${LARGE_STORM_KM2} km²) with a target cell within ${NEAR_STORM_KM} km of their edge: ${pct(found, stormCount)}`);
  console.log(`  direction error to that cell: median ${quantile(bearingErrors, 0.5).toFixed(1)}°, 90th percentile ${quantile(bearingErrors, 0.9).toFixed(1)}°`);
  console.log(`  target cells with lightning within ${NEAR_STORM_KM} km: ${pct(passingHit, passingCount)}`);
  console.log(`  distance from such a cell to the storm centre: median ${quantile(centreKm, 0.5).toFixed(0)} km, 75th percentile ${quantile(centreKm, 0.75).toFixed(0)} km`);
  console.log(`  nights with a large storm that had at least one target cell: ${pct(foreseen, stormNights)}`);
  console.log(`  first-ranked forecast target with lightning within ${NEAR_STORM_KM} km: ${pct(topHit, topNights)}`);
}

interface TleRecord { id: number; latitude: number; longitude: number; utc: string; azimuth: number | null; categories: string[] }

async function spritacularRecords(): Promise<TleRecord[]> {
  const file = new URL("spritacular.json", CACHE);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const records: TleRecord[] = [];
  let url: string | null = "https://api.spritacular.org/api/observation/gallery/";
  for (let page = 0; url && page < 200; page += 1) {
    const response: Response = await fetch(url);
    if (!response.ok) throw new Error(`Spritacular ${response.status}`);
    const body = await response.json() as { next: string | null; results?: { data?: Array<Record<string, unknown>> } };
    for (const observation of body.results?.data ?? []) {
      const image = (observation.images as Array<Record<string, unknown>> | undefined)?.[0];
      if (!image || !observation.is_verified) continue;
      const record: TleRecord = {
        id: Number(observation.id),
        latitude: Number(image.latitude),
        longitude: Number(image.longitude),
        utc: String(image.obs_date_time_as_per_utc),
        azimuth: image.azimuth == null ? null : Number(image.azimuth),
        categories: ((observation.category_data as Array<{ name: string }> | undefined) ?? []).map((category) => category.name),
      };
      if (record.utc >= MTG_START && record.azimuth != null && Math.abs(record.latitude) <= 60 && Math.abs(record.longitude) <= 60) records.push(record);
    }
    url = body.next;
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, JSON.stringify(records, null, 1));
  return records;
}

async function tleCommand() {
  const records = await spritacularRecords();
  const ranks: number[] = [];
  let checked = 0, skipped = 0;
  for (const record of records) {
    const site = { latitude: record.latitude, longitude: record.longitude };
    const time = Date.parse(record.utc);
    // A daylight time cannot be right for a TLE photo (often local time sent as UTC).
    if (skyState(new Date(time), site.latitude, site.longitude).sunAltitudeDeg > -6) { skipped += 1; console.log(`  #${record.id} ${record.utc}: daylight at the stated time, skipped`); continue; }
    const bounds = lightningBounds(site, maxKm + 60);
    const clusters = bounds ? await storms(bounds, time) : null;
    if (!clusters) { skipped += 1; continue; }
    checked += 1;
    const sun = skyState(new Date(time), site.latitude, site.longitude).sunAltitudeDeg;
    // Observed targets ranked as the app ranks them (same clear sky, terrain unchecked, no model cell).
    const targets = clusters.map((cluster) => {
      const geometry = inverseGeodesic(site, cluster.centroid);
      const distanceKm = geometry.distanceM / 1000;
      const total = scoreOpportunity({
        capeJkg: null, precipitationMm: null, thunderCode: false, observerCloudPercent: 10, observerHighCloudPercent: 5, visibilityM: 20_000,
        distanceKm, sunAltitudeDeg: sun, moonInterference: false, lightning: "observed", terrain: "unknown",
        observedLightning: { observedAt: cluster.observedAt, ageMinutes: 15, areaKm2: cluster.areaKm2, maxFlashesPer5Min: cluster.maxFlashesPer5Min, frames: cluster.frames, windowMinutes: 15 },
      }).total;
      return { cluster, distanceKm, bearing: geometry.initialBearingDeg, total };
    }).filter((target) => target.distanceKm >= minKm && target.distanceKm <= maxKm).sort((a, b) => b.total - a.total);
    // A storm counts when the photo's azimuth falls on it, within half a wide-angle frame (25°).
    const rank = targets.findIndex((target) => angle(target.bearing, record.azimuth!) <= (Math.atan2(target.cluster.radiusKm, target.distanceKm) * 180) / Math.PI + 25) + 1;
    ranks.push(rank);
    console.log(`  #${record.id} ${record.utc} ${record.categories.join("/")} az ${record.azimuth}: ${targets.length} targets, photographed storm ${rank ? `#${rank}` : "not listed"}`);
  }
  const listed = ranks.filter((rank) => rank > 0);
  console.log(`\nSpritacular TLEs since ${MTG_START.slice(0, 10)}: ${checked} checked, ${skipped} skipped`);
  console.log(`  storm on the photographed azimuth among the app's targets (${minKm}–${maxKm} km): ${pct(listed.length, ranks.length)}`);
  console.log(`  ranked first: ${pct(ranks.filter((rank) => rank === 1).length, ranks.length)} · in the first three: ${pct(ranks.filter((rank) => rank >= 1 && rank <= 3).length, ranks.length)}`);
}

const command = args[0];
if (command === "forecast") await forecastCommand();
else if (command === "tle") await tleCommand();
else console.log("Usage: npm run verify -- forecast|tle [options] (see scripts/verify/verify.ts)");
