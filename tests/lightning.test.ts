import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { AviationObservation, LightningObservation, WeatherHour } from "@/lib/domain";
import { decodePng } from "@/lib/png";
import {
  clusterLightningFrames,
  flashCountFromColor,
  lightningBounds,
  lightningFrameSize,
  parseWmsTimeHeader,
} from "@/lib/providers/mtg-lightning";
import { buildCandidate, mergeLightningObservation } from "@/lib/providers/open-meteo";
import { scoreOpportunity } from "@/lib/scoring";

// --- Minimal PNG encoder for the decoder tests (CRCs are not checked by the decoder). ---
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  return out;
}

function encodePng(width: number, height: number, pixels: Uint8Array, colorType: 2 | 3 | 6, extra: Uint8Array[] = []) {
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
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
  header.set([8, colorType, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), ...extra, chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

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

  it("rejects data that is not a PNG", async () => {
    await expect(decodePng(new TextEncoder().encode("<ServiceExceptionReport/>"))).rejects.toThrow();
  });
});

describe("MTG-LI accumulated flash area", () => {
  it("maps legend colours to flash counts per 5 minutes", () => {
    expect(flashCountFromColor(254, 249, 189)).toBeGreaterThanOrEqual(1);
    expect(flashCountFromColor(254, 249, 189)).toBeLessThan(2);
    expect(flashCountFromColor(253, 131, 57)).toBeCloseTo(10, 0);
    expect(flashCountFromColor(177, 1, 38)).toBeGreaterThanOrEqual(15);
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
    expect(observed.reasons.some((reason) => reason.includes("MTG-LI"))).toBe(true);
  });

  it("rewards larger, more active lightning areas", () => {
    const small = scoreOpportunity({ ...base, lightning: "observed", observedLightning: { ...detail, areaKm2: 60, maxFlashesPer5Min: 1, frames: 1 } });
    const large = scoreOpportunity({ ...base, lightning: "observed", observedLightning: detail });
    expect(large.activity).toBeGreaterThan(small.activity);
  });

  it("treats missing model context as neutral for an observed storm", () => {
    const noModel = { ...base, capeJkg: null, precipitationMm: null, thunderCode: false };
    const observed = scoreOpportunity({ ...noModel, lightning: "observed", observedLightning: { ...detail, areaKm2: 17_000 } });
    // Bonus 6 + 10 (area) + 2 (rate) + 1 (persistence) on top of a neutral model term of 8.
    expect(observed.activity).toBe(27);
    expect(observed.limitations.some((text) => text.includes("μοντέλου"))).toBe(true);
  });

  it("damps a forecast that MTG-LI contradicts right now", () => {
    const contradicted = scoreOpportunity({ ...base, lightning: "not_detected" });
    expect(contradicted.activity).toBeLessThanOrEqual(12);
    expect(contradicted.limitations.some((text) => text.includes("MTG-LI"))).toBe(true);
  });
});

describe("merging MTG-LI storms with forecast targets", () => {
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
  const cluster = (latitude: number, longitude: number) => ({
    id: `mtg-${latitude}-${longitude}`, centroid: { latitude, longitude }, radiusKm: 30,
    observedAt: "2026-07-15T22:10:00.000Z", ageMinutes: 15, areaKm2: 5_000, maxFlashesPer5Min: 15, frames: 3, windowMinutes: 15,
  });
  const observation = (clusters: ReturnType<typeof cluster>[], status: LightningObservation["status"] = "available"): LightningObservation => ({
    status, retrievedAt: "2026-07-15T22:24:00.000Z", latestFrameAt: "2026-07-15T22:10:00.000Z", windowMinutes: 15, clusters, message: "",
  });
  const context = (payloads: ReturnType<typeof payload>[]) => ({ observerHours, aviation, payloads, minimumKm: 200, maximumKm: 600, fetchedAt: "2026-07-15T22:25:00.000Z", nowMs });

  it("turns a storm MTG-LI sees into an observed target and drops the duplicate forecast cell", () => {
    const target = payload({ 22: 900 });
    const forecast = buildCandidate(sparta, target, observerHours, aviation, "2026-07-15T22:25:00.000Z", nowMs)!;
    expect(forecast.forecastValidAt).toBe("2026-07-15T22:00Z");
    const merged = mergeLightningObservation(sparta, [forecast], observation([cluster(34.6, 24.4)]), context([target]));
    expect(merged).toHaveLength(1);
    const [observed] = merged;
    expect(observed.source).toBe("observed");
    expect(observed.scoreInput.lightning).toBe("observed");
    expect(observed.capeJkg).toBe(900);
    expect(observed.score.total).toBeGreaterThan(69);
    expect(observed.observedLightning?.areaKm2).toBe(5_000);
    expect(observed.provenance.kind).toBe("observation");
  });

  it("damps a near-term forecast cell with no lightning nearby", () => {
    const target = payload({ 22: 900 });
    const forecast = buildCandidate(sparta, target, observerHours, aviation, "2026-07-15T22:25:00.000Z", nowMs)!;
    const merged = mergeLightningObservation(sparta, [forecast], observation([cluster(41.5, 26.5)]), context([target]));
    const damped = merged.find((candidate) => candidate.source === "forecast")!;
    expect(damped.scoreInput.lightning).toBe("not_detected");
    expect(damped.score.activity).toBeLessThanOrEqual(12);
  });

  it("leaves later forecast hours and unavailable observations untouched", () => {
    const target = payload({ 40: 900 });
    const forecast = buildCandidate(sparta, target, observerHours, aviation, "2026-07-15T22:25:00.000Z", nowMs)!;
    expect(mergeLightningObservation(sparta, [forecast], observation([]), context([target]))[0].scoreInput.lightning).toBe("not_configured");
    const unavailable = mergeLightningObservation(sparta, [forecast], observation([cluster(34.6, 24.4)], "unavailable"), context([target]));
    expect(unavailable).toEqual([forecast]);
  });

  it("ignores storms outside the scan range", () => {
    const merged = mergeLightningObservation(sparta, [], observation([cluster(37.5, 22.6)]), context([]));
    expect(merged).toHaveLength(0);
  });
});
