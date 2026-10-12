import { describe, expect, it } from "vitest";
import { eumetsatImageUrl, worldPixelToMercator } from "@/lib/providers/eumetsat";
import { metarCloudCoverPercent, selectAviationReport } from "@/lib/providers/aviation-weather";
import { parseMeteoAlarmFeed } from "@/lib/providers/meteoalarm";
import { assessAurora, parseOvationCoordinates } from "@/lib/providers/aurora";

const sparta = { latitude: 37.075, longitude: 22.43 };

describe("EUMETSAT Web Mercator overlay", () => {
  it("converts world pixels to EPSG:3857 metres", () => {
    expect(worldPixelToMercator(128, 128, 0).x).toBeCloseTo(0, 3);
    expect(worldPixelToMercator(128, 128, 0).y).toBeCloseTo(0, 3);
    expect(worldPixelToMercator(0, 0, 0).x).toBeCloseTo(-20_037_508.342789, 3);
    expect(worldPixelToMercator(0, 0, 0).y).toBeCloseTo(20_037_508.342789, 3);
  });
  it("requests the image in the map's own projection", () => {
    const url = new URL(eumetsatImageUrl("lightning", { minX: 0, minY: 4_000_000, maxX: 2_500_000, maxY: 5_000_000 }, 800, 320, "2026-10-11T18:15:00Z"));
    expect(url.searchParams.get("crs")).toBe("EPSG:3857");
    expect(url.searchParams.get("bbox")).toBe("0,4000000,2500000,5000000");
    expect(url.searchParams.get("width")).toBe("800");
    expect(url.searchParams.get("height")).toBe("320");
    expect(url.searchParams.get("layers")).toBe("mtg_fd:li_afa");
    expect(url.searchParams.get("time")).toBe("2026-10-11T18:15:00Z");
  });
});

describe("METAR station selection", () => {
  const now = Date.parse("2026-10-12T17:10:00Z");
  const report = (icaoId: string, lat: number, lon: number, minutesAgo: number) => ({
    icaoId, lat, lon, obsTime: (now - minutesAgo * 60_000) / 1000, name: icaoId, clouds: [],
  });
  it("uses the newest report of the nearest station", () => {
    const chosen = selectAviationReport([report("LGKL", 37.068, 22.025, 1_301), report("LGKL", 37.068, 22.025, 18)], sparta, now);
    expect(chosen?.report.obsTime).toBe((now - 18 * 60_000) / 1000);
  });
  it("prefers a fresh station over a nearer stale one", () => {
    const chosen = selectAviationReport([report("LGKL", 37.068, 22.025, 300), report("LGAD", 37.92, 21.29, 20)], sparta, now);
    expect(chosen?.report.icaoId).toBe("LGAD");
  });
  it("returns null when there are no reports", () => {
    expect(selectAviationReport([], sparta, now)).toBeNull();
  });
});

describe("METAR cloud cover", () => {
  it("treats CAVOK and no-significant-cloud reports as clear low sky", () => {
    expect(metarCloudCoverPercent([], "METAR LGKL 121650Z 00000KT CAVOK 20/16 Q1014")).toBe(0);
    expect(metarCloudCoverPercent([{ cover: "NSC" }], "METAR LGAV 121650Z 9999 NSC")).toBe(0);
  });
  it("keeps cover unknown when the report gives no cloud information", () => {
    expect(metarCloudCoverPercent([], "METAR LGKL 121650Z 00000KT 9999 20/16 Q1014")).toBeNull();
  });
  it("uses the densest reported layer", () => {
    expect(metarCloudCoverPercent([{ cover: "FEW" }, { cover: "BKN" }], "")).toBe(80);
  });
});

describe("MeteoAlarm ordering and counts", () => {
  const entry = (id: string, area: string, event: string, severity: string) =>
    `<entry><cap:identifier>${id}</cap:identifier><cap:areaDesc>${area}</cap:areaDesc><cap:event>${event}</cap:event><cap:severity>${severity}</cap:severity><cap:onset>2026-10-12T00:00:00+00:00</cap:onset><cap:expires>2099-01-01T00:00:00+00:00</cap:expires></entry>`;
  const feed = (entries: string[]) => `<feed><updated>2026-10-12T14:00:00Z</updated>${entries.join("")}</feed>`;

  it("reports the true number of alerts even when the list is shortened", () => {
    const entries = Array.from({ length: 50 }, (_, index) => entry(`id-${index}`, "Thraki", "Yellow Warning", "Moderate"));
    const result = parseMeteoAlarmFeed(feed(entries), "2026-10-12T17:00:00Z");
    expect(result.totalCount).toBe(50);
    expect(result.alerts.length).toBeLessThan(50);
  });
  it("puts alerts for the observer's region before more distant ones", () => {
    const result = parseMeteoAlarmFeed(feed([
      entry("far", "Thraki", "Severe Thunderstorm warning", "Severe"),
      entry("near", "East Peloponnisos", "Moderate Thunderstorm warning", "Moderate"),
    ]), "2026-10-12T17:00:00Z", sparta);
    expect(result.alerts.map((alert) => alert.id)).toEqual(["near", "far"]);
    expect(result.nearbyCount).toBe(1);
  });
  it("orders distant alerts by severity", () => {
    const result = parseMeteoAlarmFeed(feed([
      entry("moderate", "Thraki", "Moderate Rain warning", "Moderate"),
      entry("severe", "Kriti", "Severe Rain warning", "Severe"),
    ]), "2026-10-12T17:00:00Z", sparta);
    expect(result.alerts.map((alert) => alert.id)).toEqual(["severe", "moderate"]);
  });
  it("decodes double-escaped area names", () => {
    const result = parseMeteoAlarmFeed(feed([entry("e", "East Sterea &amp;amp; Evvoia", "Yellow Warning", "Moderate")]), "2026-10-12T17:00:00Z");
    expect(result.alerts[0].area).toBe("East Sterea & Evvoia");
  });
});

describe("NOAA OVATION aurora data", () => {
  it("rejects malformed coordinate tuples", () => {
    expect(() => parseOvationCoordinates({ coordinates: [[10, 60, "5"]] })).toThrow();
    expect(() => parseOvationCoordinates({ coordinates: "x" })).toThrow();
  });
  it("finds the local probability across the 0/360 longitude seam", () => {
    const coordinates = parseOvationCoordinates({ coordinates: [[359, 40, 7], [1, 41, 3], [180, 40, 90]] });
    const result = assessAurora(null, coordinates, 40, 0.5);
    expect(result.localProbabilityPercent).toBe(7);
  });
});
