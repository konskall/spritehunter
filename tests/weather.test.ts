import { afterEach, describe, expect, it, vi } from "vitest";
import type { AirQualityConditions, LightningCluster, StationHour } from "@/lib/domain";
import { fetchWeatherStation, parseAirQuality, parseStationForecast } from "@/lib/providers/weather-station";
import {
  alertText,
  aqiLevel,
  beaufort,
  capeLevel,
  cinLevel,
  directionLabel,
  isSameSite,
  isStormHour,
  liftedIndexLevel,
  localStormStatus,
  nearestLightning,
  nightOutlook,
  pressureTendency,
  rainAhead,
  rainNextHour,
  stormPeriods,
  uvLevel,
  weatherCodeInfo,
} from "@/lib/weather";
import { moonDay, moonPhaseName, nextMoonQuarters, nextMoonRiseSet, nightWindow, sunDay, twilightBand } from "@/lib/sky-calendar";
import { athensDayBounds, athensDayDifference, athensNoon } from "@/lib/time";

// Open-Meteo answers with Unix seconds (timeformat=unixtime); 1792162800 is 2026-10-16 15:00 UTC.
const FORECAST = {
  latitude: 37.08,
  longitude: 22.43,
  elevation: 230,
  current: {
    time: 1792165500, interval: 900, temperature_2m: 16.2, apparent_temperature: 15.5, relative_humidity_2m: 73, dew_point_2m: 11.4,
    pressure_msl: 1014.4, wind_speed_10m: 8.4, wind_gusts_10m: 24.8, wind_direction_10m: 83, cloud_cover: 97, precipitation: 0.1,
    visibility: 38640, uv_index: 0.05, weather_code: 80, is_day: 1,
  },
  hourly: {
    time: [1792162800, 1792166400],
    temperature_2m: [17.4, 15.9],
    dew_point_2m: [11, 11.7],
    pressure_msl: [1014.3, 1014.5],
    cape: [0, null],
    weather_code: [3, 80],
    is_day: [1, 0],
    cloud_cover_high: [0, 12],
  },
  daily: {
    time: [1792098000],
    weather_code: [80], temperature_2m_max: [20.3], temperature_2m_min: [9.7], precipitation_sum: [1.2], precipitation_probability_max: [43],
    precipitation_hours: [5], wind_speed_10m_max: [19.3], wind_gusts_10m_max: [34.9], wind_direction_10m_dominant: [104], uv_index_max: [3.65],
    sunshine_duration: [32400],
  },
};

const AIR = {
  current: { time: 1792162800, interval: 3600, european_aqi: 28, european_aqi_pm2_5: 22, pm2_5: 6.2, olive_pollen: 0 },
  hourly: { time: [1792162800], european_aqi: [28], pm10: [6.7], dust: [0], aerosol_optical_depth: [0.31], olive_pollen: [14] },
};

describe("weather station data", () => {
  it("reads Open-Meteo's Unix times, keeps missing values as null and converts units", () => {
    const parsed = parseStationForecast(FORECAST);
    expect(parsed.modelElevationM).toBe(230);
    expect(parsed.current).toMatchObject({ time: "2026-10-16T15:45:00.000Z", temperatureC: 16.2, pressureHpa: 1014.4, isDay: true, weatherCode: 80 });
    expect(parsed.hours[0].time).toBe("2026-10-16T15:00:00.000Z");
    expect(parsed.hours[1]).toMatchObject({ temperatureC: 15.9, isDay: false, capeJkg: null, cloudCoverHigh: 12 });
    // A variable the response left out is unknown, not zero.
    expect(parsed.hours[1].freezingLevelM).toBeNull();
    expect(parsed.hours[1].precipitationProbability).toBeNull();
    // Daily values start at Athens midnight (21:00 UTC in summer time).
    expect(parsed.days[0]).toMatchObject({ date: "2026-10-15T21:00:00.000Z", temperatureMaxC: 20.3, sunshineHours: 9, windDirectionDeg: 104 });
  });

  it("rejects a payload without hourly data", () => {
    expect(() => parseStationForecast({ daily: FORECAST.daily })).toThrow();
  });

  it("reads CAMS air quality, pollen included", () => {
    const parsed = parseAirQuality(AIR);
    expect(parsed.current).toMatchObject({ europeanAqi: 28, aqiPm2_5: 22, pm2_5: 6.2, ozone: null });
    expect(parsed.current?.pollen.olive).toBe(0);
    expect(parsed.hours[0]).toMatchObject({ time: "2026-10-16T15:00:00.000Z", aerosolOpticalDepth: 0.31, dust: 0 });
    expect(parsed.hours[0].pollen).toMatchObject({ olive: 14, birch: null });
  });
});

describe("fetchWeatherStation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the forecast when air quality fails, and caches the result per site", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("air-quality")) return new Response("down", { status: 503 });
      expect(url).toContain("timeformat=unixtime");
      expect(url).toContain("timezone=Europe%2FAthens");
      return Response.json(FORECAST);
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = await fetchWeatherStation({ latitude: 36.111, longitude: 22.111 });
    expect(first.status).toBe("available");
    expect(first.hours).toHaveLength(2);
    expect(first.airQuality.status).toBe("unavailable");
    expect(first.airQuality.hours).toEqual([]);
    const calls = fetchMock.mock.calls.length;
    await fetchWeatherStation({ latitude: 36.111, longitude: 22.111 });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("fails when the forecast itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 400 })));
    await expect(fetchWeatherStation({ latitude: 36.222, longitude: 22.222 })).rejects.toThrow("HTTP 400");
  });
});

describe("/api/weather", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects an invalid site and reports a provider failure as 502", async () => {
    const { GET } = await import("@/app/api/weather/route");
    expect((await GET(new Request("http://localhost/api/weather?lat=&lon=22"))).status).toBe(400);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    const failed = await GET(new Request("http://localhost/api/weather?lat=36.333&lon=22.333"));
    expect(failed.status).toBe(502);
    expect(failed.headers.get("cache-control")).toBeNull();
  });
});

const hour = (time: string, values: Partial<StationHour> = {}): StationHour => ({
  time, temperatureC: null, apparentTemperatureC: null, relativeHumidity: null, dewPointC: null, pressureHpa: null, windSpeedKmh: null,
  windGustsKmh: null, windDirectionDeg: null, cloudCover: null, precipitationMm: null, visibilityM: null, uvIndex: null, weatherCode: null,
  isDay: null, precipitationProbability: null, cloudCoverLow: null, cloudCoverMid: null, cloudCoverHigh: null, capeJkg: null,
  liftedIndex: null, convectiveInhibitionJkg: null, freezingLevelM: null, ...values,
});

describe("weather helpers", () => {
  it("names WMO codes, compass points and Beaufort forces", () => {
    expect(weatherCodeInfo(95)?.icon).toBe("thunder");
    expect(weatherCodeInfo(80)?.text.el).toBe("Ασθενείς μπόρες");
    expect(weatherCodeInfo(42)).toBeNull();
    expect(directionLabel(83, "el")).toBe("Α");
    expect(directionLabel(-10, "en")).toBe("N");
    expect(directionLabel(350, "en")).toBe("N");
    expect([0.5, 1, 5.9, 6, 11.9, 12, 61.9, 117.9, 118].map(beaufort)).toEqual([0, 1, 1, 2, 2, 3, 7, 11, 12]);
  });

  it("gives the 3-hour pressure tendency in Met Office terms", () => {
    const now = Date.parse("2026-10-16T15:00:00Z");
    const series = (before: number, current: number) => [hour("2026-10-16T12:00:00Z", { pressureHpa: before }), hour("2026-10-16T15:00:00Z", { pressureHpa: current })];
    expect(pressureTendency(series(1017.7, 1014.3), now)).toEqual({ changeHpa: -3.4, tendency: "falling", rate: "moderately" });
    expect(pressureTendency(series(1010, 1010.05), now)?.tendency).toBe("steady");
    expect(pressureTendency(series(1010, 1011), now)).toMatchObject({ tendency: "rising", rate: "slowly" });
    expect(pressureTendency(series(1010, 1016.5), now)?.rate).toBe("very_rapidly");
    // No value within 45 minutes of three hours ago: no tendency.
    expect(pressureTendency([hour("2026-10-16T15:00:00Z", { pressureHpa: 1014 })], now)).toBeNull();
  });

  it("bands the air-quality, UV and instability values", () => {
    expect([0, 19.9, 20, 45, 79, 80, 101].map((value) => aqiLevel(value)?.level)).toEqual([0, 0, 1, 2, 3, 4, 5]);
    expect(aqiLevel(null)).toBeNull();
    expect([2.4, 2.6, 7.4, 11].map((value) => uvLevel(value)?.text.en)).toEqual(["Low", "Moderate", "High", "Extreme"]);
    expect(capeLevel(1200)?.text.en).toBe("Strong");
    expect(liftedIndexLevel(-3)?.text.en).toBe("Unstable");
    expect(liftedIndexLevel(7)?.tone).toBe("good");
  });

  it("merges consecutive storm hours and finds the nearest observed storm by its edge", () => {
    const hours = [
      hour("2026-10-16T18:00:00Z", { weatherCode: 95 }),
      hour("2026-10-16T19:00:00Z", { capeJkg: 400, precipitationMm: 1 }),
      hour("2026-10-16T20:00:00Z", { capeJkg: 400, precipitationMm: 0 }),
      hour("2026-10-16T23:00:00Z", { capeJkg: 150, precipitationMm: 0.4 }),
    ];
    expect(isStormHour(hours[1])).toBe(true);
    expect(isStormHour(hours[2])).toBe(false);
    expect(stormPeriods(hours, Date.parse("2026-10-16T17:00:00Z"))).toEqual([
      { start: "2026-10-16T18:00:00Z", end: "2026-10-16T19:00:00Z", thunder: true },
      { start: "2026-10-16T23:00:00Z", end: "2026-10-16T23:00:00Z", thunder: false },
    ]);
    const cluster = (id: string, latitude: number, radiusKm: number) => ({ id, centroid: { latitude, longitude: 22.43 }, radiusKm }) as LightningCluster;
    // 1° of latitude ≈ 111 km; the near storm's edge is 111 − 30 = 81 km away.
    const nearest = nearestLightning({ latitude: 37, longitude: 22.43 }, [cluster("far", 39, 20), cluster("near", 38, 30)]);
    expect(nearest?.cluster.id).toBe("near");
    expect(nearest?.distanceKm).toBeCloseTo(81, 0);
    expect(nearest?.centerKm).toBeCloseTo(111, 0);
    // Inside a storm's circle the edge distance is 0, the centre's is kept.
    const inside = nearestLightning({ latitude: 37.9, longitude: 22.43 }, [cluster("near", 38, 30)]);
    expect(inside?.distanceKm).toBe(0);
    expect(inside?.centerKm).toBeCloseTo(11, 0);
    expect(nearest?.bearingDeg).toBeCloseTo(0, 0);
    expect(nearestLightning({ latitude: 37, longitude: 22.43 }, [])).toBeNull();
  });

  it("judges a night by its dew, wind, cold, cloud and haze", () => {
    const start = Date.parse("2026-10-16T17:00:00Z");
    const night = [
      hour("2026-10-16T18:00:00Z", { temperatureC: 6, dewPointC: 5.2, windGustsKmh: 18, cloudCover: 10, cloudCoverHigh: 5, relativeHumidity: 94 }),
      hour("2026-10-16T22:00:00Z", { temperatureC: 4, dewPointC: 1, windGustsKmh: 31, cloudCover: 30, cloudCoverHigh: 20 }),
      // Outside the window: ignored.
      hour("2026-10-17T09:00:00Z", { temperatureC: -5, windGustsKmh: 80, cloudCover: 100 }),
    ];
    const air = [{ time: "2026-10-16T20:00:00Z", aerosolOpticalDepth: 0.12, dust: 3 }] as AirQualityConditions[];
    const outlook = nightOutlook(night, air, start, start + 12 * 3_600_000);
    expect(outlook).toMatchObject({
      hours: 2, cloudMean: 20, dewSpreadMin: 0.8, gustMax: 31, temperatureMin: 4, aerosolOpticalDepthMean: 0.12,
      sky: "good", dew: "bad", wind: "fair", cold: "fair", transparency: "good",
    });
    expect(nightOutlook([], [], start, start + 1).sky).toBeNull();
  });
});

// Reference values for Sparta (37.075 N, 22.43 E) from Astronomy Engine 2.1.19.
const SPARTA = { latitude: 37.075, longitude: 22.43 };
const near = (actual: Date | null | undefined, expected: string, minutes: number) => {
  expect(actual).toBeInstanceOf(Date);
  expect(Math.abs(actual!.getTime() - Date.parse(expected)) / 60_000).toBeLessThan(minutes);
};

describe("sun and moon calendar", () => {
  it("gives sunrise, sunset and the three twilights of an Athens day", () => {
    const day = sunDay(new Date("2026-10-16T09:00:00Z"), SPARTA.latitude, SPARTA.longitude);
    near(day.sunrise, "2026-10-16T04:38:47Z", 1);
    near(day.sunset, "2026-10-16T15:52:24Z", 1);
    near(day.civilDawn, "2026-10-16T04:12:35Z", 1);
    near(day.civilDusk, "2026-10-16T16:18:35Z", 1);
    near(day.nauticalDusk, "2026-10-16T16:48:45Z", 1);
    near(day.astronomicalDawn, "2026-10-16T03:12:16Z", 1);
    near(day.astronomicalDusk, "2026-10-16T17:18:48Z", 1);
    // 11 h 13 min 37 s between them.
    expect(Math.abs(day.dayLengthMinutes! - 673.6)).toBeLessThanOrEqual(1);
    // Just after local midnight (21:30 UTC the evening before) it is already the next Athens day.
    near(sunDay(new Date("2026-10-15T21:30:00Z"), SPARTA.latitude, SPARTA.longitude).sunrise, "2026-10-16T04:38:47Z", 2);
  });

  it("finds the next principal Moon phases", () => {
    const quarters = nextMoonQuarters(new Date("2026-10-16T00:00:00Z"), 4);
    expect(quarters.map((quarter) => quarter.quarter)).toEqual(["first_quarter", "full", "last_quarter", "new"]);
    near(quarters[0].at, "2026-10-18T16:13:19Z", 10);
    near(quarters[1].at, "2026-10-26T04:12:16Z", 10);
    near(quarters[2].at, "2026-11-01T20:28:59Z", 10);
    near(quarters[3].at, "2026-11-09T07:02:42Z", 10);
  });

  it("names the Moon's phase and gives its rise and set", () => {
    const moon = moonDay(new Date("2026-10-16T12:00:00Z"), SPARTA.latitude, SPARTA.longitude);
    expect(moon.name).toBe("waxing_crescent");
    expect(moon.fraction).toBeCloseTo(0.301, 2);
    near(moon.rise, "2026-10-16T10:19:11Z", 3);
    near(moon.set, "2026-10-16T19:30:00Z", 3);
    expect(moonPhaseName(0.5)).toBe("full");
    expect(moonPhaseName(0.99)).toBe("new");
    expect(moonPhaseName(0.7)).toBe("waning_gibbous");
  });

  it("plans the coming night, or the current one before dawn", () => {
    const evening = nightWindow(new Date("2026-10-16T12:00:00Z"), SPARTA.latitude, SPARTA.longitude)!;
    near(evening.start, "2026-10-16T16:18:35Z", 1);
    near(evening.end, "2026-10-17T04:13:29Z", 1);
    near(evening.astronomicalEnd, "2026-10-17T03:13:09Z", 1);
    // 595 dark minutes, 465 of them with the Moon down (it sets at 19:30 UTC).
    expect(Math.abs(evening.darkMinutes - 595)).toBeLessThanOrEqual(10);
    expect(Math.abs(evening.moonlessDarkMinutes - 465)).toBeLessThanOrEqual(10);
    expect(evening.moonEvents.map((event) => event.kind)).toEqual(["set"]);
    near(evening.moonEvents[0].at, "2026-10-16T19:30:00Z", 3);
    const beforeDawn = nightWindow(new Date("2026-10-17T02:00:00Z"), SPARTA.latitude, SPARTA.longitude)!;
    expect(beforeDawn.start.getTime()).toBe(evening.start.getTime());
  });

  it("bands the Sun's altitude into day and twilights", () => {
    expect([5, -0.5, -3, -9, -15, -20].map(twilightBand)).toEqual(["day", "day", "civil", "nautical", "astronomical", "night"]);
  });
});

describe("Athens calendar days", () => {
  it("finds the start and end of an Athens day, 25 or 23 hours long when the clocks change", () => {
    expect(athensDayBounds(new Date("2026-10-22T09:00:00Z"))).toEqual({ start: new Date("2026-10-21T21:00:00Z"), end: new Date("2026-10-22T21:00:00Z") });
    // Clocks go back at 04:00 on 25 Oct 2026: that day runs from 21:00 to 22:00 UTC.
    expect(athensDayBounds(new Date("2026-10-25T10:00:00Z"))).toEqual({ start: new Date("2026-10-24T21:00:00Z"), end: new Date("2026-10-25T22:00:00Z") });
    // Clocks go forward at 03:00 on 28 Mar 2027: a 23-hour day.
    expect(athensDayBounds(new Date("2027-03-28T10:00:00Z"))).toEqual({ start: new Date("2027-03-27T22:00:00Z"), end: new Date("2027-03-28T21:00:00Z") });
  });

  it("steps whole calendar days, also across a clock change", () => {
    // Sat 27 Mar 2027 23:30 EET: 24 hours later is already Monday, the next day is Sunday.
    expect(athensNoon(new Date("2027-03-27T21:30:00Z"), 1).toISOString()).toBe("2027-03-28T09:00:00.000Z");
    // Mon 29 Mar 00:30 EEST: the day before is Sunday.
    expect(athensNoon(new Date("2027-03-28T21:30:00Z"), -1).toISOString()).toBe("2027-03-28T09:00:00.000Z");
    expect(athensNoon(new Date("2026-10-22T09:00:00Z")).toISOString()).toBe("2026-10-22T09:00:00.000Z");
  });

  it("counts calendar days between two instants, not 24-hour spans", () => {
    expect(athensDayDifference(new Date("2026-10-22T19:00:00Z"), new Date("2026-10-24T05:00:00Z"))).toBe(2); // Thu 22:00 → Sat 08:00
    expect(athensDayDifference(new Date("2026-10-22T23:00:00Z"), new Date("2026-10-23T19:00:00Z"))).toBe(0); // Fri 02:00 → Fri 22:00
    expect(athensDayDifference(new Date("2026-10-22T19:00:00Z"), new Date("2026-10-26T04:11:00Z"))).toBe(4); // Thu → Mon
    expect(athensDayDifference(new Date("2026-10-24T20:30:00Z"), new Date("2026-10-25T21:30:00Z"))).toBe(1); // Sat → Sun, clocks back between
    expect(athensDayDifference(new Date("2026-10-23T09:00:00Z"), new Date("2026-10-22T09:00:00Z"))).toBe(-1);
  });
});

describe("sky events that span days", () => {
  it("plans a single night across the spring clock change", () => {
    // Astronomy Engine: civil dusk Sat 27 Mar 2027 17:14:02 UTC, civil dawn Sun 28 Mar 03:56:33 UTC.
    const saturday = nightWindow(new Date("2027-03-27T21:30:00Z"), SPARTA.latitude, SPARTA.longitude)!;
    near(saturday.start, "2027-03-27T17:14:02Z", 1);
    near(saturday.end, "2027-03-28T03:56:33Z", 1);
    // Mon 29 Mar 00:30 EEST, before dawn: the night that began on Sunday (17:14:57 → 03:55:03 UTC).
    const sunday = nightWindow(new Date("2027-03-28T21:30:00Z"), SPARTA.latitude, SPARTA.longitude)!;
    near(sunday.start, "2027-03-28T17:14:57Z", 1);
    near(sunday.end, "2027-03-29T03:55:03Z", 1);
  });

  it("gives the next moonrise and moonset, not the day's past ones", () => {
    // Astronomy Engine, from Thu 22 Oct 2026 09:13 Athens: rise 13:39:28 UTC, set Fri 01:36:28 UTC.
    const morning = nextMoonRiseSet(new Date("2026-10-22T06:13:00Z"), SPARTA.latitude, SPARTA.longitude);
    near(morning.rise, "2026-10-22T13:39:28Z", 3);
    near(morning.set, "2026-10-23T01:36:28Z", 3);
    // From 23:00 Athens the same day: set 01:36:28 UTC, next rise Fri 14:04:11 UTC.
    const evening = nextMoonRiseSet(new Date("2026-10-22T20:00:00Z"), SPARTA.latitude, SPARTA.longitude);
    near(evening.rise, "2026-10-23T14:04:11Z", 3);
    near(evening.set, "2026-10-23T01:36:28Z", 3);
  });
});

describe("rain by the hour", () => {
  // Open-Meteo stamps each hour's precipitation and probability at the hour's end: 10:00 holds 09:00–10:00.
  const hours = [
    hour("2026-10-22T09:00:00Z", { precipitationMm: 0, precipitationProbability: 5 }),
    hour("2026-10-22T10:00:00Z", { precipitationMm: 0.4, precipitationProbability: 30 }),
    hour("2026-10-22T11:00:00Z", { precipitationMm: 2.5, precipitationProbability: 80 }),
  ];

  it("lines each hour up with the rain that falls after it", () => {
    expect(rainAhead(hours)).toEqual([{ mm: 0.4, chance: 30 }, { mm: 2.5, chance: 80 }, { mm: null, chance: null }]);
  });

  it("reads «rain next hour» from the coming hour, not the one under way", () => {
    expect(rainNextHour(hours, Date.parse("2026-10-22T09:55:00Z"))).toEqual({ mm: 2.5, chance: 80 });
    expect(rainNextHour(hours, Date.parse("2026-10-22T09:05:00Z"))).toEqual({ mm: 0.4, chance: 30 });
    expect(rainNextHour(hours, Date.parse("2026-10-22T10:45:00Z"))).toBeNull();
  });
});

describe("local storm judgement", () => {
  it("rates convective inhibition instead of always calling it a brake", () => {
    expect([0, 43, 120, 300].map((value) => cinLevel(value)?.level)).toEqual([0, 1, 2, 3]);
    expect(cinLevel(0)?.text.en).toBe("No cap: storms start easily");
    expect(cinLevel(null)).toBeNull();
  });

  it("calls an unstable dry atmosphere unstable, not storm-free", () => {
    expect(localStormStatus({ periods: [], lightningKm: null, capeMax: 970, liftedMin: -2.5 })).toBe("unstable");
    expect(localStormStatus({ periods: [], lightningKm: null, capeMax: 970, liftedMin: 1 })).toBe("quiet");
    expect(localStormStatus({ periods: [], lightningKm: null, capeMax: 300, liftedMin: -3 })).toBe("quiet");
    expect(localStormStatus({ periods: [], lightningKm: null, capeMax: null, liftedMin: null })).toBe("quiet");
  });

  it("puts observed lightning before the model, and thunder before rain", () => {
    const thunder = [{ start: "2026-10-22T18:00:00Z", end: "2026-10-22T19:00:00Z", thunder: true }];
    const rain = [{ start: "2026-10-22T18:00:00Z", end: "2026-10-22T18:00:00Z", thunder: false }];
    expect(localStormStatus({ periods: thunder, lightningKm: 12, capeMax: 2000, liftedMin: -5 })).toBe("lightning_close");
    expect(localStormStatus({ periods: thunder, lightningKm: 45, capeMax: 2000, liftedMin: -5 })).toBe("lightning_near");
    expect(localStormStatus({ periods: thunder, lightningKm: 90, capeMax: 2000, liftedMin: -5 })).toBe("thunder");
    expect(localStormStatus({ periods: rain, lightningKm: null, capeMax: 400, liftedMin: -1 })).toBe("rain_unstable");
  });

  it("matches a scan to its own site only", () => {
    expect(isSameSite({ latitude: 37.075, longitude: 22.43 }, { latitude: 37.075, longitude: 22.43 })).toBe(true);
    expect(isSameSite({ latitude: 37.075, longitude: 22.43 }, { latitude: 40.6, longitude: 22.95 })).toBe(false);
    expect(isSameSite({ latitude: 37.075, longitude: 22.43 }, { latitude: 37.0751, longitude: 22.43 })).toBe(false);
  });

  it("names a MeteoAlarm warning by its colour and hazard in both languages", () => {
    expect(alertText({ hazard: "Thunderstorm", level: "yellow" })).toEqual({ level: { el: "Κίτρινη", en: "Yellow" }, hazard: { el: "Καταιγίδα", en: "Thunderstorm" } });
    expect(alertText({ hazard: "High-temperature", level: "orange" })).toEqual({ level: { el: "Πορτοκαλί", en: "Orange" }, hazard: { el: "Υψηλές θερμοκρασίες", en: "High temperature" } });
    // A hazard the app does not know stays as reported; a missing one reads as a plain warning.
    expect(alertText({ hazard: "Dust", level: null })).toEqual({ level: null, hazard: { el: "Dust", en: "Dust" } });
    expect(alertText({ hazard: null, level: "red" }).hazard).toEqual({ el: "Προειδοποίηση", en: "Warning" });
  });
});
