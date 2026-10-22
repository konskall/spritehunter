"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { memo, useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
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
  ShieldCheck,
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
  valueNear,
  weatherCodeInfo,
  type Level,
  type LocalStormStatus,
  type NightOutlook,
  type WeatherIcon,
} from "@/lib/weather";
import { moonDay, nextMoonQuarters, nextMoonRiseSet, nightWindow, sunDay, SYNODIC_MONTH_DAYS, twilightBand, type MoonPhaseName, type NightWindow, type TwilightBand } from "@/lib/sky-calendar";
import { sunAltitudeDeg } from "@/lib/astronomy";
import { athensDayBounds, athensDayDifference, athensNoon } from "@/lib/time";
import { niceAxis } from "@/lib/chart-axis";

const TIME_ZONE = "Europe/Athens";
const HOUR_MS = 3_600_000;
// Hours shown in the charts and in the hour strip.
const CHART_HOURS = 48;
const STRIP_HOURS = 24;

type Text = ReturnType<typeof makeText>;

function makeText(language: Language) {
  const locale = language === "el" ? "el-GR" : "en-GB";
  const clock = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const hour = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23" });
  const weekday = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, weekday: "short" });
  const day = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, weekday: "short", day: "numeric", month: "numeric" });
  const date = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, day: "numeric", month: "numeric" });
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
    duration: (minutes: number) => `${Math.floor(minutes / 60)} ${t("ώ", "h")} ${String(Math.round(minutes % 60)).padStart(2, "0")}′`,
    /** Today, tomorrow… by Athens calendar days, as the dates beside it read. */
    relativeDay: (target: Date | number, now: number) => {
      const days = athensDayDifference(new Date(now), new Date(target));
      if (days <= 0) return t("σήμερα", "today");
      if (days === 1) return t("αύριο", "tomorrow");
      if (days === 2) return t("μεθαύριο", "in 2 days");
      return t(`σε ${days} ημέρες`, `in ${days} days`);
    },
  };
}

/** `value` to `digits` decimals, "—" when missing; never "-0". */
function num(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return "—";
  const fixed = value.toFixed(digits);
  return /^-0(\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed;
}

const present = (values: Array<number | null>) => values.filter((value): value is number => value != null);

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

interface Axis { min: number; max: number; step: number }

/** An hour on a chart's time axis, formatted once rather than on every redraw. */
interface TimeLabel { hour: number; weekday: string; clock: string }

const timeLabels = (times: number[], text: Text): TimeLabel[] => times.map((ms) => ({ hour: text.hourOf(ms), weekday: text.weekday(ms), clock: text.clock(ms) }));

const yOf = (value: number, axis: Axis) => Math.min(100, Math.max(0, 100 - ((value - axis.min) / (axis.max - axis.min)) * 100));

function ticksFor(axis: Axis, unit: string) {
  const digits = axis.step >= 1 ? 0 : axis.step >= 0.1 ? 1 : 2;
  return [axis.max, axis.min + axis.step, axis.min].map((value) => ({ y: yOf(value, axis), label: `${num(value, digits)}${unit}` }));
}

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

/**
 * The hour under the pointer, shared by every chart. Only the charts subscribe, so a pointer move
 * re-renders their legends and cursors and nothing else. Pointer moves faster than the screen
 * refreshes are folded into one update per frame; keys and resets apply at once.
 */
function createHoverStore() {
  let index: number | null = null;
  let pending: number | null | undefined;
  let frame = 0;
  const listeners = new Set<() => void>();
  const apply = (next: number | null) => {
    if (next === index) return;
    index = next;
    listeners.forEach((listener) => listener());
  };
  return {
    get: () => index,
    /** For pointer moves: the latest position wins at the next frame. */
    follow: (next: number | null) => {
      pending = next;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const latest = pending;
        pending = undefined;
        if (latest !== undefined) apply(latest);
      });
    },
    set: (next: number | null) => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending = undefined;
      apply(next);
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

type HoverStore = ReturnType<typeof createHoverStore>;

const useHoverIndex = (hover: HoverStore) => useSyncExternalStore(hover.subscribe, hover.get, hover.get);

type Tick = { y: number; label: string };

/** Consecutive hours in the same daylight band, drawn as one rectangle each. */
function bandRuns(bands: TwilightBand[]) {
  const runs: Array<{ band: TwilightBand; start: number; length: number }> = [];
  bands.forEach((band, index) => {
    const last = runs.at(-1);
    if (last && last.band === band) last.length += 1;
    else runs.push({ band, start: index, length: 1 });
  });
  return runs;
}

// Keys that move a chart's readout, like a slider.
const STEP_KEYS: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 6, PageDown: -6 };

/**
 * Frame shared by the hourly charts: legend at the hovered hour, day/night shading, time axis.
 * The drawing does not depend on the hovered hour, so a pointer move only redraws the legend and
 * the cursor. The plot works as a slider too: arrow keys move the readout, Escape goes back to now.
 */
function ChartFrame({ title, icon: Icon, labels, bands, hover, hovered, text, legend, valueText, leftTicks, rightTicks, height = 112, plot, footer }: {
  title: string; icon: LucideIcon; labels: TimeLabel[]; bands: TwilightBand[]; hover: HoverStore; hovered: number | null; text: Text; legend: ReactNode; valueText: string;
  leftTicks: Tick[]; rightTicks?: Tick[]; height?: number; plot: ReactNode; footer?: ReactNode;
}) {
  const n = labels.length;
  const index = hovered != null && hovered < n ? hovered : 0;
  const svg = useMemo(() => (
    <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden="true">
      {bandRuns(bands).map((run) => BAND_FILL[run.band] && <rect key={run.start} x={run.start} y={0} width={run.length} height={100} fill={BAND_FILL[run.band]!} />)}
      {leftTicks.map((tick) => <line key={`g${tick.y}`} x1={0} x2={n} y1={tick.y} y2={tick.y} className="wx-grid" vectorEffect="non-scaling-stroke" />)}
      {labels.map((label, i) => label.hour === 0 && <line key={`d${i}`} x1={i + 0.5} x2={i + 0.5} y1={0} y2={100} className="wx-midnight" vectorEffect="non-scaling-stroke" />)}
      {plot}
    </svg>
  ), [n, bands, leftTicks, labels, plot]);
  const axis = useMemo(() => (
    <div className={`wx-axis${rightTicks ? " has-right" : ""}`}>
      {labels.map((label, i) => label.hour % 6 === 0 && (
        <span key={i} className={label.hour === 0 ? "day" : ""} style={{ left: `${((i + 0.5) / n) * 100}%` }}>{label.hour === 0 ? label.weekday : String(label.hour).padStart(2, "0")}</span>
      ))}
    </div>
  ), [labels, n, rightTicks]);
  if (!n) return null;
  const select = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    hover.follow(Math.max(0, Math.min(n - 1, Math.floor(((event.clientX - rect.left) / rect.width) * n))));
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") hover.set(null);
    else if (event.key === "Home") hover.set(0);
    else if (event.key === "End") hover.set(n - 1);
    else if (event.key in STEP_KEYS) hover.set(Math.max(0, Math.min(n - 1, (hovered ?? 0) + STEP_KEYS[event.key])));
    else return;
    event.preventDefault();
  };
  return (
    <div className="wx-chart">
      <div className="wx-chart-head">
        <span className="wx-chart-title"><Icon size={14} />{title}</span>
        <span className="wx-chart-time">{hovered == null ? text.t("τώρα", "now") : `${labels[index].weekday} ${labels[index].clock}`}</span>
      </div>
      <div className="wx-legend">{legend}</div>
      <div className={`wx-plot-wrap${rightTicks ? " has-right" : ""}`}>
        <div className="wx-ticks left">{leftTicks.map((tick) => <span key={tick.label + tick.y} style={{ top: `${tick.y}%` }}>{tick.label}</span>)}</div>
        <div
          className="wx-plot"
          style={{ height }}
          role="slider"
          tabIndex={0}
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={n - 1}
          aria-valuenow={index}
          aria-valuetext={valueText}
          onPointerMove={select}
          onPointerDown={select}
          onPointerLeave={(event) => { if (event.pointerType === "mouse") hover.follow(null); }}
          onKeyDown={onKeyDown}
        >
          {svg}
          {hovered != null && <i className="wx-cursor" style={{ left: `${((index + 0.5) / n) * 100}%` }} />}
        </div>
        {rightTicks && <div className="wx-ticks right">{rightTicks.map((tick) => <span key={tick.label + tick.y} style={{ top: `${tick.y}%` }}>{tick.label}</span>)}</div>}
      </div>
      {axis}
      {footer}
    </div>
  );
}

function TimeChart({ title, icon, labels, bands, hover, text, series, left, right, leftUnit, rightUnit, height, footer }: {
  title: string; icon: LucideIcon; labels: TimeLabel[]; bands: TwilightBand[]; hover: HoverStore; text: Text; series: ChartSeries[];
  left: Axis; right?: Axis; leftUnit: string; rightUnit?: string; height?: number; footer?: ReactNode;
}) {
  const hovered = useHoverIndex(hover);
  const index = hovered != null && hovered < labels.length ? hovered : 0;
  const leftTicks = useMemo(() => ticksFor(left, leftUnit), [left, leftUnit]);
  const rightTicks = useMemo(() => (right ? ticksFor(right, rightUnit ?? "") : undefined), [right, rightUnit]);
  const plot = useMemo(() => series.map((item) => {
    const axis = item.right && right ? right : left;
    if (item.kind === "bars") {
      // One path per colour instead of a rectangle per hour keeps redraws cheap.
      const paths = new Map<string, string>();
      item.values.forEach((value, i) => {
        if (value == null || value <= axis.min) return;
        const color = item.barColors?.[i] ?? item.color;
        paths.set(color, `${paths.get(color) ?? ""}M${(i + 0.16).toFixed(2)},100V${yOf(value, axis).toFixed(2)}h0.68V100Z`);
      });
      return <g key={item.key}>{[...paths].map(([color, d]) => <path key={color} d={d} fill={color} />)}</g>;
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
  }), [series, left, right]);
  const reading = (item: ChartSeries) => `${num(item.values[index], item.digits ?? 0)}${item.values[index] != null ? item.unit : ""}`;
  const legend = series.map((item) => (
    <span key={item.key}>
      <i className={`wx-swatch ${item.kind}${item.dashed ? " dashed" : ""}`} style={{ "--swatch": item.color } as React.CSSProperties} />
      {item.label} <strong>{reading(item)}</strong>
    </span>
  ));
  const valueText = `${labels[index]?.weekday ?? ""} ${labels[index]?.clock ?? ""}: ${series.map((item) => `${item.label} ${reading(item)}`).join(", ")}`;
  return (
    <ChartFrame
      title={title} icon={icon} labels={labels} bands={bands} hover={hover} hovered={hovered} text={text} legend={legend} valueText={valueText}
      height={height} footer={footer} leftTicks={leftTicks} rightTicks={rightTicks} plot={plot}
    />
  );
}

/** Cloud per layer (and the median of the forecasts, when the scan has them) as shaded rows. */
function CloudStrip({ labels, bands, hover, text, rows }: { labels: TimeLabel[]; bands: TwilightBand[]; hover: HoverStore; text: Text; rows: Array<{ label: string; values: Array<number | null> }> }) {
  const hovered = useHoverIndex(hover);
  const index = hovered != null && hovered < labels.length ? hovered : 0;
  const rowHeight = 100 / rows.length;
  const leftTicks = useMemo(() => rows.map((row, i) => ({ y: (i + 0.5) * rowHeight, label: row.label })), [rows, rowHeight]);
  // Cells grouped by cover in 10 % steps: one path per shade instead of a rectangle per hour.
  const plot = useMemo(() => {
    const shades = new Map<number, string>();
    rows.forEach((row, r) => row.values.forEach((value, i) => {
      if (value == null || value <= 0) return;
      const shade = Math.max(1, Math.round(value / 10));
      shades.set(shade, `${shades.get(shade) ?? ""}M${i},${(r * rowHeight + 1).toFixed(2)}h1.02v${(rowHeight - 2).toFixed(2)}h-1.02Z`);
    }));
    return [...shades].map(([shade, d]) => <path key={shade} d={d} fill="#cfe3f2" fillOpacity={Math.min(0.9, shade * 0.09)} />);
  }, [rows, rowHeight]);
  const reading = (row: { values: Array<number | null> }) => `${num(row.values[index])}${row.values[index] != null ? "%" : ""}`;
  return (
    <ChartFrame
      title={text.t("Νέφωση ανά στρώμα", "Cloud by layer")}
      icon={Cloud}
      labels={labels}
      bands={bands}
      hover={hover}
      hovered={hovered}
      text={text}
      height={rows.length * 22}
      legend={rows.map((row) => <span key={row.label}>{row.label} <strong>{reading(row)}</strong></span>)}
      valueText={`${labels[index]?.weekday ?? ""} ${labels[index]?.clock ?? ""}: ${rows.map((row) => `${row.label} ${reading(row)}`).join(", ")}`}
      leftTicks={leftTicks}
      plot={plot}
    />
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
  /** Why the latest scan failed, if it did. */
  scanError: Localized | null;
  /** Changes when the scan is refreshed, so this view reloads with it. */
  refreshKey: number | null;
  onMap: () => void;
  onLocations: () => void;
}

export default function WeatherView({ language, observer, scan, scanError, refreshKey, onMap, onLocations }: WeatherViewProps) {
  const text = useMemo(() => makeText(language), [language]);
  const { t, pick } = text;
  const now = useClock();
  const { data, loading, error } = useWeatherStation(observer.latitude, observer.longitude, refreshKey);
  const { latitude, longitude } = observer;
  // The app keeps the last scan while a new site's scan runs (or after it fails); it belongs to
  // the site it was made for and must not stand in for this one.
  const siteScan = scan && isSameSite(scan.observer, observer) ? scan : null;
  const scanNote: Localized = scanError
    ? { el: `Η σάρωση για αυτή τη θέση απέτυχε (${scanError.el}). Πάτησε «Ανανέωση δεδομένων».`, en: `The scan for this site failed (${scanError.en}). Press “Refresh data”.` }
    : { el: "Αναμονή για τη σάρωση αυτής της θέσης…", en: "Waiting for this site's scan…" };

  const hours = useMemo(() => data?.hours ?? [], [data]);
  const upcoming = useMemo(() => hours.filter((hour) => Date.parse(hour.time) >= now - 30 * 60_000).slice(0, CHART_HOURS), [hours, now]);
  const times = useMemo(() => upcoming.map((hour) => Date.parse(hour.time)), [upcoming]);
  const labels = useMemo(() => timeLabels(times, text), [times, text]);
  const bands = useMemo(() => times.map((ms) => twilightBand(sunAltitudeDeg(new Date(ms), latitude, longitude))), [times, latitude, longitude]);
  // Rain in the hour that starts at each shown hour (Open-Meteo stamps it at the hour's end).
  const rain = useMemo(() => {
    const ahead = rainAhead(hours);
    const byTime = new Map(hours.map((hour, index) => [hour.time, ahead[index]]));
    return upcoming.map((hour) => byTime.get(hour.time) ?? { mm: null, chance: null });
  }, [hours, upcoming]);
  const strip = useMemo(() => upcoming.slice(0, STRIP_HOURS), [upcoming]);
  const stripRain = useMemo(() => rain.slice(0, STRIP_HOURS), [rain]);
  // Recomputed with the minute clock, not on every pointer move over the charts.
  const sky = useMemo(() => {
    const date = new Date(now);
    return {
      sun: sunDay(date, latitude, longitude),
      sunTomorrow: sunDay(athensNoon(date, 1), latitude, longitude),
      moon: moonDay(date, latitude, longitude),
      moonNext: nextMoonRiseSet(date, latitude, longitude),
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
  const [hover] = useState(createHoverStore);

  const updated = data ? text.clock(data.retrievedAt) : null;
  return (
    // A tap anywhere but on a chart puts the readouts back to now (touch has no pointer leaving).
    <div className="view-stack weather-view" onPointerDown={(event) => { if (!(event.target as Element).closest?.(".wx-plot")) hover.set(null); }}>
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
          <ObservedPanel scan={siteScan} scanNote={scanNote} model={data} now={now} text={text} />
          <section className="panel wx-span-all">
            <PanelHeading eyebrow={t("ΕΠΟΜΕΝΕΣ 48 ΩΡΕΣ", "NEXT 48 HOURS")} title={t("Ωριαία πρόγνωση", "Hourly forecast")} icon={CalendarDays} />
            <HourStrip hours={strip} rain={stripRain} text={text} />
            <HourlyCharts hours={upcoming} rain={rain} labels={labels} bands={bands} scan={siteScan} hover={hover} text={text} />
          </section>
          <DaysPanel data={data} observer={observer} now={now} text={text} />
          <TonightPanel night={sky.night} outlook={outlook} inProgress={nightInProgress} moon={sky.moon} text={text} />
          <StormPanel hours={hours} labels={labels} upcoming={upcoming} bands={bands} scan={siteScan} scanNote={scanNote} observer={observer} now={now} hover={hover} text={text} onMap={onMap} />
          <div className="wx-side">
            <MoonPanel moon={sky.moon} next={sky.moonNext} quarters={sky.quarters} now={now} southern={latitude < 0} text={text} />
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

/** The forecast day that is today in Athens; a cached forecast can still start with yesterday. */
const dayNoon = (day: { date: string }) => new Date(Date.parse(day.date) + 12 * HOUR_MS);

const NowPanel = memo(function NowPanel({ data, observer, now, text }: { data: WeatherStationResponse; observer: SavedLocation; now: number; text: Text }) {
  const { t, pick } = text;
  const current = data.current;
  const hour = data.hours.find((item) => Math.abs(Date.parse(item.time) - now) <= 30 * 60_000) ?? null;
  const nextRain = rainNextHour(data.hours, now);
  const today = data.days.find((day) => athensDayDifference(new Date(now), dayNoon(day)) === 0) ?? null;
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
        <Stat icon={Umbrella} label={t("Βροχή επόμενη ώρα", "Rain next hour")} value={`${num(nextRain?.mm, 1)} mm`} hint={`${t("πιθανότητα", "chance")} ${num(nextRain?.chance)}% · ${t("σήμερα", "today")} ${num(today?.precipitationMm, 1)} mm`} />
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

const ObservedPanel = memo(function ObservedPanel({ scan, scanNote, model, now, text }: { scan: OpportunityResponse | null; scanNote: Localized; model: WeatherStationResponse; now: number; text: Text }) {
  const { t, pick } = text;
  const aviation = scan?.aviation;
  const ageMinutes = aviation?.observedAt ? Math.max(0, Math.round((now - Date.parse(aviation.observedAt)) / 60_000)) : null;
  const calm = aviation?.windSpeedKmh === 0;
  const windHint = aviation && !calm
    ? `${aviation.windDirectionDeg != null ? directionLabel(aviation.windDirectionDeg, text.language) : t("μεταβλητός", "variable")}${aviation.windGustKmh != null ? ` · ${t("ριπές", "gusts")} ${aviation.windGustKmh} km/h` : ""}`
    : undefined;
  return (
    <section className="panel wx-observed">
      <PanelHeading eyebrow={t("ΠΡΑΓΜΑΤΙΚΗ ΜΕΤΡΗΣΗ · METAR", "OBSERVED · METAR")} title={t("Πλησιέστερο αεροδρόμιο", "Nearest airport")} icon={Radio} aside={aviation && <span className={`status-dot status-${aviation.status}`} aria-hidden="true" />} />
      {!aviation ? (
        <p className="wx-muted">{pick(scanNote)}</p>
      ) : !aviation.stationId ? (
        <p className="wx-muted">{pick(aviation.message)}</p>
      ) : (
        <>
          <p className="wx-station"><strong>{aviation.stationId}</strong>{aviation.stationName && ` · ${aviation.stationName}`} · {aviation.distanceKm} km{ageMinutes != null && ` · ${t(`πριν ${ageMinutes}′`, `${ageMinutes}′ ago`)}`}</p>
          <div className="wx-stats compact">
            <Stat icon={Thermometer} label={t("Θερμοκρασία", "Temperature")} value={aviation.temperatureC != null ? `${num(aviation.temperatureC)}°` : "—"} hint={`${t("μοντέλο", "model")} ${num(model.current?.temperatureC, 1)}°${aviation.dewPointC != null ? ` · ${t("δρόσος", "dew")} ${num(aviation.dewPointC)}°` : ""}`} />
            <Stat icon={Gauge} label="QNH" value={aviation.pressureHpa != null ? `${num(aviation.pressureHpa, aviation.pressureHpa % 1 ? 1 : 0)} hPa` : "—"} hint={`${t("μοντέλο", "model")} ${num(model.current?.pressureHpa, 1)} hPa`} />
            <Stat icon={Wind} label={t("Άνεμος", "Wind")}
              value={aviation.windSpeedKmh == null ? "—" : calm ? t("Άπνοια", "Calm") : <>{aviation.windSpeedKmh} km/h <WindArrow from={aviation.windDirectionDeg} /></>}
              hint={windHint} tone={(aviation.windGustKmh ?? 0) >= 40 ? "warn" : null} />
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

const HourStrip = memo(function HourStrip({ hours, rain, text }: { hours: StationHour[]; rain: Array<{ mm: number | null; chance: number | null }>; text: Text }) {
  const { t } = text;
  return (
    <div className="wx-hour-strip" role="list" aria-label={t("Επόμενες 24 ώρες", "Next 24 hours")}>
      {hours.map((hour, index) => (
        <div key={hour.time} role="listitem" className={`wx-hour${hour.isDay === false ? " night" : ""}${isStormHour(hour) ? " storm" : ""}`}>
          <span>{text.clock(hour.time)}</span>
          <WeatherGlyph code={hour.weatherCode} isDay={hour.isDay} size={22} />
          <strong>{num(hour.temperatureC)}°</strong>
          <small className="wx-rain" title={t("Πιθανότητα βροχής την ώρα που ξεκινά", "Chance of rain in the hour that starts")}><Umbrella size={11} />{num(rain[index]?.chance)}%</small>
          <small><WindArrow from={hour.windDirectionDeg} size={11} />{num(hour.windSpeedKmh)}</small>
          <small className="wx-cloud-cell"><Cloud size={11} />{num(hour.cloudCover)}%</small>
        </div>
      ))}
    </div>
  );
});

function HourlyCharts({ hours, rain, labels, bands, scan, hover, text }: {
  hours: StationHour[]; rain: Array<{ mm: number | null; chance: number | null }>; labels: TimeLabel[]; bands: TwilightBand[]; scan: OpportunityResponse | null; hover: HoverStore; text: Text;
}) {
  // Built once per data change; a pointer move re-renders only legends and cursors.
  const charts = useMemo(() => {
    const { t } = text;
    const column = <K extends keyof StationHour>(key: K) => hours.map((hour) => hour[key] as number | null);
    const temperature = column("temperatureC");
    const dewPoint = column("dewPointC");
    const apparent = column("apparentTemperatureC");
    const rainMm = rain.map((value) => value.mm);
    const chance = rain.map((value) => value.chance);
    const wind = column("windSpeedKmh");
    const gusts = column("windGustsKmh");
    const pressure = column("pressureHpa");
    const visibility = hours.map((hour) => (hour.visibilityM == null ? null : hour.visibilityM / 1000));
    // The scan's median of the cloud forecasts, matched by hour, and how many forecasts it has.
    const forecast = scan?.observerForecast ?? [];
    const consensusByTime = new Map(forecast.map((hour) => [Date.parse(hour.time), hour.cloudConsensus ?? null]));
    const sources = Math.max(0, ...forecast.map((hour) => (hour.cloudSources ? Object.values(hour.cloudSources).filter((value) => value != null).length : 0)));
    return {
      temperature: {
        left: niceAxis(present([...temperature, ...dewPoint, ...apparent]), { minSpan: 6 }),
        series: [
          { key: "t", label: t("Θερμοκρασία", "Temperature"), values: temperature, color: "#ffa25e", kind: "line", unit: "°", digits: 1 },
          { key: "a", label: t("Αισθητή", "Feels like"), values: apparent, color: "#c7a6ff", kind: "line", unit: "°", digits: 1, dashed: true },
          { key: "d", label: t("Σημείο δρόσου", "Dew point"), values: dewPoint, color: "#6db8e8", kind: "line", unit: "°", digits: 1 },
        ] as ChartSeries[],
      },
      rain: {
        left: niceAxis(present(rainMm), { min: 0, minSpan: 1 }),
        right: { min: 0, max: 100, step: 50 },
        series: [
          { key: "p", label: t("Πιθανότητα", "Chance"), values: chance, color: "#6db8e8", kind: "area", unit: "%", right: true },
          { key: "r", label: t("Ύψος", "Amount"), values: rainMm, color: "#5aa9ff", kind: "bars", unit: " mm", digits: 1 },
        ] as ChartSeries[],
      },
      wind: {
        left: niceAxis(present([...wind, ...gusts]), { min: 0, minSpan: 20 }),
        series: [
          { key: "w", label: t("Μέση ταχύτητα", "Speed"), values: wind, color: "#7de4ca", kind: "line", unit: " km/h" },
          { key: "g", label: t("Ριπές", "Gusts"), values: gusts, color: "#e5ad55", kind: "line", unit: " km/h", dashed: true },
        ] as ChartSeries[],
        arrows: <div className="wx-arrow-row">{hours.map((hour, i) => i % 3 === 0 && <span key={hour.time} style={{ left: `${((i + 0.5) / hours.length) * 100}%` }}><WindArrow from={hour.windDirectionDeg} size={12} /></span>)}</div>,
      },
      cloudRows: [
        { label: t("Υψηλά", "High"), values: column("cloudCoverHigh") },
        { label: t("Μέσα", "Mid"), values: column("cloudCoverMid") },
        { label: t("Χαμηλά", "Low"), values: column("cloudCoverLow") },
        ...(sources >= 2 ? [{ label: t(`${sources} πηγές`, `${sources} sources`), values: hours.map((hour) => consensusByTime.get(Date.parse(hour.time)) ?? null) }] : []),
      ],
      pressure: {
        left: niceAxis(present(pressure), { minSpan: 6 }),
        series: [{ key: "p", label: t("Πίεση θάλασσας", "Sea-level pressure"), values: pressure, color: "#c7a6ff", kind: "line", unit: " hPa", digits: 1 }] as ChartSeries[],
      },
      visibility: {
        left: niceAxis(present(visibility), { min: 0, minSpan: 10 }),
        series: [{ key: "v", label: t("Ορατότητα", "Visibility"), values: visibility, color: "#9fd6ff", kind: "line", unit: " km", digits: 1 }] as ChartSeries[],
      },
    };
  }, [hours, rain, scan, text]);
  const { t } = text;
  const shared = { labels, bands, hover, text };
  return (
    <div className="wx-charts">
      <TimeChart {...shared} title={t("Θερμοκρασία", "Temperature")} icon={Thermometer} leftUnit="°" left={charts.temperature.left} series={charts.temperature.series}
        footer={<p className="wx-chart-note">{t("Όπου η θερμοκρασία πλησιάζει το σημείο δρόσου (κάτω από ~2 °C), ο φακός θολώνει από υγρασία.", "Where the temperature nears the dew point (within ~2 °C), dew forms on the lens.")}</p>}
      />
      <TimeChart {...shared} title={t("Βροχή", "Rain")} icon={Umbrella} leftUnit=" mm" rightUnit="%" left={charts.rain.left} right={charts.rain.right} series={charts.rain.series}
        footer={<p className="wx-chart-note">{t("Κάθε ώρα δείχνει τη βροχή της ώρας που ξεκινά τότε.", "Each hour shows the rain in the hour that starts then.")}</p>}
      />
      <TimeChart {...shared} title={t("Άνεμος", "Wind")} icon={Wind} leftUnit="" left={charts.wind.left} series={charts.wind.series} footer={charts.wind.arrows} />
      <CloudStrip {...shared} rows={charts.cloudRows} />
      <TimeChart {...shared} title={t("Ατμοσφαιρική πίεση", "Pressure")} icon={Gauge} leftUnit="" left={charts.pressure.left} series={charts.pressure.series} />
      <TimeChart {...shared} title={t("Ορατότητα", "Visibility")} icon={Eye} leftUnit=" km" left={charts.visibility.left} series={charts.visibility.series} />
    </div>
  );
}

const DaysPanel = memo(function DaysPanel({ data, observer, now, text }: { data: WeatherStationResponse; observer: SavedLocation; now: number; text: Text }) {
  const { t, pick } = text;
  // Days are labelled by the calendar: a forecast fetched before midnight still starts with yesterday.
  const days = data.days
    .map((day) => ({ day, noon: dayNoon(day), offset: athensDayDifference(new Date(now), dayNoon(day)) }))
    .filter((entry) => entry.offset >= 0);
  const lows = present(days.map(({ day }) => day.temperatureMinC));
  const highs = present(days.map(({ day }) => day.temperatureMaxC));
  const floor = lows.length ? Math.min(...lows) : 0;
  const ceiling = highs.length ? Math.max(...highs) : 1;
  const span = Math.max(1, ceiling - floor);
  return (
    <section className="panel wx-span-2">
      <PanelHeading eyebrow={t("7 ΗΜΕΡΕΣ", "7 DAYS")} title={t("Πρόγνωση εβδομάδας", "Week ahead")} icon={CalendarDays} />
      <div className="wx-days">
        {days.map(({ day, noon, offset }) => {
          const sun = sunDay(noon, observer.latitude, observer.longitude);
          const moon = moonDay(noon, observer.latitude, observer.longitude);
          const info = weatherCodeInfo(day.weatherCode);
          const uv = uvLevel(day.uvIndexMax);
          const low = day.temperatureMinC;
          const high = day.temperatureMaxC;
          return (
            <div key={day.date} className="wx-day">
              <span className="wx-day-name"><strong>{offset === 0 ? t("Σήμερα", "Today") : offset === 1 ? t("Αύριο", "Tomorrow") : text.weekday(noon.getTime())}</strong><small>{offset < 2 ? text.day(noon) : text.date(noon)}</small></span>
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
    return <section className="panel wx-tonight"><PanelHeading eyebrow={t("ΑΠΟΨΕ", "TONIGHT")} title={t("Απόψε για φωτογράφιση", "Tonight for photography")} icon={Telescope} /><p className="wx-muted">{t("Δεν υπάρχει νύχτα στο διάστημα της πρόγνωσης.", "No night falls within the forecast.")}</p></section>;
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

/** Today's Sun by band, from Athens midnight to midnight: 23 or 25 hours when the clocks change. */
function TwilightBar({ now, text, latitude, longitude }: { now: number; text: Text; latitude: number; longitude: number }) {
  const { t } = text;
  const { start, end } = athensDayBounds(new Date(now));
  const length = end.getTime() - start.getTime();
  const at = (ms: number) => ((ms - start.getTime()) / length) * 100;
  const step = 10 * 60_000;
  const samples = Math.round(length / step);
  const stops: string[] = [];
  let previous: TwilightBand | null = null;
  let first = 0;
  for (let i = 0; i <= samples; i += 1) {
    const band = i < samples ? twilightBand(sunAltitudeDeg(new Date(start.getTime() + i * step + step / 2), latitude, longitude)) : null;
    if (band !== previous) {
      if (previous) stops.push(`${BAND_COLOR[previous]} ${((first / samples) * 100).toFixed(2)}% ${((i / samples) * 100).toFixed(2)}%`);
      previous = band;
      first = i;
    }
  }
  // 06, 12 and 18 o'clock local time; on a day the clocks change, they sit an hour off the six-hour marks.
  const marks = [6, 12, 18].map((hour) => {
    const guess = start.getTime() + hour * HOUR_MS;
    const ms = [guess, guess - HOUR_MS, guess + HOUR_MS].find((candidate) => text.hourOf(candidate) === hour) ?? guess;
    return { hour, left: at(ms) };
  });
  return (
    <div className="wx-twilight">
      <div className="wx-twilight-bar" style={{ background: `linear-gradient(to right, ${stops.join(", ")})` }} role="img" aria-label={t("Ήλιος και λυκόφωτα σήμερα", "Sun and twilight today")}>
        <i style={{ left: `${at(now)}%` }} title={t("τώρα", "now")} />
      </div>
      <div className="wx-twilight-scale">
        <span style={{ left: "0%" }}>00</span>
        {marks.map((mark) => <span key={mark.hour} style={{ left: `${mark.left}%` }}>{String(mark.hour).padStart(2, "0")}</span>)}
        <span style={{ left: "100%" }}>24</span>
      </div>
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

const MoonPanel = memo(function MoonPanel({ moon, next, quarters, now, southern, text }: {
  moon: ReturnType<typeof moonDay>; next: ReturnType<typeof nextMoonRiseSet>; quarters: ReturnType<typeof nextMoonQuarters>; now: number; southern: boolean; text: Text;
}) {
  const { t, pick } = text;
  const when = (event: Date | null) => (event ? `${text.relativeDay(event, now)} ${text.clock(event)}` : "—");
  return (
    <section className="panel wx-moon-panel">
      <PanelHeading eyebrow={t("ΣΕΛΗΝΗ", "MOON")} title={t("Φάση και ορατότητα", "Phase and visibility")} icon={MoonStar} />
      <div className="wx-moon-main">
        <MoonGlyph fraction={moon.fraction} waxing={moon.waxing} size={92} southern={southern} />
        <div>
          <strong>{pick(MOON_PHASE_TEXT[moon.name])}</strong>
          <span>{t("Φωτισμός", "Illuminated")} {Math.round(moon.fraction * 100)}% · {t("ηλικία", "age")} {num(moon.ageDays, 1)} / {num(SYNODIC_MONTH_DAYS, 1)} {t("ημ.", "d")}</span>
          <span>{moon.altitudeDeg > 0 ? t(`Πάνω από τον ορίζοντα, ${num(moon.altitudeDeg)}° ύψος προς ${directionLabel(moon.azimuthDeg, "el")}`, `Above the horizon, ${num(moon.altitudeDeg)}° high to the ${directionLabel(moon.azimuthDeg, "en")}`) : t("Κάτω από τον ορίζοντα", "Below the horizon")}</span>
          <span className="wx-moon-times"><Moon size={13} />{t("Ανατέλλει", "Rises")} <strong>{when(next.rise)}</strong> · {t("Δύει", "Sets")} <strong>{when(next.set)}</strong></span>
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
              <small>{text.relativeDay(quarter.at, now)}</small>
            </div>
          );
        })}
      </div>
      <p className="data-note"><Moon size={15} />{t("Η Σελήνη πάνω από τον ορίζοντα, φωτισμένη πάνω από 55 % και κοντά στην κατεύθυνση του στόχου, μειώνει τον δείκτη ευκαιρίας. Οι νύχτες κοντά στη Νέα Σελήνη είναι οι πιο σκοτεινές.", "A Moon above the horizon, more than 55 % lit and near the target's direction, lowers the opportunity index. Nights near New Moon are the darkest.")}</p>
    </section>
  );
});

const STATUS_TONE: Record<LocalStormStatus, Level["tone"]> = {
  lightning_close: "bad",
  lightning_near: "warn",
  thunder: "warn",
  rain_unstable: "fair",
  unstable: "fair",
  quiet: "good",
};

function StormPanel({ hours, labels, upcoming, bands, scan, scanNote, observer, now, hover, text, onMap }: {
  hours: StationHour[]; labels: TimeLabel[]; upcoming: StationHour[]; bands: TwilightBand[]; scan: OpportunityResponse | null; scanNote: Localized;
  observer: SavedLocation; now: number; hover: HoverStore; text: Text; onMap: () => void;
}) {
  const { t, pick } = text;
  const periods = useMemo(() => stormPeriods(hours, now), [hours, now]);
  const lightning = useMemo(() => (scan?.lightning?.status === "available" ? nearestLightning(observer, scan.lightning.clusters) : null), [scan, observer]);
  const day = upcoming.filter((hour) => Date.parse(hour.time) <= now + 24 * HOUR_MS);
  const capes = present(day.map((hour) => hour.capeJkg));
  const capeMax = capes.length ? Math.max(...capes) : null;
  const lifted = present(day.map((hour) => hour.liftedIndex));
  const liMin = lifted.length ? Math.min(...lifted) : null;
  const cin = valueNear(hours, now, (hour) => hour.convectiveInhibitionJkg);
  const cape = capeLevel(capeMax);
  const li = liftedIndexLevel(liMin);
  const cinText = cinLevel(cin);
  const stormHours = upcoming.filter(isStormHour).length;
  const status = localStormStatus({ periods, lightningKm: lightning?.distanceKm ?? null, capeMax, liftedMin: liMin });
  // The frame time, not the scan's age, so the minutes keep counting between scans.
  const ageMinutes = lightning ? Math.max(0, Math.round((now - Date.parse(lightning.cluster.observedAt)) / 60_000)) : 0;
  const lightningDetail = lightning ? t(
    `Ο δορυφόρος MTG-LI κατέγραψε κεραυνούς πριν από ${ageMinutes}′ σε καταιγίδα με κέντρο ${Math.round(lightning.centerKm)} km ${directionLabel(lightning.bearingDeg, "el")} και έκταση ~${lightning.cluster.radiusKm} km γύρω του${lightning.distanceKm === 0 ? ": η θέση σου είναι μέσα στην περιοχή της" : ""}. Η θέση των κεραυνών έχει αβεβαιότητα ~10–15 km.`,
    `MTG-LI recorded lightning ${ageMinutes}′ ago in a storm centred ${Math.round(lightning.centerKm)} km ${directionLabel(lightning.bearingDeg, "en")} and spreading ~${lightning.cluster.radiusKm} km around it${lightning.distanceKm === 0 ? ": your site is inside its area" : ""}. Lightning positions are uncertain by ~10–15 km.`,
  ) : "";
  const periodText = periods.slice(0, 3).map((period) => `${text.weekday(Date.parse(period.start))} ${text.clock(period.start)}${period.end !== period.start ? `–${text.clock(Date.parse(period.end) + HOUR_MS)}` : ""}`).join(" · ");
  const distance = lightning ? Math.round(lightning.distanceKm) : 0;
  const towards = (language: Language) => (lightning ? directionLabel(lightning.bearingDeg, language) : "");
  const message: Record<LocalStormStatus, { title: string; detail: string }> = {
    lightning_close: {
      title: lightning?.distanceKm === 0
        ? t("Κεραυνοί γύρω από τη θέση σου", "Lightning around your site")
        : t(`Κεραυνοί πολύ κοντά, ~${distance} km προς ${towards("el")}`, `Lightning very close, ~${distance} km to the ${towards("en")}`),
      detail: lightningDetail,
    },
    lightning_near: { title: t(`Κεραυνοί σε ~${distance} km προς ${towards("el")}`, `Lightning ~${distance} km to the ${towards("en")}`), detail: lightningDetail },
    thunder: { title: t("Το μοντέλο δίνει καταιγίδα στη θέση σου", "The model gives a thunderstorm at your site"), detail: periodText },
    rain_unstable: { title: t("Το μοντέλο δίνει βροχή με αστάθεια στη θέση σου", "The model gives rain with instability at your site"), detail: periodText },
    unstable: {
      title: t("Ασταθής ατμόσφαιρα, χωρίς καταιγίδα στο μοντέλο", "Unstable air, but no storm in the model"),
      detail: t(
        `CAPE έως ${num(capeMax)} J/kg και lifted index ${num(liMin, 1)}: μπορεί να αναπτυχθούν καταιγίδες που το μοντέλο δεν δείχνει, συνήθως το απόγευμα. Έλεγχε τον ζωντανό χάρτη.`,
        `CAPE up to ${num(capeMax)} J/kg and a lifted index of ${num(liMin, 1)}: storms the model does not show can still grow, usually in the afternoon. Keep an eye on the live map.`,
      ),
    },
    quiet: {
      title: t("Καμία καταιγίδα στη θέση σου τις επόμενες 48 ώρες", "No storm at your site in the next 48 hours"),
      detail: t("Σύμφωνα με το μοντέλο· οι καταιγίδες-στόχοι για sprites βρίσκονται 100–300 km μακριά.", "According to the model; target storms for sprites are 100–300 km away."),
    },
  };
  const StatusIcon = status === "quiet" ? ShieldCheck : status === "unstable" || status === "rain_unstable" ? AlertTriangle : Zap;
  const capeChart = useMemo(() => {
    const values = upcoming.map((hour) => hour.capeJkg);
    return {
      left: niceAxis(present(values), { min: 0, minSpan: 500 }),
      series: [{ key: "c", label: "CAPE", values, color: "#6db8e8", kind: "bars", unit: " J/kg", barColors: upcoming.map((hour) => (isStormHour(hour) ? "#f04362" : (hour.capeJkg ?? 0) >= 1000 ? "#e5ad55" : "#6db8e8")) }] as ChartSeries[],
    };
  }, [upcoming]);
  // The provider's order: nearby first, then the most severe, thunderstorms first.
  const alerts = scan?.weatherAlerts.alerts ?? [];
  return (
    <section className="panel wx-storm wx-span-2">
      <PanelHeading eyebrow={t("ΚΑΤΑΙΓΙΔΕΣ & ΑΣΦΑΛΕΙΑ ΕΔΩ", "LOCAL STORMS & SAFETY")} title={t("Αστάθεια και προειδοποιήσεις", "Instability and warnings")} icon={Zap} />
      <div className={`wx-alert-box tone-${STATUS_TONE[status]}`}>
        <StatusIcon size={19} />
        <div><strong>{message[status].title}</strong><p>{message[status].detail}</p></div>
      </div>
      <div className="wx-stats compact">
        <Stat icon={Zap} label={t("CAPE (μέγ. 24ώρου)", "CAPE (24 h max)")} value={capeMax != null ? `${num(capeMax)} J/kg` : "—"} hint={cape ? pick(cape.text) : undefined} tone={cape && cape.level >= 2 ? cape.tone : null} />
        <Stat icon={Gauge} label={t("Lifted index (ελάχ.)", "Lifted index (min)")} value={num(liMin, 1)} hint={li ? pick(li.text) : undefined} tone={li && li.level >= 1 ? li.tone : null} />
        <Stat icon={ShieldAlert} label={t("Αναστολή (CIN)", "Inhibition (CIN)")} value={cin != null ? `${num(cin)} J/kg` : "—"} hint={cinText ? pick(cinText.text) : undefined} />
        <Stat icon={CloudLightning} label={t("Ώρες καταιγίδας (48 ώ)", "Storm hours (48 h)")} value={String(stormHours)} hint={periods.length ? `${t("πρώτη", "first")} ${text.weekday(Date.parse(periods[0].start))} ${text.clock(periods[0].start)}` : t("καμία στη θέση σου", "none at your site")} tone={stormHours ? "warn" : null} />
      </div>
      <TimeChart title={t("Ενέργεια αστάθειας CAPE", "Instability energy (CAPE)")} icon={Zap} labels={labels} bands={bands} hover={hover} text={text} leftUnit="" left={capeChart.left} series={capeChart.series}
        footer={<p className="wx-chart-note"><i className="wx-key-dot" style={{ background: "#f04362" }} />{t("ώρα με καταιγίδα ή βροχή με αστάθεια", "hour with a storm, or rain with instability")} <i className="wx-key-dot" style={{ background: "#e5ad55" }} />CAPE ≥ 1000</p>}
      />
      <div className="wx-warnings">
        <span className="eyebrow">{t("METEOALARM · ΠΡΟΕΙΔΟΠΟΙΗΣΕΙΣ", "METEOALARM · WARNINGS")}</span>
        {!scan ? <p className="wx-muted">{pick(scanNote)}</p>
          : scan.weatherAlerts.status !== "available" && !alerts.length ? <p className="wx-muted">{pick(scan.weatherAlerts.message)}</p>
            : alerts.length ? <div className="alert-chips">{alerts.slice(0, 6).map((alert) => {
              const label = alertText(alert);
              return (
                <a key={alert.id} href={alert.link} target="_blank" rel="noreferrer">
                  <b className={`level-${alert.level ?? "unknown"}`}>{label.level ? pick(label.level) : alert.severity}</b>{pick(label.hazard)} · {alert.area}{alert.distanceKm != null && ` · ${Math.round(alert.distanceKm)} km`}{alert.expires && ` · ${t("έως", "until")} ${text.day(alert.expires)} ${text.clock(alert.expires)}`}
                </a>
              );
            })}</div>
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

function AirPanel({ air, now, latitude, longitude, hover, text }: { air: WeatherStationResponse["airQuality"] | null; now: number; latitude: number; longitude: number; hover: HoverStore; text: Text }) {
  const { t, pick } = text;
  const chart = useMemo(() => {
    if (!air || air.status !== "available") return null;
    const coming = air.hours.filter((hour) => Date.parse(hour.time) >= now - 30 * 60_000).slice(0, CHART_HOURS);
    const times = coming.map((hour) => Date.parse(hour.time));
    const values = coming.map((hour) => hour.europeanAqi);
    return {
      labels: timeLabels(times, text),
      bands: times.map((ms) => twilightBand(sunAltitudeDeg(new Date(ms), latitude, longitude))),
      left: niceAxis(present(values), { min: 0, minSpan: 60 }),
      series: [{ key: "aqi", label: "AQI", values, color: "#50ccaa", kind: "bars", unit: "", barColors: coming.map((hour) => { const band = aqiLevel(hour.europeanAqi); return band ? AQI_COLORS[band.level] : null; }) }] as ChartSeries[],
    };
  }, [air, now, latitude, longitude, text]);
  if (!air || air.status !== "available" || !chart) {
    return <section className="panel wx-span-2"><PanelHeading eyebrow={t("ΠΟΙΟΤΗΤΑ ΑΕΡΑ · CAMS", "AIR QUALITY · CAMS")} title={t("Ποιότητα αέρα και ρύπανση", "Air quality and pollution")} icon={Factory} /><p className="wx-muted">{air ? pick(air.message) : "—"}</p></section>;
  }
  const current = air.current ?? air.hours.find((hour) => Math.abs(Date.parse(hour.time) - now) <= 30 * 60_000) ?? null;
  const level = aqiLevel(current?.europeanAqi ?? null);
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
      <TimeChart title={t("Ευρωπαϊκός δείκτης ποιότητας αέρα", "European air quality index")} icon={Factory} labels={chart.labels} bands={chart.bands} hover={hover} text={text} leftUnit="" left={chart.left} series={chart.series} />
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
  // Stored sites are not checked for this field: anything unexpected reads as not set.
  const level = Object.hasOwn(LIGHT_POLLUTION, observer.lightPollution) ? observer.lightPollution : "unknown";
  const info = LIGHT_POLLUTION[level];
  const mapUrl = `https://www.lightpollutionmap.info/#zoom=9.00&lat=${observer.latitude.toFixed(4)}&lon=${observer.longitude.toFixed(4)}`;
  return (
    <section className="panel wx-light">
      <PanelHeading eyebrow={t("ΦΩΤΟΡΥΠΑΝΣΗ", "LIGHT POLLUTION")} title={t("Φωτεινότητα ουρανού", "Sky brightness")} icon={Lightbulb} />
      <div className={`wx-bortle level-${level}`}><strong>{info.bortle}</strong><span>{t("όπως δηλώθηκε για τη θέση", "as set for the site")}</span></div>
      <p className="wx-muted">{pick(info.text)}</p>
      <div className="wx-light-actions">
        <a className="secondary-action" href={mapUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />{t("Χάρτης φωτορύπανσης", "Light pollution map")}</a>
        <button className="secondary-action" onClick={onLocations}><MapPin size={15} />{t("Αλλαγή στις Θέσεις", "Change in Locations")}</button>
      </div>
      <p className="data-note"><Lightbulb size={15} />{t("Δεν υπάρχει ελεύθερη πηγή μετρήσεων φωτορύπανσης χωρίς κλειδί· ο χάρτης (VIIRS / World Atlas) δείχνει την περιοχή σου.", "There is no free keyless source of light-pollution readings; the map (VIIRS / World Atlas) shows your area.")}</p>
    </section>
  );
});
