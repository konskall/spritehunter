"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { memo, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUp,
  CalendarDays,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudHail,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  CloudSunRain,
  Droplets,
  ExternalLink,
  Eye,
  Factory,
  Flower2,
  Gauge,
  Lightbulb,
  Map as MapIcon,
  MapPin,
  Moon,
  MoonStar,
  Mountain,
  Radio,
  ShieldAlert,
  Snowflake,
  Sun,
  Sunrise,
  Sunset,
  Telescope,
  Thermometer,
  Umbrella,
  Wind,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { AirQualityConditions, OpportunityResponse, PollenType, SavedLocation, StationHour, WeatherStationResponse } from "@/lib/domain";
import type { Language, Localized } from "@/lib/i18n";
import {
  aqiLevel,
  beaufort,
  capeLevel,
  directionLabel,
  isStormHour,
  liftedIndexLevel,
  metarReadings,
  nearestLightning,
  nightOutlook,
  pressureTendency,
  stormPeriods,
  uvLevel,
  valueNear,
  weatherCodeInfo,
  type Level,
  type NightOutlook,
  type WeatherIcon,
} from "@/lib/weather";
import { moonDay, nextMoonQuarters, nightWindow, sunDay, SYNODIC_MONTH_DAYS, twilightBand, type MoonPhaseName, type NightWindow, type TwilightBand } from "@/lib/sky-calendar";
import { sunAltitudeDeg } from "@/lib/astronomy";
import { athensUtcOffsetMinutes } from "@/lib/time";

const TIME_ZONE = "Europe/Athens";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// Hours shown in the charts and in the hour strip.
const CHART_HOURS = 48;
const STRIP_HOURS = 24;
// An MTG-LI storm this close (to its edge) is a lightning risk at the site; up to the second, it is near.
const LIGHTNING_DANGER_KM = 20;
const LIGHTNING_NEAR_KM = 60;

type Text = ReturnType<typeof makeText>;

function makeText(language: Language) {
  const locale = language === "el" ? "el-GR" : "en-GB";
  const clock = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const hour = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23" });
  const weekday = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, weekday: "short" });
  const day = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, weekday: "short", day: "numeric", month: "numeric" });
  const date = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, day: "numeric", month: "numeric" });
  const longDay = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long" });
  const t = (el: string, en: string) => (language === "el" ? el : en);
  return {
    language,
    locale,
    t,
    pick: (text: Localized | null | undefined) => (text ? text[language] : ""),
    clock: (value: Date | string | number | null | undefined) => (value == null ? "—" : clock.format(new Date(value))),
    hourOf: (ms: number) => Number(hour.format(ms)) % 24,
    weekday: (ms: number) => weekday.format(ms),
    day: (value: Date | string | number) => day.format(new Date(value)),
    date: (value: Date | string | number) => date.format(new Date(value)),
    longDay: (value: Date | string | number) => longDay.format(new Date(value)),
    duration: (minutes: number) => `${Math.floor(minutes / 60)} ${t("ώ", "h")} ${String(Math.round(minutes % 60)).padStart(2, "0")}′`,
    inDays: (ms: number) => {
      const days = Math.round(ms / DAY_MS);
      if (ms < 20 * HOUR_MS) return t(`σε ${Math.max(1, Math.round(ms / HOUR_MS))} ώ`, `in ${Math.max(1, Math.round(ms / HOUR_MS))} h`);
      return days === 1 ? t("αύριο", "tomorrow") : t(`σε ${days} ημέρες`, `in ${days} days`);
    },
  };
}

/** `value` to `digits` decimals, "—" when missing; never "-0". */
function num(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return "—";
  const fixed = value.toFixed(digits);
  return /^-0(\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed;
}

const TONE_LABEL: Record<Level["tone"], Localized> = {
  good: { el: "καλό", en: "good" },
  fair: { el: "μέτριο", en: "fair" },
  warn: { el: "προσοχή", en: "caution" },
  bad: { el: "δυσμενές", en: "poor" },
};

const WEATHER_GLYPHS: Record<WeatherIcon, [LucideIcon, LucideIcon]> = {
  clear: [Sun, Moon],
  partly: [CloudSun, CloudMoon],
  overcast: [Cloud, Cloud],
  fog: [CloudFog, CloudFog],
  drizzle: [CloudDrizzle, CloudDrizzle],
  rain: [CloudRain, CloudRain],
  showers: [CloudSunRain, CloudRain],
  snow: [CloudSnow, CloudSnow],
  thunder: [CloudLightning, CloudLightning],
  hail: [CloudHail, CloudHail],
};

function WeatherGlyph({ code, isDay, size = 22 }: { code: number | null; isDay: boolean | null; size?: number }) {
  const info = weatherCodeInfo(code);
  const Icon = info ? WEATHER_GLYPHS[info.icon][isDay === false ? 1 : 0] : Cloud;
  return <Icon size={size} className={`wx-glyph wx-glyph-${info?.icon ?? "unknown"}`} aria-hidden="true" />;
}

/** An arrow pointing where the wind blows to (the reported direction is where it comes from). */
function WindArrow({ from, size = 13 }: { from: number | null; size?: number }) {
  if (from == null) return null;
  return <ArrowUp size={size} className="wx-wind-arrow" style={{ transform: `rotate(${(from + 180) % 360}deg)` }} aria-hidden="true" />;
}

function Stat({ icon: Icon, label, value, hint, tone }: { icon: LucideIcon; label: string; value: ReactNode; hint?: ReactNode; tone?: Level["tone"] | null }) {
  return (
    <div className={`wx-stat${tone ? ` tone-${tone}` : ""}`}>
      <Icon size={16} />
      <div><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>
    </div>
  );
}

function PanelHeading({ eyebrow, title, icon: Icon, aside }: { eyebrow: string; title: string; icon: LucideIcon; aside?: ReactNode }) {
  return <div className="panel-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{aside ?? <Icon size={20} />}</div>;
}

/** The Moon's lit part as seen from the northern hemisphere (mirrored south of the equator). */
function MoonGlyph({ fraction, waxing, size = 64, southern = false }: { fraction: number; waxing: boolean; size?: number; southern?: boolean }) {
  const r = 48;
  const rx = Math.abs(1 - 2 * fraction) * r;
  const limbSweep = waxing ? 1 : 0;
  const terminatorSweep = waxing ? (fraction < 0.5 ? 0 : 1) : (fraction < 0.5 ? 1 : 0);
  const lit = `M 0 ${-r} A ${r} ${r} 0 0 ${limbSweep} 0 ${r} A ${rx.toFixed(2)} ${r} 0 0 ${terminatorSweep} 0 ${-r} Z`;
  return (
    <svg className="wx-moon" width={size} height={size} viewBox="-50 -50 100 100" aria-hidden="true">
      <circle r={r} className="wx-moon-dark" />
      {fraction > 0.005 && <path d={lit} className="wx-moon-lit" transform={southern ? "scale(-1 1)" : undefined} />}
    </svg>
  );
}

const MOON_PHASE_TEXT: Record<MoonPhaseName, Localized> = {
  new: { el: "Νέα Σελήνη", en: "New Moon" },
  waxing_crescent: { el: "Αύξων μηνίσκος", en: "Waxing crescent" },
  first_quarter: { el: "Πρώτο τέταρτο", en: "First quarter" },
  waxing_gibbous: { el: "Αύξουσα αμφίκυρτη", en: "Waxing gibbous" },
  full: { el: "Πανσέληνος", en: "Full Moon" },
  waning_gibbous: { el: "Φθίνουσα αμφίκυρτη", en: "Waning gibbous" },
  last_quarter: { el: "Τελευταίο τέταρτο", en: "Last quarter" },
  waning_crescent: { el: "Φθίνων μηνίσκος", en: "Waning crescent" },
};

const QUARTER_GLYPH = { new: [0, true], first_quarter: [0.5, true], full: [1, true], last_quarter: [0.5, false] } as const;

const POLLEN_TEXT: Record<PollenType, Localized> = {
  alder: { el: "Σκλήθρα", en: "Alder" },
  birch: { el: "Σημύδα", en: "Birch" },
  grass: { el: "Αγρωστώδη", en: "Grass" },
  mugwort: { el: "Αρτεμισία", en: "Mugwort" },
  olive: { el: "Ελιά", en: "Olive" },
  ragweed: { el: "Αμβροσία", en: "Ragweed" },
};

// European Environment Agency colours for the six AQI bands.
const AQI_COLORS = ["#50f0e6", "#50ccaa", "#f0e641", "#ff5050", "#960032", "#7d2181"];

const BAND_FILL: Record<TwilightBand, string | null> = {
  day: "rgba(229,173,85,.075)",
  civil: "rgba(229,173,85,.04)",
  nautical: "rgba(109,184,232,.035)",
  astronomical: null,
  night: null,
};
const BAND_COLOR: Record<TwilightBand, string> = {
  day: "#d9a24e",
  civil: "#a7667a",
  nautical: "#4b6d98",
  astronomical: "#2a4366",
  night: "#0f1d30",
};

interface Axis { min: number; max: number }

/** Axis bounds around `values`, with `fixed` ends kept and at least `minSpan` between them. */
function axisFor(values: number[], fixedMin?: number, fixedMax?: number, minSpan = 1): Axis {
  let min = fixedMin ?? (values.length ? Math.min(...values) : 0);
  let max = fixedMax ?? (values.length ? Math.max(...values) : minSpan);
  if (max - min < minSpan) {
    if (fixedMin != null) max = min + minSpan;
    else if (fixedMax != null) min = max - minSpan;
    else {
      const middle = (min + max) / 2;
      min = middle - minSpan / 2;
      max = middle + minSpan / 2;
    }
  }
  const pad = (max - min) * 0.08;
  return { min: fixedMin ?? Math.floor(min - pad), max: fixedMax ?? Math.ceil(max + pad) };
}

const yOf = (value: number, axis: Axis) => Math.min(100, Math.max(0, 100 - ((value - axis.min) / (axis.max - axis.min)) * 100));
const present = (values: Array<number | null>) => values.filter((value): value is number => value != null);

function linePaths(values: Array<number | null>, axis: Axis) {
  const paths: string[] = [];
  let current = "";
  values.forEach((value, index) => {
    if (value == null) {
      if (current) paths.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${index + 0.5},${yOf(value, axis).toFixed(2)}`;
  });
  if (current) paths.push(current);
  return paths;
}

interface ChartSeries {
  key: string;
  label: string;
  values: Array<number | null>;
  color: string;
  kind: "line" | "bars" | "area";
  unit: string;
  digits?: number;
  dashed?: boolean;
  /** Drawn against the right-hand axis. */
  right?: boolean;
  barColors?: Array<string | null>;
}

interface Hover {
  index: number | null;
  set: (index: number | null) => void;
}

/** Frame shared by the hourly charts: legend at the hovered hour, day/night shading and the time axis. */
function ChartFrame({ title, icon: Icon, times, bands, hover, text, legend, leftTicks, rightTicks, height = 112, children, footer }: {
  title: string; icon: LucideIcon; times: number[]; bands: TwilightBand[]; hover: Hover; text: Text; legend: ReactNode;
  leftTicks: Array<{ y: number; label: string }>; rightTicks?: Array<{ y: number; label: string }>; height?: number; children: ReactNode; footer?: ReactNode;
}) {
  const n = times.length;
  const index = hover.index != null && hover.index < n ? hover.index : 0;
  const select = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    hover.set(Math.max(0, Math.min(n - 1, Math.floor(((event.clientX - rect.left) / rect.width) * n))));
  };
  if (!n) return null;
  return (
    <div className="wx-chart">
      <div className="wx-chart-head">
        <span className="wx-chart-title"><Icon size={14} />{title}</span>
        <span className="wx-chart-time">{hover.index == null ? text.t("τώρα", "now") : `${text.weekday(times[index])} ${text.clock(times[index])}`}</span>
      </div>
      <div className="wx-legend">{legend}</div>
      <div className={`wx-plot-wrap${rightTicks ? " has-right" : ""}`}>
        <div className="wx-ticks left">{leftTicks.map((tick) => <span key={tick.label + tick.y} style={{ top: `${tick.y}%` }}>{tick.label}</span>)}</div>
        <div
          className="wx-plot"
          style={{ height }}
          onPointerMove={select}
          onPointerDown={select}
          onPointerLeave={(event) => { if (event.pointerType === "mouse") hover.set(null); }}
        >
          <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden="true">
            {bands.map((band, i) => BAND_FILL[band] && <rect key={i} x={i} y={0} width={1} height={100} fill={BAND_FILL[band]!} />)}
            {leftTicks.map((tick) => <line key={`g${tick.y}`} x1={0} x2={n} y1={tick.y} y2={tick.y} className="wx-grid" vectorEffect="non-scaling-stroke" />)}
            {times.map((ms, i) => text.hourOf(ms) === 0 && <line key={`d${i}`} x1={i + 0.5} x2={i + 0.5} y1={0} y2={100} className="wx-midnight" vectorEffect="non-scaling-stroke" />)}
            {children}
          </svg>
          {hover.index != null && <i className="wx-cursor" style={{ left: `${((index + 0.5) / n) * 100}%` }} />}
        </div>
        {rightTicks && <div className="wx-ticks right">{rightTicks.map((tick) => <span key={tick.label + tick.y} style={{ top: `${tick.y}%` }}>{tick.label}</span>)}</div>}
      </div>
      <div className={`wx-axis${rightTicks ? " has-right" : ""}`}>
        {times.map((ms, i) => {
          const hour = text.hourOf(ms);
          if (hour % 6 !== 0) return null;
          return <span key={i} className={hour === 0 ? "day" : ""} style={{ left: `${((i + 0.5) / n) * 100}%` }}>{hour === 0 ? text.weekday(ms) : String(hour).padStart(2, "0")}</span>;
        })}
      </div>
      {footer}
    </div>
  );
}

function ticksFor(axis: Axis, format: (value: number) => string) {
  const middle = (axis.min + axis.max) / 2;
  return [axis.max, middle, axis.min].map((value) => ({ y: yOf(value, axis), label: format(value) }));
}

function TimeChart({ title, icon, times, bands, hover, text, series, left, right, leftUnit, rightUnit, height, footer }: {
  title: string; icon: LucideIcon; times: number[]; bands: TwilightBand[]; hover: Hover; text: Text; series: ChartSeries[];
  left: Axis; right?: Axis; leftUnit: string; rightUnit?: string; height?: number; footer?: ReactNode;
}) {
  const index = hover.index != null && hover.index < times.length ? hover.index : 0;
  const axisOf = (item: ChartSeries) => (item.right && right ? right : left);
  const legend = series.map((item) => (
    <span key={item.key}>
      <i className={`wx-swatch ${item.kind}${item.dashed ? " dashed" : ""}`} style={{ "--swatch": item.color } as React.CSSProperties} />
      {item.label} <strong>{num(item.values[index], item.digits ?? 0)}{item.values[index] != null ? item.unit : ""}</strong>
    </span>
  ));
  const decimals = (axis: Axis) => (axis.max - axis.min < 3 ? 1 : 0);
  return (
    <ChartFrame
      title={title}
      icon={icon}
      times={times}
      bands={bands}
      hover={hover}
      text={text}
      legend={legend}
      height={height}
      footer={footer}
      leftTicks={ticksFor(left, (value) => `${num(value, decimals(left))}${leftUnit}`)}
      rightTicks={right ? ticksFor(right, (value) => `${num(value, decimals(right))}${rightUnit ?? ""}`) : undefined}
    >
      {series.map((item) => {
        const axis = axisOf(item);
        if (item.kind === "bars") {
          return <g key={item.key}>{item.values.map((value, i) => {
            if (value == null || value <= axis.min) return null;
            const y = yOf(value, axis);
            return <rect key={i} x={i + 0.16} width={0.68} y={y} height={100 - y} fill={item.barColors?.[i] ?? item.color} />;
          })}</g>;
        }
        if (item.kind === "area") {
          return <g key={item.key}>{linePaths(item.values, axis).map((path, i) => {
            const points = path.slice(1).split("L");
            const first = points[0].split(",")[0];
            const last = points.at(-1)!.split(",")[0];
            return <path key={i} d={`M${first},100 L${points.join(" L")} L${last},100 Z`} fill={item.color} fillOpacity={0.16} stroke="none" />;
          })}</g>;
        }
        return <g key={item.key}>{linePaths(item.values, axis).map((path, i) => (
          <path key={i} d={path} fill="none" stroke={item.color} strokeWidth={2} strokeDasharray={item.dashed ? "4 3" : undefined} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        ))}</g>;
      })}
    </ChartFrame>
  );
}

/** Cloud per layer (and the median of the forecasts, when the scan has it) as shaded rows. */
function CloudStrip({ times, bands, hover, text, rows }: { times: number[]; bands: TwilightBand[]; hover: Hover; text: Text; rows: Array<{ label: string; values: Array<number | null> }> }) {
  const index = hover.index != null && hover.index < times.length ? hover.index : 0;
  const rowHeight = 100 / rows.length;
  return (
    <ChartFrame
      title={text.t("Νέφωση ανά στρώμα", "Cloud by layer")}
      icon={Cloud}
      times={times}
      bands={bands}
      hover={hover}
      text={text}
      height={rows.length * 22}
      legend={rows.map((row) => <span key={row.label}>{row.label} <strong>{num(row.values[index])}{row.values[index] != null ? "%" : ""}</strong></span>)}
      leftTicks={rows.map((row, i) => ({ y: (i + 0.5) * rowHeight, label: row.label }))}
    >
      {rows.map((row, r) => row.values.map((value, i) => value != null && value > 0 && (
        <rect key={`${r}:${i}`} x={i} y={r * rowHeight + 1} width={1.02} height={rowHeight - 2} fill="#cfe3f2" fillOpacity={Math.min(0.9, (value / 100) * 0.9)} />
      )))}
    </ChartFrame>
  );
}

function useClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Loads the station data; the parent remounts this view (by `key`) when the site changes. */
function useWeatherStation(latitude: number, longitude: number, refreshKey: number | null) {
  const [state, setState] = useState<{ data: WeatherStationResponse | null; loading: boolean; error: Localized | null }>({ data: null, loading: true, error: null });
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    const load = async (): Promise<WeatherStationResponse> => {
      const params = new URLSearchParams({ lat: String(latitude), lon: String(longitude) });
      let response: Response | null = null;
      try {
        response = await fetch(`/api/weather?${params}`, { signal: controller.signal, cache: "no-store" });
      } catch (error) {
        if (controller.signal.aborted) throw error;
      }
      if (response && response.status < 500) {
        const payload = (await response.json()) as WeatherStationResponse & { error?: Localized };
        if (!response.ok) throw Object.assign(new Error(payload.error?.en ?? `HTTP ${response.status}`), { text: payload.error });
        return payload;
      }
      // The server did not answer: Open-Meteo also accepts requests from the browser.
      const { fetchWeatherStation } = await import("@/lib/providers/weather-station");
      return fetchWeatherStation({ latitude, longitude });
    };
    load()
      .then((data) => { if (!controller.signal.aborted) setState({ data, loading: false, error: null }); })
      .catch((error: Error & { text?: Localized }) => {
        if (controller.signal.aborted) return;
        setState((current) => ({ data: current.data, loading: false, error: error.text ?? { el: `Ο καιρός δεν φορτώθηκε (${error.message}).`, en: `The weather did not load (${error.message}).` } }));
      });
    return () => controller.abort();
  }, [latitude, longitude, refreshKey]);
  return state;
}

export interface WeatherViewProps {
  language: Language;
  observer: SavedLocation;
  /** The opportunity scan: METAR/TAF, MeteoAlarm, MTG-LI and the cloud forecasts come from it. */
  scan: OpportunityResponse | null;
  /** Changes when the scan is refreshed, so this view reloads with it. */
  refreshKey: number | null;
  onMap: () => void;
  onLocations: () => void;
}

export default function WeatherView({ language, observer, scan, refreshKey, onMap, onLocations }: WeatherViewProps) {
  const text = useMemo(() => makeText(language), [language]);
  const { t, pick } = text;
  const now = useClock();
  const { data, loading, error } = useWeatherStation(observer.latitude, observer.longitude, refreshKey);
  const { latitude, longitude } = observer;

  const hours = useMemo(() => data?.hours ?? [], [data]);
  const upcoming = useMemo(() => hours.filter((hour) => Date.parse(hour.time) >= now - 30 * 60_000).slice(0, CHART_HOURS), [hours, now]);
  const strip = useMemo(() => upcoming.slice(0, STRIP_HOURS), [upcoming]);
  const times = useMemo(() => upcoming.map((hour) => Date.parse(hour.time)), [upcoming]);
  const bands = useMemo(() => times.map((ms) => twilightBand(sunAltitudeDeg(new Date(ms), latitude, longitude))), [times, latitude, longitude]);
  // Recomputed with the minute clock, not on every pointer move over the charts.
  const sky = useMemo(() => {
    const date = new Date(now);
    return {
      sun: sunDay(date, latitude, longitude),
      sunTomorrow: sunDay(new Date(now + DAY_MS), latitude, longitude),
      moon: moonDay(date, latitude, longitude),
      quarters: nextMoonQuarters(date, 4),
      night: nightWindow(date, latitude, longitude),
    };
  }, [now, latitude, longitude]);
  const air = data?.airQuality;
  // Once the night has begun, only the hours still ahead count.
  const nightInProgress = sky.night != null && now > sky.night.start.getTime();
  const outlook = useMemo(() => {
    if (!sky.night || !data) return null;
    const start = Math.max(sky.night.start.getTime(), now - 30 * 60_000);
    return nightOutlook(data.hours, data.airQuality.hours, start, sky.night.end.getTime());
  }, [sky.night, data, now]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const hover: Hover = { index: hoverIndex, set: setHoverIndex };

  const updated = data ? text.clock(data.retrievedAt) : null;
  return (
    <div className="view-stack weather-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">WEATHER STATION · OPEN-METEO · CAMS · METAR</span>
          <h1>{t("Μετεωρολογικός σταθμός", "Weather station")}</h1>
          <p>{t(`Καιρός, πρόγνωση, ουρανός και αέρας για τη θέση ${observer.name}.`, `Weather, forecast, sky and air for ${observer.name}.`)}{updated && ` ${t("Ενημέρωση", "Updated")} ${updated}.`}</p>
        </div>
        <CloudSun size={31} />
      </div>
      {error && <div className="inline-error"><AlertTriangle size={17} />{pick(error)}</div>}
      {!data ? (
        loading && <div className="empty-state"><Radio size={22} /><div><strong>{t("Ανάκτηση καιρού…", "Fetching the weather…")}</strong><p>{t("Πρόγνωση Open-Meteo και ποιότητα αέρα CAMS για τη θέση σου.", "Open-Meteo forecast and CAMS air quality for your site.")}</p></div></div>
      ) : (
        <div className="weather-grid">
          <NowPanel data={data} observer={observer} now={now} text={text} />
          <ObservedPanel scan={scan} model={data} now={now} text={text} />
          <section className="panel wx-span-all">
            <PanelHeading eyebrow={t("ΕΠΟΜΕΝΕΣ 48 ΩΡΕΣ", "NEXT 48 HOURS")} title={t("Ωριαία πρόγνωση", "Hourly forecast")} icon={CalendarDays} />
            <HourStrip hours={strip} text={text} />
            <HourlyCharts hours={upcoming} times={times} bands={bands} scan={scan} hover={hover} text={text} />
          </section>
          <DaysPanel data={data} observer={observer} text={text} />
          <TonightPanel night={sky.night} outlook={outlook} inProgress={nightInProgress} moon={sky.moon} text={text} />
          <StormPanel hours={hours} times={times} upcoming={upcoming} bands={bands} scan={scan} observer={observer} now={now} hover={hover} text={text} onMap={onMap} />
          <div className="wx-side">
            <MoonPanel moon={sky.moon} quarters={sky.quarters} now={now} southern={latitude < 0} text={text} />
            <LightPanel observer={observer} text={text} onLocations={onLocations} />
          </div>
          <AirPanel air={air ?? null} now={now} latitude={latitude} longitude={longitude} hover={hover} text={text} />
          <SunPanel sun={sky.sun} tomorrow={sky.sunTomorrow} now={now} text={text} latitude={latitude} longitude={longitude} />
          <p className="data-note wx-span-all"><ShieldAlert size={15} />{t(
            "Πηγές: Open-Meteo (συνδυασμός των καταλληλότερων μοντέλων για τη θέση), CAMS/Copernicus μέσω Open-Meteo, AviationWeather.gov (METAR/TAF), MeteoAlarm, EUMETSAT MTG-LI και αστρονομικοί υπολογισμοί SunCalc. Οι ώρες είναι ώρα Ελλάδας. Τα δεδομένα που λείπουν εμφανίζονται ως «—», ποτέ ως μηδέν.",
            "Sources: Open-Meteo (the best models for the location, combined), CAMS/Copernicus via Open-Meteo, AviationWeather.gov (METAR/TAF), MeteoAlarm, EUMETSAT MTG-LI and SunCalc astronomy. Times are Greek time. Missing data shows as “—”, never as zero.",
          )}</p>
        </div>
      )}
    </div>
  );
}

const PRESSURE_TEXT = {
  steady: { el: "σταθερή", en: "steady" },
  rising: { el: "ανοδική", en: "rising" },
  falling: { el: "πτωτική", en: "falling" },
} as const;
const RATE_TEXT = {
  slowly: { el: "αργά", en: "slowly" },
  moderately: { el: "", en: "" },
  quickly: { el: "γρήγορα", en: "quickly" },
  very_rapidly: { el: "πολύ γρήγορα", en: "very rapidly" },
} as const;

const NowPanel = memo(function NowPanel({ data, observer, now, text }: { data: WeatherStationResponse; observer: SavedLocation; now: number; text: Text }) {
  const { t, pick } = text;
  const current = data.current;
  const hour = data.hours.find((item) => Math.abs(Date.parse(item.time) - now) <= 30 * 60_000) ?? null;
  const nextHour = data.hours.find((item) => Date.parse(item.time) > now) ?? null;
  const today = data.days[0] ?? null;
  const tendency = pressureTendency(data.hours, now);
  const info = weatherCodeInfo(current?.weatherCode ?? null);
  const uv = uvLevel(current?.uvIndex ?? null);
  const spread = current?.temperatureC != null && current.dewPointC != null ? current.temperatureC - current.dewPointC : null;
  const elevationGap = data.modelElevationM != null && observer.elevationM != null ? observer.elevationM - data.modelElevationM : null;
  const tendencyText = tendency
    ? `${tendency.changeHpa > 0 ? "+" : ""}${num(tendency.changeHpa, 1)} hPa/3${t("ώ", "h")} · ${pick(PRESSURE_TEXT[tendency.tendency])}${tendency.tendency !== "steady" && RATE_TEXT[tendency.rate].el ? ` ${pick(RATE_TEXT[tendency.rate])}` : ""}`
    : undefined;
  return (
    <section className="panel wx-now wx-span-2">
      <PanelHeading eyebrow={t("ΤΩΡΑ · ΜΟΝΤΕΛΟ OPEN-METEO", "NOW · OPEN-METEO MODEL")} title={t("Συνθήκες στη θέση σου", "Conditions at your site")} icon={Thermometer} aside={current && <span className="count-badge">{text.clock(current.time)}</span>} />
      <div className="wx-now-main">
        <WeatherGlyph code={current?.weatherCode ?? null} isDay={current?.isDay ?? null} size={58} />
        <div>
          <strong className="wx-temp">{num(current?.temperatureC, 1)}°</strong>
          <span className="wx-desc">{info ? pick(info.text) : "—"}</span>
          <small>{t("Αισθητή", "Feels like")} {num(current?.apparentTemperatureC, 1)}° · {t("σήμερα", "today")} {num(today?.temperatureMinC, 0)}° / {num(today?.temperatureMaxC, 0)}°</small>
        </div>
      </div>
      <div className="wx-stats">
        <Stat icon={Droplets} label={t("Υγρασία", "Humidity")} value={`${num(current?.relativeHumidity)}%`} hint={`${t("σημείο δρόσου", "dew point")} ${num(current?.dewPointC, 1)}°${spread != null ? ` · Δ ${num(spread, 1)}°` : ""}`} tone={spread != null && spread < 2 ? "warn" : null} />
        <Stat icon={Gauge} label={t("Πίεση (θάλασσας)", "Pressure (sea level)")} value={`${num(current?.pressureHpa, 1)} hPa`} hint={tendencyText} tone={tendency && tendency.changeHpa <= -3.6 ? "warn" : null} />
        <Stat icon={Wind} label={t("Άνεμος", "Wind")}
          value={current?.windSpeedKmh != null && current.windSpeedKmh < 1 ? t("Άπνοια", "Calm") : <>{num(current?.windSpeedKmh)} km/h <WindArrow from={current?.windDirectionDeg ?? null} /></>}
          hint={`${current?.windDirectionDeg != null && (current.windSpeedKmh ?? 0) >= 1 ? `${directionLabel(current.windDirectionDeg, text.language)} · ` : ""}${current?.windSpeedKmh != null ? `${beaufort(current.windSpeedKmh)} Bf · ` : ""}${t("ριπές", "gusts")} ${num(current?.windGustsKmh)} km/h`}
          tone={(current?.windGustsKmh ?? 0) >= 40 ? "warn" : null} />
        <Stat icon={Cloud} label={t("Νέφωση", "Cloud")} value={`${num(current?.cloudCover)}%`} hint={hour ? `${t("χαμ.", "low")} ${num(hour.cloudCoverLow)} · ${t("μεσ.", "mid")} ${num(hour.cloudCoverMid)} · ${t("υψ.", "high")} ${num(hour.cloudCoverHigh)}%` : undefined} />
        <Stat icon={Eye} label={t("Ορατότητα", "Visibility")} value={current?.visibilityM != null ? `${num(current.visibilityM / 1000, current.visibilityM < 10_000 ? 1 : 0)} km` : "—"} hint={t("μοντέλο· δες και το METAR", "model; see the METAR too")} tone={current?.visibilityM != null && current.visibilityM < 5_000 ? "warn" : null} />
        <Stat icon={Umbrella} label={t("Βροχή επόμενη ώρα", "Rain next hour")} value={`${num(nextHour?.precipitationMm, 1)} mm`} hint={`${t("πιθανότητα", "chance")} ${num(nextHour?.precipitationProbability)}% · ${t("σήμερα", "today")} ${num(today?.precipitationMm, 1)} mm`} />
        <Stat icon={Sun} label={t("Δείκτης UV", "UV index")} value={num(current?.uvIndex, 1)} hint={uv ? `${pick(uv.text)} · ${t("μέγιστος σήμερα", "max today")} ${num(today?.uvIndexMax, 1)}` : undefined} tone={uv && uv.level >= 2 ? uv.tone : null} />
        <Stat icon={Snowflake} label={t("Ισόθερμη 0 °C", "Freezing level")} value={hour?.freezingLevelM != null ? `${Math.round(hour.freezingLevelM).toLocaleString(text.locale)} m` : "—"} hint={t("ύψος όπου η θερμοκρασία πέφτει στους 0 °C", "height where the air reaches 0 °C")} />
      </div>
      {elevationGap != null && Math.abs(elevationGap) >= 150 && <p className="data-note"><Mountain size={15} />{t(
        `Το σημείο του μοντέλου είναι στα ${Math.round(data.modelElevationM!)} m και η θέση σου στα ${Math.round(observer.elevationM!)} m: η θερμοκρασία εκεί είναι περίπου ${num(Math.abs(elevationGap) * 0.0065, 1)} °C ${elevationGap > 0 ? "χαμηλότερη" : "υψηλότερη"}.`,
        `The model point is at ${Math.round(data.modelElevationM!)} m and your site at ${Math.round(observer.elevationM!)} m: it is about ${num(Math.abs(elevationGap) * 0.0065, 1)} °C ${elevationGap > 0 ? "colder" : "warmer"} there.`,
      )}</p>}
    </section>
  );
});

const FLIGHT_CATEGORY: Record<string, Localized> = {
  VFR: { el: "VFR · καλή ορατότητα", en: "VFR · good visibility" },
  MVFR: { el: "MVFR · μέτρια", en: "MVFR · marginal" },
  IFR: { el: "IFR · χαμηλή", en: "IFR · low" },
  LIFR: { el: "LIFR · πολύ χαμηλή", en: "LIFR · very low" },
};

const ObservedPanel = memo(function ObservedPanel({ scan, model, now, text }: { scan: OpportunityResponse | null; model: WeatherStationResponse; now: number; text: Text }) {
  const { t, pick } = text;
  const aviation = scan?.aviation;
  const readings = metarReadings(aviation?.rawMetar ?? null);
  const ageMinutes = aviation?.observedAt ? Math.max(0, Math.round((now - Date.parse(aviation.observedAt)) / 60_000)) : null;
  return (
    <section className="panel wx-observed">
      <PanelHeading eyebrow={t("ΠΡΑΓΜΑΤΙΚΗ ΜΕΤΡΗΣΗ · METAR", "OBSERVED · METAR")} title={t("Πλησιέστερο αεροδρόμιο", "Nearest airport")} icon={Radio} aside={aviation && <span className={`status-dot status-${aviation.status}`} aria-hidden="true" />} />
      {!aviation ? (
        <p className="wx-muted">{t("Αναμονή για τη σάρωση…", "Waiting for the scan…")}</p>
      ) : !aviation.stationId ? (
        <p className="wx-muted">{pick(aviation.message)}</p>
      ) : (
        <>
          <p className="wx-station"><strong>{aviation.stationId}</strong>{aviation.stationName && ` · ${aviation.stationName}`} · {aviation.distanceKm} km{ageMinutes != null && ` · ${t(`πριν ${ageMinutes}′`, `${ageMinutes}′ ago`)}`}</p>
          <div className="wx-stats compact">
            <Stat icon={Thermometer} label={t("Θερμοκρασία", "Temperature")} value={readings.temperatureC != null ? `${readings.temperatureC}°` : "—"} hint={`${t("μοντέλο", "model")} ${num(model.current?.temperatureC, 1)}°${readings.dewPointC != null ? ` · ${t("δρόσος", "dew")} ${readings.dewPointC}°` : ""}`} />
            <Stat icon={Gauge} label="QNH" value={readings.pressureHpa != null ? `${num(readings.pressureHpa, readings.pressureHpa % 1 ? 1 : 0)} hPa` : "—"} hint={`${t("μοντέλο", "model")} ${num(model.current?.pressureHpa, 1)} hPa`} />
            <Stat icon={Wind} label={t("Άνεμος", "Wind")}
              value={aviation.windSpeedKmh == null ? "—" : aviation.windSpeedKmh === 0 ? t("Άπνοια", "Calm") : <>{aviation.windSpeedKmh} km/h <WindArrow from={aviation.windDirectionDeg} /></>}
              hint={aviation.windSpeedKmh === 0 ? undefined : aviation.windDirectionDeg != null ? directionLabel(aviation.windDirectionDeg, text.language) : t("μεταβλητός", "variable")} />
            <Stat icon={Eye} label={t("Ορατότητα", "Visibility")} value={aviation.visibilityM != null ? `${aviation.visibilityAtLeast ? "≥" : ""}${num(aviation.visibilityM / 1000, aviation.visibilityM >= 10_000 ? 0 : 1)} km` : "—"} hint={aviation.flightCategory ? pick(FLIGHT_CATEGORY[aviation.flightCategory] ?? { el: aviation.flightCategory, en: aviation.flightCategory }) : undefined} />
          </div>
          <p className="wx-sky-line"><Cloud size={14} />{aviation.cloudSummary ? pick(aviation.cloudSummary) : t("Χωρίς αναφορά νέφωσης", "No cloud report")}{aviation.weather && ` · ${aviation.weather}`}</p>
          {aviation.rawMetar && <code className="wx-raw" title={t("Το αυτούσιο δελτίο METAR", "The raw METAR report")}>{aviation.rawMetar}</code>}
          {aviation.rawTaf && <details className="wx-taf"><summary>{t("Πρόγνωση αεροδρομίου (TAF)", "Airport forecast (TAF)")}</summary><code className="wx-raw">{aviation.rawTaf}</code></details>}
          {aviation.status === "stale" && <p className="data-note"><AlertTriangle size={15} />{t("Η τελευταία αναφορά είναι παλιά· δες την ώρα της.", "The latest report is old; check its time.")}</p>}
        </>
      )}
    </section>
  );
});

const HourStrip = memo(function HourStrip({ hours, text }: { hours: StationHour[]; text: Text }) {
  const { t } = text;
  return (
    <div className="wx-hour-strip" role="list" aria-label={t("Επόμενες 24 ώρες", "Next 24 hours")}>
      {hours.map((hour) => (
        <div key={hour.time} role="listitem" className={`wx-hour${hour.isDay === false ? " night" : ""}${isStormHour(hour) ? " storm" : ""}`}>
          <span>{text.clock(hour.time)}</span>
          <WeatherGlyph code={hour.weatherCode} isDay={hour.isDay} size={22} />
          <strong>{num(hour.temperatureC)}°</strong>
          <small className="wx-rain"><Umbrella size={11} />{num(hour.precipitationProbability)}%</small>
          <small><WindArrow from={hour.windDirectionDeg} size={11} />{num(hour.windSpeedKmh)}</small>
          <small className="wx-cloud-cell"><Cloud size={11} />{num(hour.cloudCover)}%</small>
        </div>
      ))}
    </div>
  );
});

function HourlyCharts({ hours, times, bands, scan, hover, text }: { hours: StationHour[]; times: number[]; bands: TwilightBand[]; scan: OpportunityResponse | null; hover: Hover; text: Text }) {
  const { t } = text;
  const column = <K extends keyof StationHour>(key: K) => hours.map((hour) => hour[key] as number | null);
  const temperature = column("temperatureC");
  const dewPoint = column("dewPointC");
  const apparent = column("apparentTemperatureC");
  const rain = column("precipitationMm");
  const chance = column("precipitationProbability");
  const wind = column("windSpeedKmh");
  const gusts = column("windGustsKmh");
  const pressure = column("pressureHpa");
  const visibility = hours.map((hour) => (hour.visibilityM == null ? null : hour.visibilityM / 1000));
  // The scan's median of up to three cloud forecasts, matched by hour.
  const consensusByTime = new Map((scan?.observerForecast ?? []).map((hour) => [Date.parse(hour.time), hour.cloudConsensus ?? null]));
  const consensus = times.map((ms) => consensusByTime.get(ms) ?? null);
  const sourceCount = (scan?.observerForecast ?? []).some((hour) => hour.cloudSources && Object.values(hour.cloudSources).filter((value) => value != null).length >= 2);
  const shared = { times, bands, hover, text };
  return (
    <div className="wx-charts">
      <TimeChart {...shared} title={t("Θερμοκρασία", "Temperature")} icon={Thermometer} leftUnit="°" left={axisFor(present([...temperature, ...dewPoint, ...apparent]), undefined, undefined, 6)}
        series={[
          { key: "t", label: t("Θερμοκρασία", "Temperature"), values: temperature, color: "#ffa25e", kind: "line", unit: "°", digits: 1 },
          { key: "a", label: t("Αισθητή", "Feels like"), values: apparent, color: "#c7a6ff", kind: "line", unit: "°", digits: 1, dashed: true },
          { key: "d", label: t("Σημείο δρόσου", "Dew point"), values: dewPoint, color: "#6db8e8", kind: "line", unit: "°", digits: 1 },
        ]}
        footer={<p className="wx-chart-note">{t("Όπου η θερμοκρασία πλησιάζει το σημείο δρόσου (κάτω από ~2 °C), ο φακός θολώνει από υγρασία.", "Where the temperature nears the dew point (within ~2 °C), dew forms on the lens.")}</p>}
      />
      <TimeChart {...shared} title={t("Βροχή", "Rain")} icon={Umbrella} leftUnit=" mm" rightUnit="%" left={axisFor(present(rain), 0, undefined, 1)} right={{ min: 0, max: 100 }}
        series={[
          { key: "p", label: t("Πιθανότητα", "Chance"), values: chance, color: "#6db8e8", kind: "area", unit: "%", right: true },
          { key: "r", label: t("Ύψος", "Amount"), values: rain, color: "#5aa9ff", kind: "bars", unit: " mm", digits: 1 },
        ]}
      />
      <TimeChart {...shared} title={t("Άνεμος", "Wind")} icon={Wind} leftUnit="" left={axisFor(present([...wind, ...gusts]), 0, undefined, 20)}
        series={[
          { key: "w", label: t("Μέση ταχύτητα", "Speed"), values: wind, color: "#7de4ca", kind: "line", unit: " km/h" },
          { key: "g", label: t("Ριπές", "Gusts"), values: gusts, color: "#e5ad55", kind: "line", unit: " km/h", dashed: true },
        ]}
        footer={<div className="wx-arrow-row">{hours.map((hour, i) => i % 3 === 0 && <span key={hour.time} style={{ left: `${((i + 0.5) / hours.length) * 100}%` }}><WindArrow from={hour.windDirectionDeg} size={12} /></span>)}</div>}
      />
      <CloudStrip {...shared} rows={[
        { label: t("Υψηλά", "High"), values: column("cloudCoverHigh") },
        { label: t("Μέσα", "Mid"), values: column("cloudCoverMid") },
        { label: t("Χαμηλά", "Low"), values: column("cloudCoverLow") },
        ...(sourceCount ? [{ label: t("3 πηγές", "3 sources"), values: consensus }] : []),
      ]} />
      <TimeChart {...shared} title={t("Ατμοσφαιρική πίεση", "Pressure")} icon={Gauge} leftUnit="" left={axisFor(present(pressure), undefined, undefined, 6)}
        series={[{ key: "p", label: t("Πίεση θάλασσας", "Sea-level pressure"), values: pressure, color: "#c7a6ff", kind: "line", unit: " hPa", digits: 1 }]}
      />
      <TimeChart {...shared} title={t("Ορατότητα", "Visibility")} icon={Eye} leftUnit=" km" left={axisFor(present(visibility), 0, undefined, 10)}
        series={[{ key: "v", label: t("Ορατότητα", "Visibility"), values: visibility, color: "#9fd6ff", kind: "line", unit: " km", digits: 1 }]}
      />
    </div>
  );
}

const DaysPanel = memo(function DaysPanel({ data, observer, text }: { data: WeatherStationResponse; observer: SavedLocation; text: Text }) {
  const { t, pick } = text;
  const lows = present(data.days.map((day) => day.temperatureMinC));
  const highs = present(data.days.map((day) => day.temperatureMaxC));
  const floor = lows.length ? Math.min(...lows) : 0;
  const ceiling = highs.length ? Math.max(...highs) : 1;
  const span = Math.max(1, ceiling - floor);
  return (
    <section className="panel wx-span-2">
      <PanelHeading eyebrow={t("7 ΗΜΕΡΕΣ", "7 DAYS")} title={t("Πρόγνωση εβδομάδας", "Week ahead")} icon={CalendarDays} />
      <div className="wx-days">
        {data.days.map((day, index) => {
          // Noon of that day (Athens) for the Sun and Moon of the day.
          const noon = new Date(Date.parse(day.date) + 12 * HOUR_MS);
          const sun = sunDay(noon, observer.latitude, observer.longitude);
          const moon = moonDay(noon, observer.latitude, observer.longitude);
          const info = weatherCodeInfo(day.weatherCode);
          const uv = uvLevel(day.uvIndexMax);
          const low = day.temperatureMinC;
          const high = day.temperatureMaxC;
          return (
            <div key={day.date} className="wx-day">
              <span className="wx-day-name"><strong>{index === 0 ? t("Σήμερα", "Today") : index === 1 ? t("Αύριο", "Tomorrow") : text.weekday(noon.getTime())}</strong><small>{index < 2 ? text.day(noon) : text.date(noon)}</small></span>
              <span className="wx-day-glyph" title={info ? pick(info.text) : undefined}><WeatherGlyph code={day.weatherCode} isDay size={26} /><small>{info ? pick(info.text) : "—"}</small></span>
              <span className="wx-day-temps">
                <small>{num(low)}°</small>
                <i className="wx-range"><b style={{ left: `${low != null ? ((low - floor) / span) * 100 : 0}%`, right: `${high != null ? 100 - ((high - floor) / span) * 100 : 0}%` }} /></i>
                <strong>{num(high)}°</strong>
              </span>
              <span className="wx-day-rain"><Umbrella size={13} />{num(day.precipitationMm, 1)} mm<small>{num(day.precipitationProbability)}%</small></span>
              <span className="wx-day-wind"><WindArrow from={day.windDirectionDeg} size={13} />{num(day.windGustsMaxKmh)}<small>{t("ριπές km/h", "gusts km/h")}</small></span>
              <span className={`wx-day-uv${uv ? ` tone-${uv.tone}` : ""}`}>UV {num(day.uvIndexMax)}<small>{t(`${num(day.sunshineHours, 1)} ώ ήλιος`, `${num(day.sunshineHours, 1)} h sun`)}</small></span>
              <span className="wx-day-sun"><Sunrise size={13} />{text.clock(sun.sunrise)}<Sunset size={13} />{text.clock(sun.sunset)}</span>
              <span className="wx-day-moon" title={pick(MOON_PHASE_TEXT[moon.name])}><MoonGlyph fraction={moon.fraction} waxing={moon.waxing} size={20} southern={observer.latitude < 0} />{Math.round(moon.fraction * 100)}%</span>
            </div>
          );
        })}
      </div>
    </section>
  );
});

function OutlookRow({ icon: Icon, label, tone, value, advice, text }: { icon: LucideIcon; label: string; tone: Level["tone"] | null; value: string; advice: string; text: Text }) {
  return (
    <div className={`wx-outlook-row${tone ? ` tone-${tone}` : ""}`}>
      <Icon size={17} />
      <div><span>{label}{tone && <em>{text.pick(TONE_LABEL[tone])}</em>}</span><strong>{value}</strong><small>{advice}</small></div>
    </div>
  );
}

const TonightPanel = memo(function TonightPanel({ night, outlook, inProgress, moon, text }: { night: NightWindow | null; outlook: NightOutlook | null; inProgress: boolean; moon: ReturnType<typeof moonDay>; text: Text }) {
  const { t } = text;
  if (!night || !outlook) {
    return <section className="panel"><PanelHeading eyebrow={t("ΑΠΟΨΕ", "TONIGHT")} title={t("Απόψε για φωτογράφιση", "Tonight for photography")} icon={Telescope} /><p className="wx-muted">{t("Δεν υπάρχει νύχτα στο διάστημα της πρόγνωσης.", "No night falls within the forecast.")}</p></section>;
  }
  const o = outlook;
  const advice = {
    sky: { good: t("Καθαρός ουρανός", "Clear sky"), fair: t("Μερική νέφωση: ψάξε κενά προς τον στόχο", "Partly cloudy: look for gaps towards the target"), bad: t("Πολλά σύννεφα πάνω από τη θέση σου", "Mostly cloudy over your site"), warn: "" },
    dew: { good: t("Χαμηλός κίνδυνος δρόσου στον φακό", "Low risk of dew on the lens"), fair: t("Πιθανή δρόσος: έχε έτοιμη θερμαντική ταινία", "Dew possible: keep a heater band ready"), bad: t("Δρόσος ή ομίχλη πολύ πιθανή: θερμαντική ταινία και σκίαστρο", "Dew or fog very likely: heater band and lens hood"), warn: "" },
    wind: { good: t("Ήπιος άνεμος", "Light wind"), fair: t("Ριπές που κουνούν το τρίποδο: χαμήλωσέ το και κρέμασε βάρος", "Gusts shake a tripod: lower it and hang a weight"), bad: t("Ισχυρές ριπές: οι μακριές εκθέσεις θολώνουν", "Strong gusts: long exposures will blur"), warn: "" },
    cold: { good: t("Ήπια θερμοκρασία", "Mild"), fair: t("Κρύο: κράτα ζεστές εφεδρικές μπαταρίες", "Cold: keep spare batteries warm"), bad: t("Παγετός: οι μπαταρίες αδειάζουν γρήγορα, πρόσεχε τον πάγο", "Frost: batteries drain fast; mind the ice"), warn: "" },
    transparency: { good: t("Διαυγής ατμόσφαιρα", "Clear air"), fair: t("Ελαφριά θολούρα", "Slight haze"), bad: t("Θολή ατμόσφαιρα από σωματίδια ή σκόνη: τα αμυδρά TLE χάνονται", "Hazy air from particles or dust: faint TLEs fade out"), warn: "" },
  };
  const moonEvents = night.moonEvents.map((event) => `${event.kind === "rise" ? t("ανατέλλει", "rises") : t("δύει", "sets")} ${text.clock(event.at)}`).join(" · ");
  return (
    <section className="panel wx-tonight">
      <PanelHeading eyebrow={t("ΑΠΟΨΕ · ΦΩΤΟΓΡΑΦΙΣΗ", "TONIGHT · PHOTOGRAPHY")} title={t("Συνθήκες της νύχτας", "Tonight's conditions")} icon={Telescope} aside={inProgress ? <span className="count-badge" title={t("Οι εκτιμήσεις καλύπτουν τις ώρες από τώρα ως το ξημέρωμα.", "The outlook covers the hours from now until dawn.")}>{t("σε εξέλιξη · από τώρα", "under way · from now")}</span> : undefined} />
      <div className="wx-night-window">
        <div><span>{t("Σκοτάδι", "Dark")}</span><strong>{text.clock(night.start)} → {text.clock(night.end)}</strong><small>{t("πολιτικό λυκόφως", "civil twilight")}</small></div>
        <div><span>{t("Αστρονομική νύχτα", "Astronomical night")}</span><strong>{text.clock(night.astronomicalStart)} → {text.clock(night.astronomicalEnd)}</strong><small>{text.duration(night.darkMinutes)}</small></div>
        <div><span>{t("Χωρίς Σελήνη", "Moonless")}</span><strong>{text.duration(night.moonlessDarkMinutes)}</strong><small>{t("Σελήνη", "Moon")} {Math.round(moon.fraction * 100)}%{moonEvents && ` · ${moonEvents}`}</small></div>
      </div>
      <div className="wx-outlook">
        <OutlookRow icon={Cloud} label={t("Ουρανός", "Sky")} tone={o.sky} value={`${num(o.cloudMean)}% ${t("νέφωση", "cloud")} · ${t("υψηλά", "high")} ${num(o.cloudHighMean)}%${(o.precipitationProbabilityMax ?? 0) >= 30 ? ` · ${t("βροχή", "rain")} ${o.precipitationProbabilityMax}%` : ""}`} advice={o.sky ? advice.sky[o.sky] : "—"} text={text} />
        <OutlookRow icon={Droplets} label={t("Δρόσος στον φακό", "Dew on the lens")} tone={o.dew} value={`${t("ελάχιστη απόσταση από σημείο δρόσου", "closest to dew point")} ${num(o.dewSpreadMin, 1)} °C · RH ${num(o.humidityMax)}%`} advice={o.dew ? advice.dew[o.dew] : "—"} text={text} />
        <OutlookRow icon={Wind} label={t("Άνεμος", "Wind")} tone={o.wind} value={`${t("ριπές έως", "gusts up to")} ${num(o.gustMax)} km/h`} advice={o.wind ? advice.wind[o.wind] : "—"} text={text} />
        <OutlookRow icon={Thermometer} label={t("Θερμοκρασία", "Temperature")} tone={o.cold} value={`${t("ελάχιστη", "low")} ${num(o.temperatureMin, 1)} °C`} advice={o.cold ? advice.cold[o.cold] : "—"} text={text} />
        <OutlookRow icon={Telescope} label={t("Διαφάνεια", "Transparency")} tone={o.transparency} value={`AOD ${num(o.aerosolOpticalDepthMean, 2)} · ${t("σκόνη", "dust")} ${num(o.dustMax)} µg/m³`} advice={o.transparency ? advice.transparency[o.transparency] : t("Χωρίς δεδομένα CAMS", "No CAMS data")} text={text} />
      </div>
    </section>
  );
});

function TwilightBar({ now, text, latitude, longitude }: { now: number; text: Text; latitude: number; longitude: number }) {
  const { t } = text;
  const offsetMs = athensUtcOffsetMinutes(new Date(now)) * 60_000;
  const midnight = Math.floor((now + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
  const step = 10 * 60_000;
  const stops: string[] = [];
  let previous: TwilightBand | null = null;
  let start = 0;
  const samples = DAY_MS / step;
  for (let i = 0; i <= samples; i += 1) {
    const band = i < samples ? twilightBand(sunAltitudeDeg(new Date(midnight + i * step + step / 2), latitude, longitude)) : null;
    if (band !== previous) {
      if (previous) stops.push(`${BAND_COLOR[previous]} ${((start / samples) * 100).toFixed(2)}% ${((i / samples) * 100).toFixed(2)}%`);
      previous = band;
      start = i;
    }
  }
  return (
    <div className="wx-twilight">
      <div className="wx-twilight-bar" style={{ background: `linear-gradient(to right, ${stops.join(", ")})` }} role="img" aria-label={t("Ήλιος και λυκόφωτα σήμερα", "Sun and twilight today")}>
        <i style={{ left: `${((now - midnight) / DAY_MS) * 100}%` }} title={t("τώρα", "now")} />
      </div>
      <div className="wx-twilight-scale"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
      <div className="wx-twilight-key">
        {(["day", "civil", "nautical", "astronomical", "night"] as TwilightBand[]).map((band) => (
          <span key={band}><i style={{ background: BAND_COLOR[band] }} />{{
            day: t("Μέρα", "Day"), civil: t("Πολιτικό", "Civil"), nautical: t("Ναυτικό", "Nautical"), astronomical: t("Αστρονομικό", "Astronomical"), night: t("Νύχτα", "Night"),
          }[band]}</span>
        ))}
      </div>
    </div>
  );
}

const SunPanel = memo(function SunPanel({ sun, tomorrow, now, text, latitude, longitude }: { sun: ReturnType<typeof sunDay>; tomorrow: ReturnType<typeof sunDay>; now: number; text: Text; latitude: number; longitude: number }) {
  const { t } = text;
  const change = sun.dayLengthMinutes != null && tomorrow.dayLengthMinutes != null ? tomorrow.dayLengthMinutes - sun.dayLengthMinutes : null;
  return (
    <section className="panel wx-sun">
      <PanelHeading eyebrow={t("ΗΛΙΟΣ · ΣΗΜΕΡΑ", "SUN · TODAY")} title={t("Ανατολή, δύση, λυκόφωτα", "Sunrise, sunset, twilight")} icon={Sun} />
      <div className="wx-sun-main">
        <div><Sunrise size={22} /><span>{t("Ανατολή", "Sunrise")}</span><strong>{text.clock(sun.sunrise)}</strong></div>
        <div><Sunset size={22} /><span>{t("Δύση", "Sunset")}</span><strong>{text.clock(sun.sunset)}</strong></div>
      </div>
      <p className="wx-sun-line">{t("Διάρκεια ημέρας", "Day length")} <strong>{sun.dayLengthMinutes != null ? text.duration(sun.dayLengthMinutes) : "—"}</strong>{change != null && <small> ({change >= 0 ? "+" : "−"}{Math.abs(change)}′ {t("αύριο", "tomorrow")})</small>} · {t("μεσουράνημα", "solar noon")} <strong>{text.clock(sun.solarNoon)}</strong></p>
      <TwilightBar now={now} text={text} latitude={latitude} longitude={longitude} />
      <table className="wx-table">
        <thead><tr><th>{t("Λυκόφως", "Twilight")}</th><th>{t("Πρωί", "Dawn")}</th><th>{t("Βράδυ", "Dusk")}</th></tr></thead>
        <tbody>
          <tr><td>{t("Πολιτικό (−6°)", "Civil (−6°)")}</td><td>{text.clock(sun.civilDawn)}</td><td>{text.clock(sun.civilDusk)}</td></tr>
          <tr><td>{t("Ναυτικό (−12°)", "Nautical (−12°)")}</td><td>{text.clock(sun.nauticalDawn)}</td><td>{text.clock(sun.nauticalDusk)}</td></tr>
          <tr><td>{t("Αστρονομικό (−18°)", "Astronomical (−18°)")}</td><td>{text.clock(sun.astronomicalDawn)}</td><td>{text.clock(sun.astronomicalDusk)}</td></tr>
        </tbody>
      </table>
      <p className="data-note"><Sun size={15} />{t(`Χρυσή ώρα από ${text.clock(sun.goldenHour)}. Τα sprites φαίνονται από το τέλος του ναυτικού λυκόφωτος (Ήλιος κάτω από −12°)· το αστρονομικό σκοτάδι είναι το καλύτερο.`, `Golden hour from ${text.clock(sun.goldenHour)}. Sprites show from the end of nautical twilight (Sun below −12°); astronomical darkness is best.`)}</p>
    </section>
  );
});

const MoonPanel = memo(function MoonPanel({ moon, quarters, now, southern, text }: { moon: ReturnType<typeof moonDay>; quarters: ReturnType<typeof nextMoonQuarters>; now: number; southern: boolean; text: Text }) {
  const { t, pick } = text;
  return (
    <section className="panel wx-moon-panel">
      <PanelHeading eyebrow={t("ΣΕΛΗΝΗ", "MOON")} title={t("Φάση και ορατότητα", "Phase and visibility")} icon={MoonStar} />
      <div className="wx-moon-main">
        <MoonGlyph fraction={moon.fraction} waxing={moon.waxing} size={92} southern={southern} />
        <div>
          <strong>{pick(MOON_PHASE_TEXT[moon.name])}</strong>
          <span>{t("Φωτισμός", "Illuminated")} {Math.round(moon.fraction * 100)}% · {t("ηλικία", "age")} {num(moon.ageDays, 1)} / {num(SYNODIC_MONTH_DAYS, 1)} {t("ημ.", "d")}</span>
          <span>{moon.altitudeDeg > 0 ? t(`Πάνω από τον ορίζοντα, ${num(moon.altitudeDeg)}° ύψος προς ${directionLabel(moon.azimuthDeg, "el")}`, `Above the horizon, ${num(moon.altitudeDeg)}° high to the ${directionLabel(moon.azimuthDeg, "en")}`) : t("Κάτω από τον ορίζοντα", "Below the horizon")}</span>
          <span className="wx-moon-times"><Moon size={13} />{t("Ανατολή", "Rise")} <strong>{moon.alwaysUp ? t("όλη μέρα πάνω", "up all day") : moon.rise ? text.clock(moon.rise) : "—"}</strong> · {t("Δύση", "Set")} <strong>{moon.alwaysDown ? t("όλη μέρα κάτω", "down all day") : moon.set ? text.clock(moon.set) : "—"}</strong></span>
          <small>{t("Απόσταση", "Distance")} {Math.round(moon.distanceKm).toLocaleString(text.locale)} km</small>
        </div>
      </div>
      <div className="wx-quarters">
        {quarters.map((quarter) => {
          const [fraction, waxing] = QUARTER_GLYPH[quarter.quarter];
          return (
            <div key={quarter.at.toISOString()}>
              <MoonGlyph fraction={fraction} waxing={waxing} size={28} southern={southern} />
              <span>{pick(MOON_PHASE_TEXT[quarter.quarter])}</span>
              <strong>{text.day(quarter.at)} {text.clock(quarter.at)}</strong>
              <small>{text.inDays(quarter.at.getTime() - now)}</small>
            </div>
          );
        })}
      </div>
      <p className="data-note"><Moon size={15} />{t("Η Σελήνη πάνω από τον ορίζοντα, φωτισμένη πάνω από 55 % και κοντά στην κατεύθυνση του στόχου, μειώνει τον δείκτη ευκαιρίας. Οι νύχτες κοντά στη Νέα Σελήνη είναι οι πιο σκοτεινές.", "A Moon above the horizon, more than 55 % lit and near the target's direction, lowers the opportunity index. Nights near New Moon are the darkest.")}</p>
    </section>
  );
});

function StormPanel({ hours, times, upcoming, bands, scan, observer, now, hover, text, onMap }: {
  hours: StationHour[]; times: number[]; upcoming: StationHour[]; bands: TwilightBand[]; scan: OpportunityResponse | null; observer: SavedLocation; now: number; hover: Hover; text: Text; onMap: () => void;
}) {
  const { t, pick } = text;
  const periods = stormPeriods(hours, now);
  const stormHours = upcoming.filter(isStormHour).length;
  const lightning = scan?.lightning?.status === "available" ? nearestLightning(observer, scan.lightning.clusters) : null;
  const day = upcoming.filter((hour) => Date.parse(hour.time) <= now + 24 * HOUR_MS);
  const capeMax = Math.max(...present(day.map((hour) => hour.capeJkg)), 0);
  const liftedMin = present(day.map((hour) => hour.liftedIndex));
  const liMin = liftedMin.length ? Math.min(...liftedMin) : null;
  const cin = valueNear(hours, now, (hour) => hour.convectiveInhibitionJkg);
  const cape = capeLevel(capeMax);
  const li = liftedIndexLevel(liMin);
  const alerts = [...(scan?.weatherAlerts.alerts ?? [])].sort((a, b) => (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY));
  const near = lightning && lightning.distanceKm <= LIGHTNING_NEAR_KM ? lightning : null;
  const status: { tone: Level["tone"]; title: string; detail: string } = near
    ? {
      tone: near.distanceKm <= LIGHTNING_DANGER_KM ? "bad" : "warn",
      title: near.distanceKm === 0
        ? t("Κεραυνοί γύρω από τη θέση σου", "Lightning around your site")
        : near.distanceKm <= LIGHTNING_DANGER_KM
          ? t(`Κεραυνοί πολύ κοντά, ~${Math.round(near.distanceKm)} km προς ${directionLabel(near.bearingDeg, "el")}`, `Lightning very close, ~${Math.round(near.distanceKm)} km to the ${directionLabel(near.bearingDeg, "en")}`)
          : t(`Κεραυνοί σε ~${Math.round(near.distanceKm)} km προς ${directionLabel(near.bearingDeg, "el")}`, `Lightning ~${Math.round(near.distanceKm)} km to the ${directionLabel(near.bearingDeg, "en")}`),
      detail: t(
        `Ο δορυφόρος MTG-LI κατέγραψε κεραυνούς πριν από ${near.cluster.ageMinutes}′ σε καταιγίδα με κέντρο ${Math.round(near.centerKm)} km ${directionLabel(near.bearingDeg, "el")} και έκταση ~${near.cluster.radiusKm} km γύρω του${near.distanceKm === 0 ? ": η θέση σου είναι μέσα στην περιοχή της" : ""}. Η θέση των κεραυνών έχει αβεβαιότητα ~10–15 km.`,
        `MTG-LI recorded lightning ${near.cluster.ageMinutes}′ ago in a storm centred ${Math.round(near.centerKm)} km ${directionLabel(near.bearingDeg, "en")} and spreading ~${near.cluster.radiusKm} km around it${near.distanceKm === 0 ? ": your site is inside its area" : ""}. Lightning positions are uncertain by ~10–15 km.`,
      ),
    }
    : periods.length
      ? {
        tone: periods.some((period) => period.thunder) ? "warn" : "fair",
        title: periods[0].thunder ? t("Το μοντέλο δίνει καταιγίδα στη θέση σου", "The model gives a thunderstorm at your site") : t("Το μοντέλο δίνει βροχή με αστάθεια στη θέση σου", "The model gives rain with instability at your site"),
        detail: periods.slice(0, 3).map((period) => `${text.weekday(Date.parse(period.start))} ${text.clock(period.start)}${period.end !== period.start ? `–${text.clock(Date.parse(period.end) + HOUR_MS)}` : ""}`).join(" · "),
      }
      : {
        tone: "good",
        title: t("Καμία καταιγίδα στη θέση σου τις επόμενες 48 ώρες", "No storm at your site in the next 48 hours"),
        detail: t("Σύμφωνα με το μοντέλο· οι καταιγίδες-στόχοι για sprites βρίσκονται 100–300 km μακριά.", "According to the model; target storms for sprites are 100–300 km away."),
      };
  const capeValues = upcoming.map((hour) => hour.capeJkg);
  const capeColors = upcoming.map((hour) => (isStormHour(hour) ? "#f04362" : (hour.capeJkg ?? 0) >= 1000 ? "#e5ad55" : "#6db8e8"));
  return (
    <section className="panel wx-storm wx-span-2">
      <PanelHeading eyebrow={t("ΚΑΤΑΙΓΙΔΕΣ & ΑΣΦΑΛΕΙΑ ΕΔΩ", "LOCAL STORMS & SAFETY")} title={t("Αστάθεια και προειδοποιήσεις", "Instability and warnings")} icon={Zap} />
      <div className={`wx-alert-box tone-${status.tone}`}>
        {status.tone === "good" ? <ShieldAlert size={19} /> : <Zap size={19} />}
        <div><strong>{status.title}</strong><p>{status.detail}</p></div>
      </div>
      <div className="wx-stats compact">
        <Stat icon={Zap} label={t("CAPE (μέγ. 24ώρου)", "CAPE (24 h max)")} value={`${num(capeMax)} J/kg`} hint={cape ? pick(cape.text) : undefined} tone={cape && cape.level >= 2 ? cape.tone : null} />
        <Stat icon={Gauge} label={t("Lifted index (ελάχ.)", "Lifted index (min)")} value={num(liMin, 1)} hint={li ? pick(li.text) : undefined} tone={li && li.level >= 1 ? li.tone : null} />
        <Stat icon={ShieldAlert} label={t("Αναστολή (CIN)", "Inhibition (CIN)")} value={`${num(cin)} J/kg`} hint={t("εμποδίζει την ανάπτυξη καταιγίδων", "holds storms back")} />
        <Stat icon={CloudLightning} label={t("Ώρες καταιγίδας (48 ώ)", "Storm hours (48 h)")} value={String(stormHours)} hint={periods.length ? `${t("πρώτη", "first")} ${text.weekday(Date.parse(periods[0].start))} ${text.clock(periods[0].start)}` : t("καμία στη θέση σου", "none at your site")} tone={stormHours ? "warn" : null} />
      </div>
      <TimeChart title={t("Ενέργεια αστάθειας CAPE", "Instability energy (CAPE)")} icon={Zap} times={times} bands={bands} hover={hover} text={text} leftUnit="" left={axisFor(present(capeValues), 0, undefined, 500)}
        series={[{ key: "c", label: "CAPE", values: capeValues, color: "#6db8e8", kind: "bars", unit: " J/kg", barColors: capeColors }]}
        footer={<p className="wx-chart-note"><i className="wx-key-dot" style={{ background: "#f04362" }} />{t("ώρα με καταιγίδα ή βροχή με αστάθεια", "hour with a storm, or rain with instability")} <i className="wx-key-dot" style={{ background: "#e5ad55" }} />CAPE ≥ 1000</p>}
      />
      <div className="wx-warnings">
        <span className="eyebrow">{t("METEOALARM · ΠΡΟΕΙΔΟΠΟΙΗΣΕΙΣ", "METEOALARM · WARNINGS")}</span>
        {!scan ? <p className="wx-muted">{t("Αναμονή για τη σάρωση…", "Waiting for the scan…")}</p>
          : scan.weatherAlerts.status !== "available" && !alerts.length ? <p className="wx-muted">{pick(scan.weatherAlerts.message)}</p>
            : alerts.length ? <div className="alert-chips">{alerts.slice(0, 6).map((alert) => <a key={alert.id} href={alert.link} target="_blank" rel="noreferrer"><b>{alert.severity}</b>{alert.event.replace(/ warning/i, "")} · {alert.area}{alert.distanceKm != null && ` · ${Math.round(alert.distanceKm)} km`}{alert.expires && ` · ${t("έως", "until")} ${text.day(alert.expires)} ${text.clock(alert.expires)}`}</a>)}</div>
              : <p className="wx-muted">{t("Καμία ενεργή προειδοποίηση για την Ελλάδα.", "No active warning for Greece.")}</p>}
      </div>
      <div className="safety-card">
        <AlertTriangle size={18} />
        <div><strong>{t("Κανόνας 30/30", "The 30/30 rule")}</strong><p>{t("Αν ανάμεσα σε αστραπή και βροντή περνούν λιγότερα από 30 δευτερόλεπτα, ο κεραυνός είναι κάτω από 10 km: μπες σε αυτοκίνητο ή κτίριο και περίμενε 30 λεπτά μετά την τελευταία βροντή. Μην παρατηρείς από κορυφές και ανοιχτούς λόφους με καταιγίδα κοντά.", "If fewer than 30 seconds pass between flash and thunder, the lightning is within 10 km: get into a car or a building and wait 30 minutes after the last thunder. Do not observe from summits or open hills with a storm nearby.")}</p></div>
      </div>
      <button className="secondary-action" onClick={onMap}><MapIcon size={16} />{t("Ζωντανός χάρτης καταιγίδων", "Live storm map")}</button>
    </section>
  );
}

const POLLUTANTS: Array<{ key: keyof AirQualityConditions; aqi?: keyof AirQualityConditions; label: string; unit: string; digits?: number }> = [
  { key: "pm2_5", aqi: "aqiPm2_5", label: "PM2.5", unit: "µg/m³" },
  { key: "pm10", aqi: "aqiPm10", label: "PM10", unit: "µg/m³" },
  { key: "nitrogenDioxide", aqi: "aqiNitrogenDioxide", label: "NO₂", unit: "µg/m³" },
  { key: "ozone", aqi: "aqiOzone", label: "O₃", unit: "µg/m³" },
  { key: "sulphurDioxide", aqi: "aqiSulphurDioxide", label: "SO₂", unit: "µg/m³", digits: 1 },
  { key: "carbonMonoxide", label: "CO", unit: "µg/m³" },
  { key: "dust", label: "Dust", unit: "µg/m³" },
  { key: "aerosolOpticalDepth", label: "AOD", unit: "", digits: 2 },
];

function AirPanel({ air, now, latitude, longitude, hover, text }: { air: WeatherStationResponse["airQuality"] | null; now: number; latitude: number; longitude: number; hover: Hover; text: Text }) {
  const { t, pick } = text;
  if (!air || air.status !== "available") {
    return <section className="panel wx-span-2"><PanelHeading eyebrow={t("ΠΟΙΟΤΗΤΑ ΑΕΡΑ · CAMS", "AIR QUALITY · CAMS")} title={t("Ποιότητα αέρα και ρύπανση", "Air quality and pollution")} icon={Factory} /><p className="wx-muted">{air ? pick(air.message) : "—"}</p></section>;
  }
  const current = air.current ?? air.hours.find((hour) => Math.abs(Date.parse(hour.time) - now) <= 30 * 60_000) ?? null;
  const level = aqiLevel(current?.europeanAqi ?? null);
  const coming = air.hours.filter((hour) => Date.parse(hour.time) >= now - 30 * 60_000).slice(0, CHART_HOURS);
  const times = coming.map((hour) => Date.parse(hour.time));
  const bands = times.map((ms) => twilightBand(sunAltitudeDeg(new Date(ms), latitude, longitude)));
  const aqiValues = coming.map((hour) => hour.europeanAqi);
  const aqiColors = coming.map((hour) => { const band = aqiLevel(hour.europeanAqi); return band ? AQI_COLORS[band.level] : null; });
  const pollen = current ? (Object.keys(POLLEN_TEXT) as PollenType[]).map((type) => ({ type, value: current.pollen[type] })) : [];
  const pollenSeason = pollen.some((item) => (item.value ?? 0) >= 1);
  const advice = !level ? "" : level.level <= 1
    ? t("Κανένας περιορισμός για δραστηριότητες έξω.", "No limits on outdoor activity.")
    : level.level === 2
      ? t("Οι ευαίσθητες ομάδες ας περιορίσουν την έντονη άσκηση έξω.", "Sensitive groups should limit hard exercise outdoors.")
      : level.level === 3
        ? t("Περιόρισε την έντονη δραστηριότητα έξω, ιδίως με συμπτώματα.", "Cut down hard outdoor activity, especially with symptoms.")
        : t("Απόφυγε την έντονη δραστηριότητα έξω.", "Avoid hard outdoor activity.");
  return (
    <section className="panel wx-air wx-span-2">
      <PanelHeading eyebrow={t("ΠΟΙΟΤΗΤΑ ΑΕΡΑ · CAMS", "AIR QUALITY · CAMS")} title={t("Ποιότητα αέρα και ρύπανση", "Air quality and pollution")} icon={Factory} aside={current && <span className="count-badge">{text.clock(current.time)}</span>} />
      <div className="wx-aqi">
        <div className="wx-aqi-badge" style={{ "--aqi": level ? AQI_COLORS[level.level] : "#708599" } as React.CSSProperties}>
          <span>{t("Ευρωπαϊκός δείκτης", "European AQI")}</span><strong>{num(current?.europeanAqi)}</strong><em>{level ? pick(level.text) : "—"}</em>
        </div>
        <p>{advice} {t("Ο δείκτης είναι ο χειρότερος από τους επιμέρους ρύπους (κλίμακα EEA: 0–20 καλή, 20–40 ικανοποιητική, 40–60 μέτρια, 60–80 κακή, 80–100 πολύ κακή).", "The index is the worst of the individual pollutants (EEA scale: 0–20 good, 20–40 fair, 40–60 moderate, 60–80 poor, 80–100 very poor).")}</p>
      </div>
      <div className="wx-pollutants">
        {POLLUTANTS.map((item) => {
          const value = current?.[item.key] as number | null | undefined;
          const band = item.aqi ? aqiLevel(current?.[item.aqi] as number | null) : null;
          const label = item.key === "dust" ? t("Σκόνη", "Dust") : item.label;
          return (
            <div key={item.key} style={{ "--band": band ? AQI_COLORS[band.level] : "transparent" } as React.CSSProperties} className={band ? "banded" : ""}>
              <span>{label}</span><strong>{num(value, item.digits ?? 0)}</strong><small>{item.unit}{band && ` · ${pick(band.text)}`}</small>
            </div>
          );
        })}
      </div>
      <p className="data-note"><Lightbulb size={15} />{t("Σκόνη (Σαχάρα) και AOD δείχνουν πόσο θολή είναι η ατμόσφαιρα: με AOD πάνω από 0,3 τα αμυδρά TLE και ο Γαλαξίας χάνονται.", "Dust (Sahara) and AOD show how hazy the air is: with AOD above 0.3 faint TLEs and the Milky Way fade.")}</p>
      <div className="wx-pollen">
        <span className="eyebrow"><Flower2 size={13} /> {t("ΓΥΡΗ · κόκκοι/m³", "POLLEN · grains/m³")}</span>
        {pollenSeason
          ? <div>{pollen.map((item) => <span key={item.type}>{pick(POLLEN_TEXT[item.type])} <strong>{num(item.value)}</strong></span>)}</div>
          : <p className="wx-muted">{t("Εκτός εποχής: το CAMS δεν δίνει γύρη στην περιοχή τώρα (ελιά Απρ–Ιουν, αγρωστώδη Απρ–Ιουλ).", "Out of season: CAMS gives no pollen here now (olive Apr–Jun, grass Apr–Jul).")}</p>}
      </div>
      <TimeChart title={t("Ευρωπαϊκός δείκτης ποιότητας αέρα", "European air quality index")} icon={Factory} times={times} bands={bands} hover={hover} text={text} leftUnit="" left={axisFor(present(aqiValues), 0, undefined, 60)}
        series={[{ key: "aqi", label: "AQI", values: aqiValues, color: "#50ccaa", kind: "bars", unit: "", barColors: aqiColors }]}
      />
    </section>
  );
}

const LIGHT_POLLUTION: Record<SavedLocation["lightPollution"], { bortle: string; text: Localized }> = {
  low: { bortle: "Bortle 1–3", text: { el: "Σκοτεινός ουρανός: ο Γαλαξίας φαίνεται με λεπτομέρειες. Ιδανικός για αμυδρά sprites, halos και ELVES.", en: "Dark sky: the Milky Way shows detail. Ideal for faint sprites, halos and ELVES." } },
  medium: { bortle: "Bortle 4–6", text: { el: "Αγροτικός ή προαστιακός ουρανός με φωτεινούς θόλους πόλεων στον ορίζοντα. Τα sprites καταγράφονται· απόφυγε στόχους πάνω από πόλεις.", en: "Rural or suburban sky with town glow on the horizon. Sprites still record; avoid targets above towns." } },
  high: { bortle: "Bortle 7–9", text: { el: "Αστικός ουρανός: μόνο τα πιο φωτεινά sprites ξεχωρίζουν. Μετακινήσου σε σκοτεινότερη θέση αν μπορείς.", en: "Urban sky: only the brightest sprites stand out. Move to a darker site if you can." } },
  unknown: { bortle: "Bortle ?", text: { el: "Δεν έχει δηλωθεί για αυτή τη θέση. Όρισέ τη στις Θέσεις.", en: "Not set for this site. Set it in Locations." } },
};

const LightPanel = memo(function LightPanel({ observer, text, onLocations }: { observer: SavedLocation; text: Text; onLocations: () => void }) {
  const { t, pick } = text;
  const info = LIGHT_POLLUTION[observer.lightPollution];
  const mapUrl = `https://www.lightpollutionmap.info/#zoom=9.00&lat=${observer.latitude.toFixed(4)}&lon=${observer.longitude.toFixed(4)}`;
  return (
    <section className="panel wx-light">
      <PanelHeading eyebrow={t("ΦΩΤΟΡΥΠΑΝΣΗ", "LIGHT POLLUTION")} title={t("Φωτεινότητα ουρανού", "Sky brightness")} icon={Lightbulb} />
      <div className={`wx-bortle level-${observer.lightPollution}`}><strong>{info.bortle}</strong><span>{t("όπως δηλώθηκε για τη θέση", "as set for the site")}</span></div>
      <p className="wx-muted">{pick(info.text)}</p>
      <div className="wx-light-actions">
        <a className="secondary-action" href={mapUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />{t("Χάρτης φωτορύπανσης", "Light pollution map")}</a>
        <button className="secondary-action" onClick={onLocations}><MapPin size={15} />{t("Αλλαγή στις Θέσεις", "Change in Locations")}</button>
      </div>
      <p className="data-note"><Lightbulb size={15} />{t("Δεν υπάρχει ελεύθερη πηγή μετρήσεων φωτορύπανσης χωρίς κλειδί· ο χάρτης (VIIRS / World Atlas) δείχνει την περιοχή σου.", "There is no free keyless source of light-pollution readings; the map (VIIRS / World Atlas) shows your area.")}</p>
    </section>
  );
});
