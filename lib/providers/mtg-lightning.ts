import type { Coordinates, LightningCluster, LightningObservation } from "@/lib/domain";
import { decodePng, type RgbaImage } from "@/lib/png";
import { InFlight, TtlCache } from "@/lib/bounded-cache";
import { EUMETSAT_WMS_URL } from "@/lib/providers/eumetsat";
import { HttpError, fetchWithRetry } from "@/lib/providers/fetch";
import { tx } from "@/lib/i18n";

export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface LightningFrame {
  /** Frame time GeoServer reports for the image. */
  time: string;
  image: RgbaImage;
}

const FRAME_MINUTES = 5;
const FRAME_COUNT = 3;
const TARGET_DEGREES_PER_PIXEL = 0.04;
const MAX_FRAME_PIXELS = 1024;
const CLUSTER_CELL_DEGREES = 0.2;
// A storm grows from its most active cell to connected cells within this radius. Squall
// lines and frontal bands are split into several targets instead of one centroid that
// may sit between storms, hundreds of kilometres from any lightning.
const STORM_RADIUS_KM = 75;
const STALE_AFTER_MINUTES = 45;
// MTG-I sits at 0°; beyond ~65° from the sub-satellite point the full disk has no useful data.
const MTG_COVERAGE_DEGREES = 65;

// The colour of each whole flash count per pixel per 5 minutes, 1 to 20 (20 also stands for
// more). Read from 43,000 lit pixels in 24 live frames (15 Oct 2026): the counts sit evenly
// ~22 legend pixels apart, so the scale is linear, not logarithmic as once assumed; reading it
// as logarithmic halved mid-range counts and never reached 20+.
const AFA_PALETTE: Array<[number, number, number]> = [
  [254, 249, 189], [254, 243, 173], [255, 236, 158], [254, 229, 143], [254, 222, 128],
  [254, 213, 113], [254, 200, 98], [254, 186, 83], [254, 172, 72], [254, 160, 66],
  [253, 145, 61], [253, 123, 52], [253, 104, 46], [252, 86, 42], [235, 66, 40],
  [234, 43, 32], [225, 28, 30], [212, 16, 33], [192, 14, 37], [182, 3, 38],
];
const colourCounts = new Map<number, number>();

/** Flashes per pixel per 5 minutes from the rendered AFA colour; 20 means 20 or more. */
export function flashCountFromColor(r: number, g: number, b: number) {
  const key = (r << 16) | (g << 8) | b;
  const cached = colourCounts.get(key);
  if (cached !== undefined) return cached;
  let count = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  AFA_PALETTE.forEach(([pr, pg, pb], index) => {
    const distance = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (distance < bestDistance) { bestDistance = distance; count = index + 1; }
  });
  colourCounts.set(key, count);
  return count;
}

/** GeoServer reports the time it actually rendered in a `Warning: 99 … time=…` header. */
export function parseWmsTimeHeader(header: string | null) {
  return header?.match(/time=(\d{4}-\d\d-\d\dT[\d:.]+Z)/)?.[1] ?? null;
}

/** Whole-degree box covering `radiusKm` around the observer, or null outside MTG-LI coverage. */
export function lightningBounds(observer: Coordinates, radiusKm: number): GeoBounds | null {
  if (Math.abs(observer.latitude) > MTG_COVERAGE_DEGREES || Math.abs(observer.longitude) > MTG_COVERAGE_DEGREES) return null;
  const latHalf = radiusKm / 110.57;
  const poleward = Math.min(89, Math.abs(observer.latitude) + latHalf);
  const lonHalf = radiusKm / (111.32 * Math.cos((poleward * Math.PI) / 180));
  const clip = (value: number) => Math.max(-70, Math.min(70, value));
  return {
    west: clip(Math.floor(observer.longitude - lonHalf)),
    south: clip(Math.floor(observer.latitude - latHalf)),
    east: clip(Math.ceil(observer.longitude + lonHalf)),
    north: clip(Math.ceil(observer.latitude + latHalf)),
  };
}

export function lightningFrameSize(bounds: GeoBounds) {
  const spanLon = bounds.east - bounds.west;
  const spanLat = bounds.north - bounds.south;
  const degreesPerPixel = Math.max(TARGET_DEGREES_PER_PIXEL, spanLon / MAX_FRAME_PIXELS, spanLat / MAX_FRAME_PIXELS);
  return { width: Math.round(spanLon / degreesPerPixel), height: Math.round(spanLat / degreesPerPixel) };
}

function lightningFrameUrl(bounds: GeoBounds, width: number, height: number, time?: string) {
  const params = new URLSearchParams({
    service: "WMS",
    version: "1.3.0",
    request: "GetMap",
    layers: "mtg_fd:li_afa",
    styles: "mtg_li_afa",
    // Palette PNG: same lit pixels and legend colours as RGBA, a quarter of the bytes to inflate.
    format: "image/png8",
    transparent: "true",
    // CRS:84 keeps lon/lat axis order, and the plate carrée grid maps pixels straight to degrees.
    crs: "CRS:84",
    bbox: [bounds.west, bounds.south, bounds.east, bounds.north].join(","),
    width: String(width),
    height: String(height),
  });
  if (time) params.set("time", time);
  return `${EUMETSAT_WMS_URL}?${params}`;
}

/**
 * Groups lit AFA pixels from several frames into storms. Pixels are binned into 0.2°
 * cells; each storm starts at the most active unassigned cell and takes the 8-connected
 * cells within STORM_RADIUS_KM of it. Single isolated pixels are dropped.
 */
export function clusterLightningFrames(frames: LightningFrame[], bounds: GeoBounds, nowMs = Date.now()): LightningCluster[] {
  if (!frames.length) return [];
  const { width, height } = frames[0].image;
  const degLon = (bounds.east - bounds.west) / width;
  const degLat = (bounds.north - bounds.south) / height;
  const frameTimes = frames.map((frame) => Date.parse(frame.time));
  const pixels = new Map<number, { count: number; frameMask: number; latestMs: number }>();
  frames.forEach((frame, frameIndex) => {
    if (frame.image.width !== width || frame.image.height !== height) return;
    const { data } = frame.image;
    for (let index = 0; index < width * height; index += 1) {
      if (data[index * 4 + 3] === 0) continue;
      const count = flashCountFromColor(data[index * 4], data[index * 4 + 1], data[index * 4 + 2]);
      const existing = pixels.get(index);
      if (existing) {
        existing.count = Math.max(existing.count, count);
        existing.frameMask |= 1 << frameIndex;
        existing.latestMs = Math.max(existing.latestMs, frameTimes[frameIndex]);
      } else {
        pixels.set(index, { count, frameMask: 1 << frameIndex, latestMs: frameTimes[frameIndex] });
      }
    }
  });

  const cellPixels = Math.max(1, Math.round(CLUSTER_CELL_DEGREES / degLon));
  const cellColumns = Math.ceil(width / cellPixels);
  const cells = new Map<number, { members: number[]; weight: number }>();
  for (const [index, pixel] of pixels) {
    const cell = Math.floor((index / width) / cellPixels) * cellColumns + Math.floor((index % width) / cellPixels);
    const entry = cells.get(cell);
    if (entry) { entry.members.push(index); entry.weight += pixel.count; }
    else cells.set(cell, { members: [index], weight: pixel.count });
  }
  const cellCenter = (cell: number) => ({
    latitude: bounds.north - (Math.floor(cell / cellColumns) + 0.5) * cellPixels * degLat,
    longitude: bounds.west + ((cell % cellColumns) + 0.5) * cellPixels * degLon,
  });
  const kmBetween = (a: Coordinates, b: Coordinates) => Math.hypot(
    (a.longitude - b.longitude) * 111.32 * Math.cos((((a.latitude + b.latitude) / 2) * Math.PI) / 180),
    (a.latitude - b.latitude) * 110.57,
  );

  const visited = new Set<number>();
  const clusters: LightningCluster[] = [];
  const seeds = [...cells.keys()].sort((a, b) => cells.get(b)!.weight - cells.get(a)!.weight || a - b);
  for (const seed of seeds) {
    if (visited.has(seed)) continue;
    visited.add(seed);
    const seedCenter = cellCenter(seed);
    const queue = [seed];
    const members: number[] = [];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const cell = queue[cursor];
      for (const member of cells.get(cell)!.members) members.push(member);
      const row = Math.floor(cell / cellColumns);
      const column = cell % cellColumns;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nextColumn = column + dx;
          if (nextColumn < 0 || nextColumn >= cellColumns) continue;
          const next = (row + dy) * cellColumns + nextColumn;
          if (!cells.has(next) || visited.has(next) || kmBetween(seedCenter, cellCenter(next)) > STORM_RADIUS_KM) continue;
          visited.add(next);
          queue.push(next);
        }
      }
    }
    if (members.length < 2) continue;

    let weight = 0;
    let latSum = 0;
    let lonSum = 0;
    let areaKm2 = 0;
    let maxCount = 0;
    let frameMask = 0;
    let latestMs = Number.NEGATIVE_INFINITY;
    const points = members.map((index) => {
      const pixel = pixels.get(index)!;
      const latitude = bounds.north - (Math.floor(index / width) + 0.5) * degLat;
      const longitude = bounds.west + ((index % width) + 0.5) * degLon;
      weight += pixel.count;
      latSum += latitude * pixel.count;
      lonSum += longitude * pixel.count;
      areaKm2 += degLon * 111.32 * Math.cos((latitude * Math.PI) / 180) * degLat * 110.57;
      maxCount = Math.max(maxCount, pixel.count);
      frameMask |= pixel.frameMask;
      latestMs = Math.max(latestMs, pixel.latestMs);
      return { latitude, longitude };
    });
    const centroid = { latitude: latSum / weight, longitude: lonSum / weight };
    const kmPerLon = 111.32 * Math.cos((centroid.latitude * Math.PI) / 180);
    const halfPixelKm = Math.hypot(degLon * kmPerLon, degLat * 110.57) / 2;
    let farthestKm = 0;
    for (const point of points) {
      farthestKm = Math.max(farthestKm, Math.hypot((point.longitude - centroid.longitude) * kmPerLon, (point.latitude - centroid.latitude) * 110.57));
    }
    const radiusKm = farthestKm + halfPixelKm;
    let frameCount = 0;
    for (let bits = frameMask; bits; bits &= bits - 1) frameCount += 1;
    clusters.push({
      id: `mtg-${centroid.latitude.toFixed(2)}-${centroid.longitude.toFixed(2)}`,
      centroid,
      radiusKm: Math.round(radiusKm),
      observedAt: frames[frameTimes.indexOf(latestMs)].time,
      ageMinutes: Math.round((nowMs - latestMs) / 60_000),
      areaKm2: Math.round(areaKm2),
      maxFlashesPer5Min: Math.round(maxCount * 10) / 10,
      frames: frameCount,
      windowMinutes: frames.length * FRAME_MINUTES,
    });
  }
  // All storms: the check for lightning near a forecast cell must see small ones too.
  // The response lists only the largest (see fetchOpportunities).
  return clusters.sort((a, b) => b.areaKm2 - a.areaKm2);
}

async function fetchFrame(bounds: GeoBounds, width: number, height: number, time?: string): Promise<LightningFrame> {
  return fetchWithRetry(lightningFrameUrl(bounds, width, height, time), async (response) => {
    if (!(response.headers.get("content-type") ?? "").startsWith("image/png")) {
      // GeoServer answers dimension errors with an XML exception and HTTP 200.
      const text = await response.text();
      throw new HttpError(422, text.match(/<ServiceException[^>]*>([\s\S]*?)<\/ServiceException>/)?.[1]?.trim() ?? "WMS exception");
    }
    const usedTime = parseWmsTimeHeader(response.headers.get("warning")) ?? time;
    if (!usedTime) throw new HttpError(422, "MTG-LI frame has no time stamp");
    return { time: usedTime, image: await decodePng(new Uint8Array(await response.arrayBuffer())) };
  }, { retries: 2, timeoutMs: 10_000, deadlineMs: 18_000, headers: { Accept: "image/png" } });
}

const observationCache = new TtlCache<LightningObservation>(50);
const observationInFlight = new InFlight<LightningObservation>();
const CACHE_TTL_MS = 4 * 60_000;
const FAILURE_TTL_MS = 60_000;

const utcClock = (iso: string) => new Date(iso).toISOString().slice(11, 16);

/** Latest 15 minutes of EUMETSAT MTG-LI accumulated flash area around the observer. */
export async function fetchLightningObservation(observer: Coordinates, radiusKm: number, nowMs = Date.now()): Promise<LightningObservation> {
  const retrievedAt = new Date(nowMs).toISOString();
  const bounds = lightningBounds(observer, radiusKm);
  if (!bounds) {
    return { status: "unsupported", retrievedAt, latestFrameAt: null, windowMinutes: 0, clusters: [], message: tx("Η θέση είναι εκτός κάλυψης του MTG-LI (Ευρώπη, Αφρική, Ατλαντικός).", "The location is outside MTG-LI coverage (Europe, Africa, Atlantic).") };
  }
  const key = [bounds.west, bounds.south, bounds.east, bounds.north].join(":");
  const cached = observationCache.get(key, nowMs);
  if (cached) return cached;
  return observationInFlight.run(key, () => loadObservation(bounds, key, nowMs));
}

async function loadObservation(bounds: GeoBounds, key: string, nowMs: number): Promise<LightningObservation> {
  const retrievedAt = new Date(nowMs).toISOString();
  try {
    const { width, height } = lightningFrameSize(bounds);
    const latest = await fetchFrame(bounds, width, height);
    const latestMs = Date.parse(latest.time);
    const older = await Promise.allSettled(
      Array.from({ length: FRAME_COUNT - 1 }, (_, index) =>
        fetchFrame(bounds, width, height, new Date(latestMs - (index + 1) * FRAME_MINUTES * 60_000).toISOString())),
    );
    const frames = [latest, ...older.flatMap((result, index) =>
      // Nearest-value matching may snap a missing frame onto another; keep only exact times.
      result.status === "fulfilled" && Date.parse(result.value.time) === latestMs - (index + 1) * FRAME_MINUTES * 60_000 ? [result.value] : [])];
    const clusters = clusterLightningFrames(frames, bounds, nowMs);
    const stale = nowMs - latestMs > STALE_AFTER_MINUTES * 60_000;
    const value: LightningObservation = {
      status: stale ? "stale" : "available",
      retrievedAt,
      latestFrameAt: latest.time,
      windowMinutes: frames.length * FRAME_MINUTES,
      clusters,
      message: stale
        ? tx(
          `Το τελευταίο καρέ MTG-LI (${utcClock(latest.time)} UTC) είναι παλαιότερο από ${STALE_AFTER_MINUTES} λεπτά· δεν χρησιμοποιείται στη βαθμολογία.`,
          `The newest MTG-LI frame (${utcClock(latest.time)} UTC) is older than ${STALE_AFTER_MINUTES} minutes and is not used for scoring.`,
        )
        : clusters.length
          ? tx(
            `Το MTG-LI ανιχνεύει ${clusters.length} ${clusters.length === 1 ? "περιοχή" : "περιοχές"} κεραυνών στην ευρύτερη περιοχή (${frames.length} καρέ έως ${utcClock(latest.time)} UTC).`,
            `MTG-LI detects ${clusters.length} lightning ${clusters.length === 1 ? "area" : "areas"} in the wider region (${frames.length} frames up to ${utcClock(latest.time)} UTC).`,
          )
          : tx(
            `Το MTG-LI δεν ανιχνεύει κεραυνούς στην ευρύτερη περιοχή (${frames.length} καρέ έως ${utcClock(latest.time)} UTC).`,
            `MTG-LI detects no lightning in the wider region (${frames.length} frames up to ${utcClock(latest.time)} UTC).`,
          ),
    };
    observationCache.set(key, value, CACHE_TTL_MS, nowMs);
    return value;
  } catch (error) {
    const value: LightningObservation = {
      status: "unavailable",
      retrievedAt,
      latestFrameAt: null,
      windowMinutes: 0,
      clusters: [],
      message: tx(
        `Οι παρατηρήσεις κεραυνών MTG-LI δεν ήταν διαθέσιμες (${error instanceof Error ? error.message : "άγνωστο σφάλμα"}).`,
        `MTG-LI lightning observations were unavailable (${error instanceof Error ? error.message : "unknown error"}).`,
      ),
    };
    observationCache.set(key, value, FAILURE_TTL_MS, nowMs);
    return value;
  }
}
