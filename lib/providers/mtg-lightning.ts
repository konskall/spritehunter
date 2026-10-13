import type { Coordinates, LightningCluster, LightningObservation } from "@/lib/domain";
import { decodePng, type RgbaImage } from "@/lib/png";
import { TtlCache } from "@/lib/bounded-cache";
import { EUMETSAT_WMS_URL } from "@/lib/providers/eumetsat";
import { HttpError, fetchWithRetry } from "@/lib/providers/fetch";

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
const STALE_AFTER_MINUTES = 45;
// MTG-I sits at 0°; beyond ~65° from the sub-satellite point the full disk has no useful data.
const MTG_COVERAGE_DEGREES = 65;

// Colours sampled along the EUMETView "mtg_li_afa" legend (x pixel → colour). Ticks:
// 1 flash at x=149, 10 at x=405, 20+ at x=630 (count per pixel per 5 minutes).
const LEGEND_SAMPLES: Array<[number, number, number, number]> = [
  [152, 255, 255, 201], [164, 255, 249, 189], [176, 255, 246, 181], [188, 255, 240, 170], [200, 255, 237, 162],
  [212, 255, 234, 155], [224, 255, 230, 146], [236, 254, 227, 139], [248, 254, 223, 132], [260, 254, 219, 124],
  [272, 254, 212, 113], [284, 254, 205, 105], [296, 254, 198, 98], [308, 254, 191, 91], [320, 254, 185, 83],
  [332, 254, 178, 76], [344, 254, 170, 72], [356, 253, 161, 68], [368, 253, 155, 66], [380, 253, 148, 63],
  [392, 253, 142, 60], [404, 253, 131, 57], [416, 253, 119, 54], [428, 252, 107, 51], [440, 252, 92, 46],
  [452, 252, 81, 42], [464, 248, 70, 40], [476, 244, 61, 37], [488, 240, 52, 35], [500, 235, 43, 32],
  [512, 230, 33, 29], [524, 222, 23, 29], [536, 215, 18, 30], [548, 208, 13, 32], [560, 201, 8, 34],
  [572, 195, 3, 36], [584, 188, 0, 37], [596, 176, 0, 38], [608, 161, 0, 38], [620, 150, 0, 38], [632, 139, 0, 38],
];
const legendCount = (x: number) => (x <= 405 ? 10 ** ((x - 149) / 256) : Math.min(20, 10 + (x - 405) / 22.5));
const LEGEND = LEGEND_SAMPLES.map(([x, r, g, b]) => ({ r, g, b, count: legendCount(x) }));
const colourCounts = new Map<number, number>();

/** Approximate flashes per pixel per 5 minutes from the rendered AFA colour. */
export function flashCountFromColor(r: number, g: number, b: number) {
  const key = (r << 16) | (g << 8) | b;
  const cached = colourCounts.get(key);
  if (cached !== undefined) return cached;
  let best = LEGEND[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const stop of LEGEND) {
    const distance = (stop.r - r) ** 2 + (stop.g - g) ** 2 + (stop.b - b) ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = stop; }
  }
  colourCounts.set(key, best.count);
  return best.count;
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

export function lightningFrameUrl(bounds: GeoBounds, width: number, height: number, time?: string) {
  const params = new URLSearchParams({
    service: "WMS",
    version: "1.3.0",
    request: "GetMap",
    layers: "mtg_fd:li_afa",
    styles: "mtg_li_afa",
    format: "image/png",
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
 * Groups lit AFA pixels from several frames into storms: pixels are binned into
 * 0.2° cells and 8-connected cells form one storm. Single isolated pixels are dropped.
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
  const cells = new Map<number, number[]>();
  for (const index of pixels.keys()) {
    const cell = Math.floor((index / width) / cellPixels) * cellColumns + Math.floor((index % width) / cellPixels);
    const members = cells.get(cell);
    if (members) members.push(index);
    else cells.set(cell, [index]);
  }

  const visited = new Set<number>();
  const clusters: LightningCluster[] = [];
  for (const startCell of cells.keys()) {
    if (visited.has(startCell)) continue;
    visited.add(startCell);
    const queue = [startCell];
    const members: number[] = [];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const cell = queue[cursor];
      members.push(...cells.get(cell)!);
      const row = Math.floor(cell / cellColumns);
      const column = cell % cellColumns;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nextColumn = column + dx;
          if (nextColumn < 0 || nextColumn >= cellColumns) continue;
          const next = (row + dy) * cellColumns + nextColumn;
          if (cells.has(next) && !visited.has(next)) { visited.add(next); queue.push(next); }
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
    const radiusKm = Math.max(...points.map((point) => Math.hypot((point.longitude - centroid.longitude) * kmPerLon, (point.latitude - centroid.latitude) * 110.57))) + halfPixelKm;
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
  return clusters.sort((a, b) => b.areaKm2 - a.areaKm2).slice(0, 40);
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
const CACHE_TTL_MS = 4 * 60_000;
const FAILURE_TTL_MS = 60_000;

const utcClock = (iso: string) => new Date(iso).toISOString().slice(11, 16);

/** Latest 15 minutes of EUMETSAT MTG-LI accumulated flash area around the observer. */
export async function fetchLightningObservation(observer: Coordinates, radiusKm: number, nowMs = Date.now()): Promise<LightningObservation> {
  const retrievedAt = new Date(nowMs).toISOString();
  const bounds = lightningBounds(observer, radiusKm);
  if (!bounds) {
    return { status: "unsupported", retrievedAt, latestFrameAt: null, windowMinutes: 0, clusters: [], message: "Η θέση είναι εκτός κάλυψης του MTG-LI (Ευρώπη, Αφρική, Ατλαντικός)." };
  }
  const key = [bounds.west, bounds.south, bounds.east, bounds.north].join(":");
  const cached = observationCache.get(key, nowMs);
  if (cached) return cached;

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
        ? `Το τελευταίο καρέ MTG-LI (${utcClock(latest.time)} UTC) είναι παλαιότερο από ${STALE_AFTER_MINUTES} λεπτά· δεν χρησιμοποιείται στη βαθμολογία.`
        : clusters.length
          ? `Το MTG-LI ανιχνεύει ${clusters.length} ${clusters.length === 1 ? "περιοχή" : "περιοχές"} κεραυνών στην ευρύτερη περιοχή (${frames.length} καρέ έως ${utcClock(latest.time)} UTC).`
          : `Το MTG-LI δεν ανιχνεύει κεραυνούς στην ευρύτερη περιοχή (${frames.length} καρέ έως ${utcClock(latest.time)} UTC).`,
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
      message: `Οι παρατηρήσεις κεραυνών MTG-LI δεν ήταν διαθέσιμες (${error instanceof Error ? error.message : "άγνωστο σφάλμα"}).`,
    };
    observationCache.set(key, value, FAILURE_TTL_MS, nowMs);
    return value;
  }
}
