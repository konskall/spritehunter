import * as SunCalc from "suncalc";
import { sunAltitudeDeg } from "@/lib/astronomy";
import { athensNoon, athensUtcOffsetMinutes } from "@/lib/time";

// Sun and Moon events for the weather screen. Days are Athens civil days, as everywhere in the
// app. SunCalc's twilight times are solved on the true altitude, so they need no refraction fix.

export const SYNODIC_MONTH_DAYS = 29.530588;

export interface SunDay {
  sunrise: Date | null;
  sunset: Date | null;
  solarNoon: Date;
  civilDawn: Date | null;
  civilDusk: Date | null;
  nauticalDawn: Date | null;
  nauticalDusk: Date | null;
  astronomicalDawn: Date | null;
  astronomicalDusk: Date | null;
  /** Evening golden hour: from the Sun at 6° until sunset. */
  goldenHour: Date | null;
  dayLengthMinutes: number | null;
}

/** Sun events of the Athens civil day that contains `date`. */
export function sunDay(date: Date, latitude: number, longitude: number): SunDay {
  const times = SunCalc.getTimes(date, latitude, longitude, 0, athensUtcOffsetMinutes(date));
  return {
    sunrise: times.sunrise,
    sunset: times.sunset,
    solarNoon: times.solarNoon,
    civilDawn: times.dawn,
    civilDusk: times.dusk,
    nauticalDawn: times.nauticalDawn,
    nauticalDusk: times.nauticalDusk,
    astronomicalDawn: times.nightEnd,
    astronomicalDusk: times.night,
    goldenHour: times.goldenHour,
    dayLengthMinutes: times.sunrise && times.sunset ? Math.round((times.sunset.getTime() - times.sunrise.getTime()) / 60_000) : null,
  };
}

export type MoonQuarter = "new" | "first_quarter" | "full" | "last_quarter";
export type MoonPhaseName = MoonQuarter | "waxing_crescent" | "waxing_gibbous" | "waning_gibbous" | "waning_crescent";

const QUARTERS: Array<[MoonQuarter, number]> = [["new", 0], ["first_quarter", 0.25], ["full", 0.5], ["last_quarter", 0.75]];
// A principal phase names the 24 hours around its exact instant.
const PRINCIPAL_HALF_WINDOW = 0.5 / SYNODIC_MONTH_DAYS;

/** Signed offset of `phase` from `target` on the 0–1 phase circle, in (−0.5, 0.5]. */
function phaseOffset(phase: number, target: number) {
  const offset = (((phase - target) % 1) + 1) % 1;
  return offset > 0.5 ? offset - 1 : offset;
}

/** SunCalc's phase: the Moon's elongation in ecliptic longitude, 0 new, 0.5 full. */
const moonPhaseAt = (timeMs: number) => SunCalc.getMoonIllumination(new Date(timeMs)).phase;

export function moonPhaseName(phase: number): MoonPhaseName {
  for (const [quarter, target] of QUARTERS) if (Math.abs(phaseOffset(phase, target)) <= PRINCIPAL_HALF_WINDOW) return quarter;
  if (phase < 0.25) return "waxing_crescent";
  if (phase < 0.5) return "waxing_gibbous";
  if (phase < 0.75) return "waning_gibbous";
  return "waning_crescent";
}

/** The next `count` principal phases after `from`, in time order (to within seconds of SunCalc's Moon). */
export function nextMoonQuarters(from: Date, count = 4) {
  const stepMs = 6 * 3_600_000;
  const found: Array<{ quarter: MoonQuarter; at: Date }> = [];
  let startMs = from.getTime();
  let startPhase = moonPhaseAt(startMs);
  // A phase advances ~0.0085 per step, so each quarter is crossed once, from below.
  while (found.length < count) {
    const endMs = startMs + stepMs;
    const endPhase = moonPhaseAt(endMs);
    for (const [quarter, target] of QUARTERS) {
      if (phaseOffset(startPhase, target) < 0 && phaseOffset(endPhase, target) >= 0) {
        let low = startMs;
        let high = endMs;
        for (let iteration = 0; iteration < 24; iteration += 1) {
          const middle = (low + high) / 2;
          if (phaseOffset(moonPhaseAt(middle), target) < 0) low = middle;
          else high = middle;
        }
        found.push({ quarter, at: new Date(Math.round(high)) });
      }
    }
    startMs = endMs;
    startPhase = endPhase;
  }
  return found.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, count);
}

export interface MoonDay {
  phase: number;
  fraction: number;
  waxing: boolean;
  name: MoonPhaseName;
  ageDays: number;
  altitudeDeg: number;
  azimuthDeg: number;
  distanceKm: number;
  rise: Date | null;
  set: Date | null;
  alwaysUp: boolean;
  alwaysDown: boolean;
}

/** The Moon at `date`, with its rise and set in the Athens civil day that contains it. */
export function moonDay(date: Date, latitude: number, longitude: number): MoonDay {
  const illumination = SunCalc.getMoonIllumination(date);
  const position = SunCalc.getMoonPosition(date, latitude, longitude);
  const times = SunCalc.getMoonTimes(date, latitude, longitude, athensUtcOffsetMinutes(date));
  return {
    phase: illumination.phase,
    fraction: illumination.fraction,
    waxing: illumination.waxing,
    name: moonPhaseName(illumination.phase),
    ageDays: illumination.phase * SYNODIC_MONTH_DAYS,
    altitudeDeg: position.altitude,
    azimuthDeg: position.azimuth,
    distanceKm: position.distance,
    rise: times.rise ?? null,
    set: times.set ?? null,
    alwaysUp: Boolean(times.alwaysUp),
    alwaysDown: Boolean(times.alwaysDown),
  };
}

/** The next moonrise and moonset after `now`; a day without one is skipped. */
export function nextMoonRiseSet(now: Date, latitude: number, longitude: number) {
  let rise: Date | null = null;
  let set: Date | null = null;
  for (let day = 0; day <= 2 && (!rise || !set); day += 1) {
    const noon = athensNoon(now, day);
    const times = SunCalc.getMoonTimes(noon, latitude, longitude, athensUtcOffsetMinutes(noon));
    if (!rise && times.rise && times.rise > now) rise = times.rise;
    if (!set && times.set && times.set > now) set = times.set;
  }
  return { rise, set };
}

export interface NightWindow {
  /** Civil dusk to civil dawn: the night worth planning. */
  start: Date;
  end: Date;
  astronomicalStart: Date | null;
  astronomicalEnd: Date | null;
  /** Minutes with the Sun below −18°. */
  darkMinutes: number;
  /** Of those, minutes with the Moon below the horizon too. */
  moonlessDarkMinutes: number;
  /** Moonrises and moonsets inside the window. */
  moonEvents: Array<{ kind: "rise" | "set"; at: Date }>;
}

const SAMPLE_MS = 5 * 60_000;

/** The current night if it is dark now or before dawn, otherwise the coming one. */
export function nightWindow(now: Date, latitude: number, longitude: number): NightWindow | null {
  const today = sunDay(now, latitude, longitude);
  const beforeDawn = today.civilDawn != null && now.getTime() < today.civilDawn.getTime();
  // Calendar steps: ±24 hours lands two days away on the night the clocks go forward.
  const evening = beforeDawn ? sunDay(athensNoon(now, -1), latitude, longitude) : today;
  const morning = beforeDawn ? today : sunDay(athensNoon(now, 1), latitude, longitude);
  const start = evening.civilDusk ?? evening.sunset;
  const end = morning.civilDawn ?? morning.sunrise;
  if (!start || !end || end <= start) return null;

  let darkMinutes = 0;
  let moonlessDarkMinutes = 0;
  for (let time = start.getTime(); time < end.getTime(); time += SAMPLE_MS) {
    const sample = new Date(time + SAMPLE_MS / 2);
    if (sunAltitudeDeg(sample, latitude, longitude) > -18) continue;
    darkMinutes += SAMPLE_MS / 60_000;
    if (SunCalc.getMoonPosition(sample, latitude, longitude).altitude < 0) moonlessDarkMinutes += SAMPLE_MS / 60_000;
  }
  const moonEvents = [start, end]
    .map((day) => SunCalc.getMoonTimes(day, latitude, longitude, athensUtcOffsetMinutes(day)))
    .flatMap((times) => [
      ...(times.rise ? [{ kind: "rise" as const, at: times.rise }] : []),
      ...(times.set ? [{ kind: "set" as const, at: times.set }] : []),
    ])
    .filter((event) => event.at > start && event.at < end)
    .filter((event, index, events) => events.findIndex((other) => other.kind === event.kind && other.at.getTime() === event.at.getTime()) === index)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    start,
    end,
    astronomicalStart: evening.astronomicalDusk,
    astronomicalEnd: morning.astronomicalDawn,
    darkMinutes,
    moonlessDarkMinutes,
    moonEvents,
  };
}

export type TwilightBand = "day" | "civil" | "nautical" | "astronomical" | "night";

export function twilightBand(sunAltitude: number): TwilightBand {
  if (sunAltitude > -0.833) return "day";
  if (sunAltitude > -6) return "civil";
  if (sunAltitude > -12) return "nautical";
  if (sunAltitude > -18) return "astronomical";
  return "night";
}
