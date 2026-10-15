import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { AviationObservation, LightningObservation, StormCandidate, WeatherHour } from "@/lib/domain";
import { decodePng } from "@/lib/png";
import {
  clusterLightningFrames,
  flashCountFromColor,
  lightningBounds,
  lightningFrameSize,
  parseWmsTimeHeader,
} from "@/lib/providers/mtg-lightning";
import { buildTargets, selectTopCandidates } from "@/lib/providers/open-meteo";
import { scoreOpportunity } from "@/lib/scoring";

// --- Minimal PNG encoder for the decoder tests (CRCs are not checked by the decoder). ---
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  return out;
}

/** `pixels` holds the scanline bytes; below 8 bits they are already packed (see packRows). */
function encodePng(width: number, height: number, pixels: Uint8Array, colorType: 2 | 3 | 6, extra: Uint8Array[] = [], bitDepth = 8) {
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const filter = y % 5; // exercise None, Sub, Up, Average and Paeth
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x += 1) {
      const value = pixels[y * stride + x];
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
      raw[y * (stride + 1) + 1 + x] = (value - predictor) & 255;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([bitDepth, colorType, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), ...extra, chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** Packs palette indices into PNG rows: leftmost pixel in the high bits, each row padded to a byte. */
function packRows(width: number, height: number, indices: Uint8Array, bitDepth: number) {
  const stride = Math.ceil((width * bitDepth) / 8);
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      rows[y * stride + Math.floor((x * bitDepth) / 8)] |= indices[y * width + x] << (8 - bitDepth - ((x * bitDepth) % 8));
    }
  }
  return rows;
}

// The frame view.eumetsat.int returned for Greece at 14:50 UTC on 15 Oct 2026, with no lightning:
// 425 × 325, 1-bit palette of two transparent entries.
const EMPTY_MTG_FRAME = "iVBORw0KGgoAAAANSUhEUgAAAakAAAFFAQMAAABsZIDhAAAABlBMVEX///////9VfPVsAAAAAnRSTlMAAHaTzTgAAADDSURBVHhe7dKxCQBACARB7b/pL2Azs4cxXDAZbud0e/oab3FDgiQCCVaCJAIJVoIkAglWgiQCCVaCJAIJVoIkAglWgiQCCVaCJAIJVoIkAglWgiQCCVaCJAIJVoIkAglWgiQCCVaCJAIJVoIkAglWgiQCCVaCJAIJVoIkAglWgiQCCVaCJAIJVoIkAglWgiQCCVaCJAIJVoIkAglWgiQCCVaCJAIJVoIkAglWgiQCCVaCJAIJVoIkAglWgiQCCVbyJ8kDvcABRnSNaUwAAAAASUVORK5CYII=";

describe("PNG decoding", () => {
  it("decodes 8-bit RGBA with every scanline filter", async () => {
    const width = 7;
    const height = 6;
    const pixels = Uint8Array.from({ length: width * height * 4 }, (_, index) => (index * 37 + (index >> 3) * 11) & 255);
    const image = await decodePng(encodePng(width, height, pixels, 6));
    expect(image.width).toBe(width);
    expect(image.height).toBe(height);
    expect(Array.from(image.data)).toEqual(Array.from(pixels));
  });

  it("expands RGB and palette images to RGBA", async () => {
    const rgb = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    const rgbImage = await decodePng(encodePng(2, 2, rgb, 2));
    expect(Array.from(rgbImage.data)).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]);

    const palette = chunk("PLTE", Uint8Array.from([0, 0, 0, 177, 1, 38]));
    const transparency = chunk("tRNS", Uint8Array.from([0]));
    const indexed = await decodePng(encodePng(2, 1, Uint8Array.from([0, 1]), 3, [palette, transparency]));
    expect(Array.from(indexed.data)).toEqual([0, 0, 0, 0, 177, 1, 38, 255]);
  });

  it("unpacks 1-, 2- and 4-bit palette rows, skipping the padding bits at each row end", async () => {
    // Entry i is (15i, 15i + 5, 15i + 10). Width 5 never fills the last byte of a row.
    const palette = chunk("PLTE", Uint8Array.from({ length: 16 * 3 }, (_, index) => index * 5));
    const width = 5;
    const height = 5;
    for (const bitDepth of [1, 2, 4]) {
      const indices = Uint8Array.from({ length: width * height }, (_, index) => (index * 7 + 3) % (1 << bitDepth));
      const image = await decodePng(encodePng(width, height, packRows(width, height, indices, bitDepth), 3, [palette], bitDepth));
      expect(image.width).toBe(width);
      expect(Array.from(image.data)).toEqual(Array.from(indices).flatMap((entry) => [entry * 15, entry * 15 + 5, entry * 15 + 10, 255]));
    }
  });

  it("reads the empty 1-bit frame MTG-LI sends when there is no lightning", async () => {
    const image = await decodePng(Uint8Array.from(Buffer.from(EMPTY_MTG_FRAME, "base64")));
    expect([image.width, image.height]).toEqual([425, 325]);
    expect(image.data.every((value, index) => index % 4 !== 3 || value === 0)).toBe(true);
    const frame = { time: "2026-10-15T14:50:00.000Z", image };
    expect(clusterLightningFrames([frame], { west: 14, south: 31, east: 31, north: 44 }, Date.parse(frame.time))).toEqual([]);
  });

  it("rejects data that is not a PNG", async () => {
    await expect(decodePng(new TextEncoder().encode("<ServiceExceptionReport/>"))).rejects.toThrow();
  });
});

describe("MTG-LI accumulated flash area", () => {
  it("maps AFA colours to whole flash counts per 5 minutes on the linear scale", () => {
    // Dominant colours of 43,000 lit pixels in 24 live frames (15 Oct 2026): the counts sit
    // ~22 legend pixels apart, one per flash, from 1 up to the saturated 20+.
    const measured: Array<[number, number, number, number]> = [
      [254, 249, 189, 1], [254, 243, 173, 2], [255, 236, 158, 3], [254, 229, 143, 4], [254, 222, 128, 5],
      [254, 213, 113, 6], [254, 200, 98, 7], [254, 186, 83, 8], [254, 172, 72, 9], [254, 160, 66, 10],
      [253, 145, 61, 11], [253, 123, 52, 12], [253, 104, 46, 13], [252, 86, 42, 14],
      [234, 43, 32, 16], [225, 28, 30, 17], [212, 16, 33, 18], [182, 3, 38, 20],
    ];
    for (const [r, g, b, count] of measured) expect(flashCountFromColor(r, g, b), `${r},${g},${b}`).toBe(count);
    // A pixel blended at a storm edge reads as the nearest whole count.
    expect(flashCountFromColor(254, 247, 185)).toBe(1);
  });

  it("reads the frame time GeoServer actually used", () => {
    expect(parseWmsTimeHeader("99 Default value used: time=2026-10-12T21:10:00.000Z ISO8601 (mtg_fd:li_afa)")).toBe("2026-10-12T21:10:00.000Z");
    expect(parseWmsTimeHeader("99 Nearest value used: time=2026-10-12T21:05:00.000Z ISO8601 (mtg_fd:li_afa)")).toBe("2026-10-12T21:05:00.000Z");
    expect(parseWmsTimeHeader(null)).toBeNull();
  });

  it("covers the scan radius with whole-degree bounds inside the MTG disk", () => {
    const bounds = lightningBounds({ latitude: 37.075, longitude: 22.43 }, 660)!;
    expect(bounds.south).toBeLessThanOrEqual(37.075 - 660 / 111);
    expect(bounds.north).toBeGreaterThanOrEqual(37.075 + 660 / 111);
    expect(bounds.west).toBeLessThanOrEqual(15);
    expect(bounds.east).toBeGreaterThanOrEqual(29.8);
    for (const value of Object.values(bounds)) expect(Number.isInteger(value)).toBe(true);
    const size = lightningFrameSize(bounds);
    expect(size.width).toBeLessThanOrEqual(1024);
    expect((bounds.east - bounds.west) / size.width).toBeCloseTo(0.04, 2);
    expect(lightningBounds({ latitude: 75, longitude: 22 }, 600)).toBeNull();
    expect(lightningBounds({ latitude: 37, longitude: 120 }, 600)).toBeNull();
  });

  it("groups lit pixels from several frames into storms and drops isolated pixels", () => {
    const bounds = { west: 20, south: 35, east: 24, north: 39 };
    const blank = () => ({ width: 100, height: 100, data: new Uint8Array(100 * 100 * 4) });
    const paint = (image: ReturnType<typeof blank>, x: number, y: number, rgb: [number, number, number]) => {
      image.data.set([...rgb, 255], (y * 100 + x) * 4);
    };
    const latest = blank();
    const previous = blank();
    for (let x = 20; x < 25; x += 1) for (let y = 20; y < 25; y += 1) paint(latest, x, y, [177, 1, 38]);
    for (let x = 70; x < 73; x += 1) for (let y = 70; y < 72; y += 1) { paint(latest, x, y, [254, 249, 189]); paint(previous, x, y, [254, 249, 189]); }
    paint(previous, 50, 5, [254, 249, 189]);

    const clusters = clusterLightningFrames(
      [{ time: "2026-10-12T21:10:00.000Z", image: latest }, { time: "2026-10-12T21:05:00.000Z", image: previous }],
      bounds,
      Date.parse("2026-10-12T21:25:00Z"),
    );
    expect(clusters).toHaveLength(2);
    const [strong, weak] = clusters;
    expect(strong.centroid.longitude).toBeCloseTo(20.9, 2);
    expect(strong.centroid.latitude).toBeCloseTo(38.1, 2);
    expect(strong.areaKm2).toBeGreaterThan(300);
    expect(strong.areaKm2).toBeLessThan(450);
    expect(strong.maxFlashesPer5Min).toBeGreaterThanOrEqual(15);
    expect(strong.frames).toBe(1);
    expect(strong.observedAt).toBe("2026-10-12T21:10:00.000Z");
    expect(strong.ageMinutes).toBe(15);
    expect(weak.frames).toBe(2);
    expect(weak.maxFlashesPer5Min).toBeLessThan(2);
  });
});

describe("storm-sized lightning clusters", () => {
  it("keeps every storm, so a small one is not missed by the nearby-lightning check", () => {
    const bounds = { west: 20, south: 35, east: 24, north: 39 };
    const image = { width: 100, height: 100, data: new Uint8Array(100 * 100 * 4) };
    // 45 two-pixel storms, each two empty 0.2° cells away from the next.
    for (let index = 0; index < 45; index += 1) {
      const x = (index % 10) * 10;
      const y = Math.floor(index / 10) * 10;
      image.data.set([254, 243, 173, 255], (y * 100 + x) * 4);
      image.data.set([254, 243, 173, 255], (y * 100 + x + 1) * 4);
    }
    const clusters = clusterLightningFrames([{ time: "2026-10-12T21:10:00.000Z", image }], bounds, Date.parse("2026-10-12T21:25:00Z"));
    expect(clusters).toHaveLength(45);
  });

  it("splits a long squall line instead of chaining it into one huge storm", () => {
    const bounds = { west: 20, south: 35, east: 24, north: 39 };
    const image = { width: 100, height: 100, data: new Uint8Array(100 * 100 * 4) };
    for (let x = 0; x < 100; x += 1) image.data.set([254, 205, 105, 255], (50 * 100 + x) * 4);
    const clusters = clusterLightningFrames([{ time: "2026-10-12T21:10:00.000Z", image }], bounds, Date.parse("2026-10-12T21:25:00Z"));
    // The line is ~355 km long; storms are limited to ~75 km around their most active cell.
    expect(clusters.length).toBeGreaterThanOrEqual(3);
    for (const cluster of clusters) expect(cluster.radiusKm).toBeLessThanOrEqual(95);
    const totalArea = clusters.reduce((sum, cluster) => sum + cluster.areaKm2, 0);
    expect(totalArea).toBeGreaterThan(1_400);
  });
});

describe("observed lightning in the opportunity score", () => {
  const base = {
    capeJkg: 900, precipitationMm: 1, thunderCode: true, observerCloudPercent: 0, observerHighCloudPercent: 0,
    visibilityM: 30_000, distanceKm: 300, sunAltitudeDeg: -30, moonInterference: false, terrain: "unknown" as const,
  };
  const detail = { observedAt: "2026-07-15T22:10:00.000Z", ageMinutes: 15, areaKm2: 5_000, maxFlashesPer5Min: 15, frames: 3, windowMinutes: 15 };

  it("lifts the forecast-only cap and raises confidence when MTG-LI sees lightning", () => {
    const forecastOnly = scoreOpportunity({ ...base, lightning: "not_configured" });
    const observed = scoreOpportunity({ ...base, lightning: "observed", observedLightning: detail });
    expect(forecastOnly.total).toBeLessThanOrEqual(69);
    expect(observed.total).toBeGreaterThan(69);
    expect(observed.confidence).toBe("medium");
    expect(scoreOpportunity({ ...base, terrain: "clear", lightning: "observed", observedLightning: detail }).confidence).toBe("high");
    expect(observed.reasons.some((reason) => reason.el.includes("MTG-LI"))).toBe(true);
  });

  it("rewards larger, more active lightning areas", () => {
    const small = scoreOpportunity({ ...base, lightning: "observed", observedLightning: { ...detail, areaKm2: 60, maxFlashesPer5Min: 1, frames: 1 } });
    const large = scoreOpportunity({ ...base, lightning: "observed", observedLightning: detail });
    expect(large.activity).toBeGreaterThan(small.activity);
  });

  it("treats missing model context as neutral for an observed storm", () => {
    const noModel = { ...base, capeJkg: null, precipitationMm: null, thunderCode: false };
    const observed = scoreOpportunity({ ...noModel, lightning: "observed", observedLightning: { ...detail, areaKm2: 17_000 } });
    // Lightning 9 + 3.5·log10(17 000/50) ≈ 8.9 (area) + 2 (rate) + 1 (persistence) on top of a neutral model share of 3.
    expect(observed.activity).toBe(24);
    expect(observed.limitations.some((text) => text.el.includes("μοντέλου"))).toBe(true);
  });

  it("damps a forecast that MTG-LI contradicts right now", () => {
    const contradicted = scoreOpportunity({ ...base, lightning: "not_detected" });
    expect(contradicted.activity).toBeLessThanOrEqual(12);
    expect(contradicted.limitations.some((text) => text.el.includes("MTG-LI"))).toBe(true);
  });
});

describe("forecast and MTG-LI targets together", () => {
  const sparta = { latitude: 37.075, longitude: 22.43, elevationM: 210 };
  const start = Date.parse("2026-07-15T00:00:00Z");
  const hourIso = (index: number) => new Date(start + index * 3_600_000).toISOString().slice(0, 16);
  const payload = (storms: Record<number, number>) => {
    const hours = Array.from({ length: 48 }, (_, index) => index);
    return {
      latitude: 34.5, longitude: 24.5, elevation: 0,
      hourly: {
        time: hours.map(hourIso),
        cape: hours.map((index) => storms[index] ?? 0),
        precipitation: hours.map((index) => (storms[index] ? 1 : 0)),
        weather_code: hours.map((index) => (storms[index] ? 95 : 0)),
        wind_speed_10m: hours.map(() => 10),
      },
    };
  };
  const observerHours: WeatherHour[] = Array.from({ length: 48 }, (_, index) => ({
    time: `${hourIso(index)}Z`, temperatureC: 25, relativeHumidity: 50, precipitationMm: 0, precipitationProbability: 0,
    cloudCover: 0, cloudCoverLow: 0, cloudCoverMid: 0, cloudCoverHigh: 0, visibilityM: 30_000,
    windSpeedKmh: 5, windDirectionDeg: 0, capeJkg: 0, convectiveInhibitionJkg: 0, liftedIndex: 0, precipitableWaterKgM2: 20, weatherCode: 0,
  }));
  const aviation = { status: "unavailable", observedAt: null, distanceKm: null, cloudCoverPercent: null, visibilityM: null } as unknown as AviationObservation;
  const nowMs = Date.parse("2026-07-15T22:25:00Z");
  const cluster = (latitude: number, longitude: number, radiusKm = 30) => ({
    id: `mtg-${latitude}-${longitude}`, centroid: { latitude, longitude }, radiusKm,
    observedAt: "2026-07-15T22:10:00.000Z", ageMinutes: 15, areaKm2: 5_000, maxFlashesPer5Min: 15, frames: 3, windowMinutes: 15,
  });
  const observation = (clusters: ReturnType<typeof cluster>[], status: LightningObservation["status"] = "available"): LightningObservation => ({
    status, retrievedAt: "2026-07-15T22:24:00.000Z", latestFrameAt: "2026-07-15T22:10:00.000Z", windowMinutes: 15, clusters, message: { el: "", en: "" },
  });
  const context = { observerHours, aviation, minimumKm: 200, maximumKm: 600, fetchedAt: "2026-07-15T22:25:00.000Z", nowMs };

  it("turns a storm MTG-LI sees into an observed target and drops the duplicate forecast cell", () => {
    const targets = buildTargets(sparta, [payload({ 22: 900 })], observation([cluster(34.6, 24.4)]), context);
    expect(targets).toHaveLength(1);
    const [observed] = targets;
    expect(observed.source).toBe("observed");
    expect(observed.scoreInput.lightning).toBe("observed");
    expect(observed.capeJkg).toBe(900);
    expect(observed.score.total).toBeGreaterThan(69);
    expect(observed.observedLightning?.areaKm2).toBe(5_000);
    expect(observed.provenance.kind).toBe("observation");
  });

  it("confirms a forecast cell that sits near the edge of a large storm", () => {
    // Storm centroid ~150 km from the cell but 130 km wide: lightning reaches the cell.
    const storm = cluster(35.8, 24.6, 130);
    const targets = buildTargets(sparta, [payload({ 22: 900 })], observation([storm]), { ...context, minimumKm: 250 });
    const forecast = targets.find((candidate) => candidate.source === "forecast")!;
    expect(forecast.scoreInput.lightning).toBe("observed");
    expect(forecast.observedLightning?.stormId).toBe(storm.id);
  });

  it("damps a near-term forecast cell with no lightning nearby", () => {
    const [damped] = buildTargets(sparta, [payload({ 22: 900 })], observation([cluster(41.5, 26.5)]), context).filter((candidate) => candidate.source === "forecast");
    expect(damped.forecastValidAt).toBe("2026-07-15T22:00Z");
    expect(damped.scoreInput.lightning).toBe("not_detected");
    expect(damped.score.activity).toBeLessThanOrEqual(12);
  });

  it("keeps a later night hour when the current hour is contradicted", () => {
    const [forecast] = buildTargets(sparta, [payload({ 22: 900, 24: 900 })], observation([]), context);
    expect(forecast.forecastValidAt).toBe("2026-07-16T00:00Z");
    expect(forecast.scoreInput.lightning).toBe("not_configured");
  });

  it("does not judge hours more than 30 minutes after the newest frame", () => {
    const [forecast] = buildTargets(sparta, [payload({ 23: 900 })], observation([]), context);
    expect(forecast.forecastValidAt).toBe("2026-07-15T23:00Z");
    expect(forecast.scoreInput.lightning).toBe("not_configured");
  });

  it("ignores unavailable observations and storms outside the scan range", () => {
    const withoutLightning = buildTargets(sparta, [payload({ 22: 900 })], null, context);
    expect(buildTargets(sparta, [payload({ 22: 900 })], observation([cluster(34.6, 24.4)], "unavailable"), context)).toEqual(withoutLightning);
    expect(buildTargets(sparta, [], observation([cluster(37.5, 22.6)]), context)).toHaveLength(0);
  });
});

describe("ranked target list", () => {
  const target = (id: string, source: "forecast" | "observed", total: number) => ({ id, source, score: { total } }) as unknown as StormCandidate;
  it("keeps the best observed storms even when forecasts outrank them", () => {
    const forecasts = Array.from({ length: 12 }, (_, index) => target(`f${index}`, "forecast", 60 - index));
    const observed = [target("o1", "observed", 29), target("o2", "observed", 25)];
    const ranked = selectTopCandidates([...forecasts, ...observed], 10, 3);
    expect(ranked).toHaveLength(10);
    expect(ranked.map((candidate) => candidate.id)).toEqual(["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "o1", "o2"]);
  });
  it("does not pad when observed storms already rank", () => {
    const ranked = selectTopCandidates([target("o1", "observed", 80), target("f1", "forecast", 50)], 10, 3);
    expect(ranked.map((candidate) => candidate.id)).toEqual(["o1", "f1"]);
  });
});
