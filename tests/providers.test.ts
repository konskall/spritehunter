import { afterEach, describe, expect, it, vi } from "vitest";
import { eumetsatImageUrl, worldPixelToMercator } from "@/lib/providers/eumetsat";
import { fetchNearestAviationWeather, metarCloudCoverPercent, metarCloudSummary, metarVisibility, selectAviationReport } from "@/lib/providers/aviation-weather";
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
  it("reads the hazard and colour from the title when cap:event names only the colour", () => {
    // The live Greek feed (22 Oct 2026): cap:event "Yellow Warning", hazard only in the title.
    const titled = (id: string, title: string) => entry(id, "Ionion Islands", "Yellow Warning", "Moderate").replace("</entry>", `<title>${title}</title></entry>`);
    const result = parseMeteoAlarmFeed(feed([
      titled("rain", "Yellow Rain Warning issued for Greece - Ionion Islands"),
      titled("storm", "Yellow Thunderstorm Warning issued for Greece - Ionion Islands"),
    ]), "2026-10-12T17:00:00Z", sparta);
    expect(result.alerts.map((alert) => [alert.id, alert.hazard, alert.level])).toEqual([
      ["storm", "Thunderstorm", "yellow"],
      ["rain", "Rain", "yellow"],
    ]);
  });
  it("still reads older entries that name the hazard in cap:event", () => {
    const result = parseMeteoAlarmFeed(feed([entry("old", "Thraki", "Severe Thunderstorm warning", "Severe")]), "2026-10-12T17:00:00Z");
    expect(result.alerts[0]).toMatchObject({ hazard: "Thunderstorm", level: "orange" });
  });
});

describe("AviationWeather report fields", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes temperature, dew point, pressure and gusts from the report itself", async () => {
    // Shaped like the live JSON for LGKL on 22 Oct 2026, with a gust added.
    const report = {
      icaoId: "LGKL", obsTime: Math.floor(Date.now() / 1000) - 600, lat: 37.068, lon: 22.025, name: "Kalamata Arpt, J, GR",
      visib: "6+", wdir: 300, wspd: 12, wgst: 25, temp: 16, dewp: 15, altim: 1018, fltCat: "VFR",
      rawOb: "METAR LGKL 220550Z 30012G25KT 9999 FEW010 16/15 Q1018", clouds: [{ cover: "FEW", base: 1000 }],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => Response.json(String(input).includes("/taf") ? [] : [report])));
    const observation = await fetchNearestAviationWeather(sparta);
    // 25 kt = 46.3 km/h.
    expect(observation).toMatchObject({ stationId: "LGKL", temperatureC: 16, dewPointC: 15, pressureHpa: 1018, windGustKmh: 46 });
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
  // The live grid at Kp 0.67 on 15 Oct 2026: the usual polar oval, nothing south of 58°N.
  const quietOval = parseOvationCoordinates({ coordinates: [[22, 45, 0], [22, 58, 1], [22, 62, 3], [22, 66, 11], [22, 70, 20], [39, 71, 24]] });
  it("stays quiet when only the polar oval, far beyond the horizon, is active", () => {
    const result = assessAurora(0.67, quietOval, sparta.latitude, sparta.longitude);
    expect(result.level).toBe("quiet");
    // 58°N is ~2,300 km from Sparta: even 400 km high aurora there is below the horizon.
    expect(result.northernSectorProbabilityPercent).toBe(0);
  });
  it("reports possible aurora once the oval comes within view to the north", () => {
    // 51°N at 22°E is ~1,550 km from Sparta: aurora ~300 km up shows a few degrees above the horizon.
    const storm = parseOvationCoordinates({ coordinates: [...quietOval, [22, 51, 12]] });
    const result = assessAurora(5, storm, sparta.latitude, sparta.longitude);
    expect(result.level).toBe("possible");
    expect(result.northernSectorProbabilityPercent).toBe(12);
  });
});
