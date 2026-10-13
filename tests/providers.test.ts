import { describe, expect, it } from "vitest";
import { eumetsatImageUrl, worldPixelToMercator } from "@/lib/providers/eumetsat";
import { metarCloudCoverPercent, metarCloudSummary, metarVisibility, selectAviationReport } from "@/lib/providers/aviation-weather";
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

describe("METAR decoding", () => {
  const raw = "METAR LGKL 132050Z VRB02KT 9999 FEW008 FEW018TCU SCT025 BKN080 15/14 Q1009";
  it("reads 9999 as 10 km or more, not the API's 6 statute miles", () => {
    expect(metarVisibility("6+", raw)).toEqual({ meters: 10_000, atLeast: true });
    expect(metarVisibility("6+", "METAR KJFK 132051Z 18005KT P6SM FEW250")).toEqual({ meters: 9_656, atLeast: true });
    expect(metarVisibility(3, "METAR LGAV 132050Z 4800 BR BECMG 9999")).toEqual({ meters: 4_828, atLeast: false });
  });
  it("names convective layers the API leaves out", () => {
    const clouds = [{ cover: "FEW", base: 800 }, { cover: "FEW", base: 1800 }, { cover: "SCT", base: 2500 }, { cover: "BKN", base: 8000 }];
    expect(metarCloudSummary(clouds, raw)).toEqual({
      el: "FEW 800 ft · FEW 1800 ft (πυργωμένοι σωρείτες) · SCT 2500 ft · BKN 8000 ft",
      en: "FEW 800 ft · FEW 1800 ft (towering cumulus) · SCT 2500 ft · BKN 8000 ft",
    });
    expect(metarCloudSummary([{ cover: "BKN", base: 3000 }], "METAR LGAV 132050Z 9999 BKN030 TEMPO BKN030CB").en).toBe("BKN 3000 ft");
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
  it("links each alert to its region page on meteoalarm.org, not to the CAP XML", () => {
    const links = `<link title="East Peloponnisos" href="https://meteoalarm.org?geocode=EMMA_ID:GR008" hreflang="en"/><link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/abc"/><link title="Greece" rel="related" href="https://meteoalarm.org?region=GR" hreflang="en"/>`;
    const withLinks = entry("a", "East Peloponnisos", "Severe Thunderstorm warning", "Severe").replace("</entry>", `${links}</entry>`);
    const withoutArea = entry("b", "Thraki", "Yellow Warning", "Moderate").replace("</entry>", `<link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/def"/></entry>`);
    const result = parseMeteoAlarmFeed(feed([withLinks, withoutArea]), "2026-10-12T17:00:00Z");
    expect(result.alerts.find((alert) => alert.id === "a")?.link).toBe("https://meteoalarm.org?geocode=EMMA_ID:GR008");
    expect(result.alerts.find((alert) => alert.id === "b")?.link).toBe("https://meteoalarm.org?region=GR");
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
