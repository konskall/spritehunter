"use client";
/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- small pre-sized brand PNGs and a live third-party NOAA image that must not be re-encoded */

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type InputHTMLAttributes } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  BookOpen,
  CalendarClock,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Compass,
  Crosshair,
  Database,
  Download,
  ExternalLink,
  Eye,
  Gauge,
  LayoutDashboard,
  LocateFixed,
  Map as MapIcon,
  MapPin,
  Moon,
  Mountain,
  Navigation,
  Orbit,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  ShieldAlert,
  Sparkles,
  Trash2,
  Wind,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type {
  AuroraResponse,
  CgLightning,
  DataStatus,
  EumetsatMetadata,
  LensProfile,
  LogEntry,
  OpportunityResponse,
  SavedLocation,
  StormCandidate,
  TerrainProfile,
} from "@/lib/domain";
import { CANON_750D, DEFAULT_LENSES, effectiveMaxAperture, fieldOfView, framingAssessment, photoRecommendation } from "@/lib/camera";
import { angularDifference, inverseGeodesic } from "@/lib/geodesy";
import { skyState } from "@/lib/astronomy";
import { terrainBearingKey, terrainVisibility } from "@/lib/terrain";
import { followSelection } from "@/lib/selection";
import { createId } from "@/lib/utils";
import { formatAthens, formatAthensTime } from "@/lib/time";
import { magneticDeclination, normalizeBearing } from "@/lib/wmm";
import { cameraPointing } from "@/lib/orientation";
import { parseNumericDraft } from "@/lib/number-input";
import { rescoreWithTerrain } from "@/lib/scoring";
import { evaluateAlert, type AlertPreferences } from "@/lib/notifications";
import { isAlertPrefs, isLanguage, isLastAlert, isLensList, isLocationList, isLogEntry, isLogList, isOrientation, isSavedLocation, isSearchRange, isString } from "@/lib/persisted-validators";
import { PwaInstallButton } from "@/components/PwaRegister";
import { tx, type Language, type Localized } from "@/lib/i18n";
import { APP_VERSION } from "@/lib/version";
import { CREATOR, LANGUAGE_PATHS, SEO_COPY } from "@/lib/seo-copy";

const StormMap = dynamic(() => import("@/components/StormMap"), { ssr: false });

type Screen = "dashboard" | "map" | "forecast" | "point" | "sky" | "aurora" | "locations" | "camera" | "logbook" | "alerts" | "settings";

const LanguageContext = createContext<Language>("el");

/** `t(greek, english)` for UI text and `pick()` for server text that comes in both languages. */
function useI18n() {
  const language = useContext(LanguageContext);
  return {
    language,
    t: (el: string, en: string) => (language === "el" ? el : en),
    pick: (text: Localized | null | undefined) => (text ? text[language] : ""),
    locale: language === "el" ? "el-GR" : "en-GB",
  };
}

const L = (language: Language, el: string, en: string) => (language === "el" ? el : en);

interface RadarMetadata {
  host: string;
  generated: number;
  radar: { past: Array<{ time: number; path: string }> };
}

const DEFAULT_LOCATION: SavedLocation = {
  id: "sparta-home",
  name: "Σπάρτη — προεπιλεγμένη θέση",
  latitude: 37.075,
  longitude: 22.43,
  elevationM: 210,
  cameraHeightM: 1.6,
  favorite: true,
  lightPollution: "medium",
  notes: "Προσεγγιστικές συντεταγμένες πόλης. Αντικατάστησέ τες με την ακριβή θέση σου.",
  safetyNotes: "Επιβεβαίωσε την πρόσβαση και την ασφάλεια πριν από νυχτερινή παρατήρηση.",
};

const DEFAULT_SITE_TEXT = {
  name: tx("Σπάρτη — προεπιλεγμένη θέση", "Sparta — default site"),
  safetyNotes: tx("Επιβεβαίωσε την πρόσβαση και την ασφάλεια πριν από νυχτερινή παρατήρηση.", "Check access and safety before a night session."),
};

/** The built-in site's untouched texts in the visitor's language; anything the user typed stays as is. */
function localizeSite(site: SavedLocation, language: Language): SavedLocation {
  if (site.id !== DEFAULT_LOCATION.id) return site;
  const text = (value: string, localized: Localized) => (value === localized.el || value === localized.en ? localized[language] : value);
  return { ...site, name: text(site.name, DEFAULT_SITE_TEXT.name), safetyNotes: text(site.safetyNotes, DEFAULT_SITE_TEXT.safetyNotes) };
}

const navItems: Array<{ id: Screen; label: string; labelEn: string; icon: LucideIcon }> = [
  { id: "dashboard", label: "Παρατηρητήριο", labelEn: "Dashboard", icon: LayoutDashboard },
  { id: "map", label: "Ζωντανός χάρτης", labelEn: "Storm map", icon: MapIcon },
  { id: "forecast", label: "Πρόγνωση", labelEn: "Forecast", icon: CalendarClock },
  { id: "point", label: "Στόχευση", labelEn: "Point camera", icon: Crosshair },
  { id: "sky", label: "Ορίζοντας", labelEn: "Sky view", icon: Orbit },
  { id: "aurora", label: "Σέλας", labelEn: "Aurora", icon: Sparkles },
  { id: "locations", label: "Θέσεις", labelEn: "Locations", icon: MapPin },
  { id: "camera", label: "Εξοπλισμός", labelEn: "Camera setup", icon: Camera },
  { id: "logbook", label: "Ημερολόγιο", labelEn: "Logbook", icon: BookOpen },
  { id: "alerts", label: "Ειδοποιήσεις", labelEn: "Alerts", icon: Bell },
  { id: "settings", label: "Πηγές & ρυθμίσεις", labelEn: "Data & settings", icon: Settings },
];

const DEFAULT_ALERT_PREFS: AlertPreferences = { minimumScore: 60, confidence: "medium", cooldown: 90, quietStart: "01:00", quietEnd: "08:00" };
// Without observed lightning the score is capped at 69; only MTG-LI storms can go higher.
const MAX_FORECAST_SCORE = 69;
const AUTO_REFRESH_MS = 15 * 60_000;
// Phones pause timers in the background; back on screen, older data is rescanned at once.
const RETURN_REFRESH_MS = 5 * 60_000;
const LOCATION_DEBOUNCE_MS = 700;

function safeRead<T>(key: string, fallback: T, validate?: (value: unknown) => value is T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    if (!value) return fallback;
    const parsed: unknown = JSON.parse(value);
    // Invalid stored state (e.g. a mistyped latitude) must not keep the app broken after reload.
    return !validate || validate(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

const LANGUAGE_CHOICE_KEY = "spritehunter.language-choice";
// Older versions stored the language on every visit, so only a stored "en" was a real choice.
const LEGACY_LANGUAGE_KEY = "spritehunter.language";

/**
 * The page's own language (/ or /en) unless the visitor has picked one. The address bar,
 * <html lang>, title and description follow the language on screen, so a shared link
 * and a reload show the same language.
 */
function useLanguage(initial: Language) {
  const [language, setLanguage] = useState(initial);
  useEffect(() => {
    const choice = safeRead<Language | null>(LANGUAGE_CHOICE_KEY, null, isLanguage)
      ?? (safeRead<Language | null>(LEGACY_LANGUAGE_KEY, null, isLanguage) === "en" ? "en" : null);
    if (choice) setLanguage(choice);
  }, []);
  useEffect(() => {
    const copy = SEO_COPY[language];
    document.documentElement.lang = language;
    document.title = copy.title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", copy.description);
    const path = LANGUAGE_PATHS[language];
    if (window.location.pathname !== path) window.history.replaceState(null, "", `${path}${window.location.search}${window.location.hash}`);
  }, [language]);
  const choose = useCallback((next: Language) => {
    setLanguage(next);
    try { window.localStorage.setItem(LANGUAGE_CHOICE_KEY, JSON.stringify(next)); } catch { /* Storage can be disabled. */ }
  }, []);
  return [language, choose] as const;
}

/** localStorage-backed state; `hydrated` turns true once the stored value has been read. */
function usePersistedState<T>(key: string, fallback: T, validate?: (value: unknown) => value is T) {
  const [state, setState] = useState({ value: fallback, hydrated: false });
  const fallbackRef = useRef(fallback);
  const validateRef = useRef(validate);
  useEffect(() => setState({ value: safeRead(key, fallbackRef.current, validateRef.current), hydrated: true }), [key]);
  useEffect(() => {
    if (!state.hydrated) return;
    try { window.localStorage.setItem(key, JSON.stringify(state.value)); } catch { /* Storage can be disabled. */ }
  }, [key, state]);
  const setValue = useCallback((next: T | ((current: T) => T)) => {
    setState((current) => ({ hydrated: current.hydrated, value: typeof next === "function" ? (next as (current: T) => T)(current.value) : next }));
  }, []);
  return [state.value, setValue, state.hydrated] as const;
}

type NumberFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "min" | "max"> & {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  isValid?: (value: number) => boolean;
};

/**
 * Keeps the typed text separate from the committed number, so intermediate input such
 * as "38." or "-" is not coerced to 0 (which previously turned "38.2466" into 2466).
 */
function NumberField({ value, onCommit, min, max, isValid, onFocus, onBlur, ...rest }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const parse = (text: string) => {
    const parsed = parseNumericDraft(text, min, max);
    return parsed != null && (!isValid || isValid(parsed)) ? parsed : null;
  };
  const invalid = draft != null && parse(draft) == null;
  return (
    <input
      {...rest}
      type="text"
      inputMode={min != null && min < 0 ? "text" : "decimal"}
      autoComplete="off"
      value={draft ?? String(value)}
      aria-invalid={invalid || undefined}
      onFocus={(event) => { setDraft(String(value)); onFocus?.(event); }}
      onBlur={(event) => { setDraft(null); onBlur?.(event); }}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = parse(event.target.value);
        if (parsed != null && parsed !== value) onCommit(parsed);
      }}
    />
  );
}

function relativeHours(iso: string, now: number, language: Language) {
  const hours = Math.round((new Date(iso).getTime() - now) / 3_600_000);
  if (hours <= 0) return L(language, "τώρα", "now");
  if (hours === 1) return L(language, "σε 1 ώρα", "in 1 hour");
  return L(language, `σε ${hours} ώρες`, `in ${hours} hours`);
}

async function showBrowserNotification(title: string, body: string) {
  const options = { body, icon: "/spritehunter-icon-192.png", tag: "spritehunter-opportunity" };
  try {
    // Android Chrome only allows notifications through a service worker registration.
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) {
      await registration.showNotification(title, options);
      return;
    }
    new Notification(title, options);
  } catch { /* Notifications can be blocked by the platform. */ }
}

function directionLabel(degrees: number, language: Language) {
  const greek = ["Β", "ΒΒΑ", "ΒΑ", "ΑΒΑ", "Α", "ΑΝΑ", "ΝΑ", "ΝΝΑ", "Ν", "ΝΝΔ", "ΝΔ", "ΔΝΔ", "Δ", "ΔΒΔ", "ΒΔ", "ΒΒΔ"];
  const english = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return (language === "el" ? greek : english)[Math.round(degrees / 22.5) % 16];
}

function categoryLabel(candidate: StormCandidate | null, language: Language) {
  if (!candidate) return L(language, "Δεν εντοπίστηκε κατάλληλη ευκαιρία τώρα", "No suitable opportunity right now");
  const labels = language === "el"
    ? { poor: "Φτωχές συνθήκες", low: "Χαμηλή ευκαιρία", possible: "Πιθανή ευκαιρία", promising: "Υποσχόμενη", very_promising: "Πολύ υποσχόμενη" }
    : { poor: "Poor conditions", low: "Low opportunity", possible: "Possible opportunity", promising: "Promising", very_promising: "Very promising" };
  return labels[candidate.score.category];
}

const areaText = (km2: number, language: Language) => Math.round(km2).toLocaleString(language === "el" ? "el-GR" : "en-GB");

/** Short Xweather CG summary, e.g. "+CG 3 (έως +87 kA)". */
function cgLine(cg: CgLightning | null | undefined, language: Language) {
  if (!cg) return null;
  if (cg.positiveCount) return `+CG ${cg.positiveCount}${cg.maxPositiveKa != null ? ` (${L(language, "έως", "up to")} +${cg.maxPositiveKa} kA)` : ""}`;
  return cg.cgCount ? L(language, `μόνο −CG (${cg.cgCount})`, `only −CG (${cg.cgCount})`) : L(language, "χωρίς CG", "no CG");
}

function lightningLine(candidate: StormCandidate, language: Language) {
  const detail = candidate.observedLightning;
  if (!detail) return null;
  const cg = cgLine(detail.cg, language);
  return `MTG-LI ~${areaText(detail.areaKm2, language)} km² · ${L(language, `πριν ${detail.ageMinutes}′`, `${detail.ageMinutes}′ ago`)}${cg ? ` · ${cg}` : ""}`;
}

function targetTitle(candidate: StormCandidate, language: Language) {
  // With the distance, two storms in the same direction get different titles.
  const direction = `${directionLabel(candidate.bearingDeg, language)} · ${Math.round(candidate.distanceKm)} km`;
  if (candidate.source === "observed") return L(language, `Παρατηρημένη καταιγίδα προς ${direction}`, `Observed storm to the ${direction}`);
  return candidate.scoreInput.lightning === "observed"
    ? L(language, `Επιβεβαιωμένη κυψέλη προς ${direction}`, `Confirmed cell to the ${direction}`)
    : L(language, `Προγνωστική κυψέλη προς ${direction}`, `Forecast cell to the ${direction}`);
}

function targetDescription(candidate: StormCandidate, language: Language) {
  const detail = candidate.observedLightning;
  if (detail) {
    const area = areaText(detail.areaKm2, language);
    const lit = L(language,
      `Ο δορυφόρος MTG-LI καταγράφει κεραυνούς σε ~${area} km² εκεί (τελευταία πριν από ${detail.ageMinutes}′, σε ${detail.frames} από ${detail.windowMinutes / 5} πεντάλεπτα).`,
      `The MTG-LI satellite records lightning over ~${area} km² there (latest ${detail.ageMinutes}′ ago, in ${detail.frames} of ${detail.windowMinutes / 5} five-minute frames).`);
    const cg = detail.cg;
    if (!cg) return `${lit} ${L(language, "Η καταιγίδα είναι πραγματική· το MTG-LI όμως δεν διακρίνει +CG ή πολικότητα.", "The storm is real, but MTG-LI cannot tell +CG strokes or polarity.")}`;
    if (cg.positiveCount) {
      const strongest = cg.maxPositiveKa != null ? L(language, `, τον ισχυρότερο στα +${cg.maxPositiveKa} kA`, `, the strongest at +${cg.maxPositiveKa} kA`) : "";
      return `${lit} ${L(language,
        `Το Xweather μετρά ${cg.positiveCount} θετικούς κεραυνούς +CG τα τελευταία ${cg.windowMinutes}′${strongest}: αυτοί προκαλούν τα sprites.`,
        `Xweather counts ${cg.positiveCount} positive +CG strokes in the last ${cg.windowMinutes}′${strongest}: these trigger sprites.`)}`;
    }
    return `${lit} ${L(language,
      `Το Xweather δεν βρίσκει θετικούς κεραυνούς +CG τα τελευταία ${cg.windowMinutes}′ (${cg.cgCount} αρνητικοί CG)· τα sprites χρειάζονται κυρίως θετικούς.`,
      `Xweather finds no positive +CG strokes in the last ${cg.windowMinutes}′ (${cg.cgCount} negative CG); sprites mostly need positive ones.`)}`;
  }
  if (candidate.scoreInput.lightning === "not_detected") {
    return L(language,
      "Το μοντέλο δίνει καταιγίδα για αυτή την ώρα, αλλά το MTG-LI δεν ανιχνεύει κεραυνούς εκεί τώρα. Η πρόγνωση δεν επιβεβαιώνεται.",
      "The model forecasts a storm for this hour, but MTG-LI sees no lightning there now. The forecast is not confirmed.");
  }
  return L(language,
    "Μακρινή περιοχή μοντέλου με συνδυασμό αστάθειας και υετού. Απαιτείται επιβεβαίωση κεραυνικής δραστηριότητας πριν θεωρηθεί ενεργή καταιγίδα.",
    "A distant model area with instability and precipitation. Lightning has to be confirmed before it counts as an active storm.");
}

function alertBody(candidate: StormCandidate, language: Language) {
  const where = L(language,
    `${candidate.distanceKm.toFixed(0)} km προς ${directionLabel(candidate.bearingDeg, language)}`,
    `${candidate.distanceKm.toFixed(0)} km to the ${directionLabel(candidate.bearingDeg, language)}`);
  const detail = candidate.observedLightning;
  if (detail) {
    const cg = cgLine(detail.cg, language);
    const kind = candidate.source === "observed" ? L(language, "Παρατηρημένη καταιγίδα", "Observed storm") : L(language, "Επιβεβαιωμένη κυψέλη", "Confirmed cell");
    return `${kind} ${where}: ${L(language,
      `κεραυνοί MTG-LI σε ~${areaText(detail.areaKm2, language)} km² πριν από ${detail.ageMinutes}′`,
      `MTG-LI lightning over ~${areaText(detail.areaKm2, language)} km² ${detail.ageMinutes}′ ago`)}${cg ? ` · ${cg}` : ""}.`;
  }
  return L(language,
    `Προγνωστική κυψέλη ${where} για ${formatAthens(candidate.forecastValidAt, language)}. Δεν έχει επιβεβαιωθεί ηλεκτρική δραστηριότητα.`,
    `Forecast cell ${where} for ${formatAthens(candidate.forecastValidAt, language)}. No electrical activity confirmed yet.`);
}

function confidenceLabel(value: StormCandidate["score"]["confidence"], language: Language) {
  return language === "el"
    ? { high: "Υψηλή", medium: "Μέτρια", low: "Χαμηλή", insufficient: "Ανεπαρκής" }[value]
    : { high: "High", medium: "Medium", low: "Low", insufficient: "Insufficient" }[value];
}

function lightPollutionLabel(value: SavedLocation["lightPollution"], language: Language) {
  if (value === "low") return L(language, "χαμηλή · Bortle 1–3", "low · Bortle 1–3");
  if (value === "medium") return L(language, "μέτρια · Bortle 4–6", "medium · Bortle 4–6");
  if (value === "high") return L(language, "υψηλή · Bortle 7–9", "high · Bortle 7–9");
  return L(language, "άγνωστη", "unknown");
}

function ScoreDial({ value }: { value: number }) {
  return (
    <div className="score-dial" style={{ "--score": `${value * 3.6}deg` } as React.CSSProperties}>
      <div><strong>{value}</strong><span>/100</span></div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot status-${status}`} aria-hidden="true" />;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty-state">
      <Radio size={22} />
      <div><strong>{title}</strong><p>{description}</p></div>
    </div>
  );
}

/** Xweather's terms require this credit wherever its data is shown. */
function XweatherCredit() {
  return <a className="xweather-credit" href="https://www.xweather.com/" target="_blank" rel="noreferrer" title="Powered by Vaisala Xweather">Powered by Vaisala Xweather</a>;
}

function Metric({ label, value, hint, icon: Icon }: { label: string; value: string; hint?: string; icon: LucideIcon }) {
  return (
    <div className="metric">
      <Icon size={17} />
      <div><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>
    </div>
  );
}

export default function SpriteHunterApp({ initialLanguage }: { initialLanguage: Language }) {
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [language, setLanguage] = useLanguage(initialLanguage);
  const [locations, setLocations] = usePersistedState<SavedLocation[]>("spritehunter.locations", [DEFAULT_LOCATION], isLocationList);
  const [observer, setObserver, observerHydrated] = usePersistedState<SavedLocation>("spritehunter.observer", DEFAULT_LOCATION, isSavedLocation);
  const [lenses, setLenses] = usePersistedState<LensProfile[]>("spritehunter.lenses.v2", DEFAULT_LENSES, isLensList);
  const [selectedLensId, setSelectedLensId] = usePersistedState("spritehunter.selected-lens.v2", "tokina-atxi-11-16", isString);
  const [orientation, setOrientation] = usePersistedState<"landscape" | "portrait">("spritehunter.orientation", "landscape", isOrientation);
  const [logs, setLogs] = usePersistedState<LogEntry[]>("spritehunter.logs", [], isLogList);
  const [range, setRange, rangeHydrated] = usePersistedState("spritehunter.range", { min: 200, max: 600 }, isSearchRange);
  const [alertPrefs, setAlertPrefs] = usePersistedState<AlertPreferences>("spritehunter.alerts", DEFAULT_ALERT_PREFS, isAlertPrefs);
  const [lastAlert, setLastAlert] = usePersistedState<{ at: string; score: number } | null>("spritehunter.last-alert", null, isLastAlert);
  const [data, setData] = useState<OpportunityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Localized | null>(null);
  // Null until the user picks a target; until then the best target is shown.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // DEM horizons per whole-degree bearing, tagged with the site they were computed for.
  const [terrainState, setTerrainState] = useState<{ site: string; profiles: Map<number, TerrainProfile> } | null>(null);
  const [terrainLoading, setTerrainLoading] = useState(false);
  const [radar, setRadar] = useState<RadarMetadata | null>(null);
  const [radarStatus, setRadarStatus] = useState<DataStatus>("stale");
  const [radarVisible, setRadarVisible] = useState(true);
  const [eumetsat, setEumetsat] = useState<EumetsatMetadata | null>(null);
  const [lightningVisible, setLightningVisible] = useState(true);
  const [infraredVisible, setInfraredVisible] = useState(false);
  const [cloudTopVisible, setCloudTopVisible] = useState(false);
  const [instabilityVisible, setInstabilityVisible] = useState(false);
  const [ringsVisible, setRingsVisible] = useState(true);
  const [aurora, setAurora] = useState<AuroraResponse | null>(null);
  const [auroraLoading, setAuroraLoading] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">("default");
  const requestRef = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  const loadedOnceRef = useRef(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [refreshConfirmed, setRefreshConfirmed] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The target shown before a refresh, so a moving storm (new id) stays selected.
  const selectedRef = useRef<StormCandidate | null>(null);
  const mobileNavRef = useRef<HTMLElement>(null);
  const hydrated = observerHydrated && rangeHydrated;
  const t = (el: string, en: string) => L(language, el, en);
  // For display and editing; the map and the scans use `observer`, so a language switch does not recentre or rescan.
  const site = useMemo(() => localizeSite(observer, language), [observer, language]);
  const siteList = useMemo(() => locations.map((location) => localizeSite(location, language)), [locations, language]);
  // "Place — detail": phones show only the place, which otherwise was cut to "Σπάρτη — πρ…".
  const [place, ...detail] = site.name.split(" — ");
  const siteTitle = { place, detail: detail.join(" — ") };

  const terrainSite = `${observer.latitude}:${observer.longitude}:${observer.cameraHeightM}`;
  const terrainProfiles = terrainState?.site === terrainSite ? terrainState.profiles : null;
  // Every target is re-scored with its own DEM line of sight once known and ranked again,
  // so a target's score does not depend on which target is selected.
  const candidates = useMemo(() => {
    const list = data?.candidates ?? [];
    if (!terrainProfiles) return list;
    return list.map((candidate) => {
      const visibility = terrainVisibility(terrainProfiles.get(terrainBearingKey(candidate.bearingDeg)) ?? null, candidate.pointing);
      return visibility.status === "unknown" ? candidate : { ...candidate, score: rescoreWithTerrain(candidate.scoreInput, visibility.status) };
    }).sort((a, b) => b.score.total - a.score.total);
  }, [data, terrainProfiles]);
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0] ?? null;
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const terrain = selected ? terrainProfiles?.get(terrainBearingKey(selected.bearingDeg)) ?? null : null;
  const selectedLens = lenses.find((lens) => lens.id === selectedLensId) ?? lenses[0];
  const fov = fieldOfView(CANON_750D, selectedLens.focalLengthMm, orientation);
  const uncertaintyAngle = selected ? (Math.atan2(selected.uncertaintyKm, selected.distanceKm) * 180) / Math.PI * 2 : 0;
  const framing = selected
    ? framingAssessment(fov.horizontalDeg, fov.verticalDeg, uncertaintyAngle, selected.pointing[0].elevationDeg, selected.pointing.at(-1)!.elevationDeg)
    : null;
  const currentSky = selected ? skyState(new Date(selected.forecastValidAt), observer.latitude, observer.longitude, selected.bearingDeg) : null;

  // Resolves true once this scan's data is on screen.
  const refresh = useCallback(async (): Promise<boolean> => {
    // Only the newest scan may update the screen; older in-flight requests are aborted or ignored.
    const id = requestRef.current.id + 1;
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    requestRef.current = { id, controller };
    const isCurrent = () => requestRef.current.id === id;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        lat: observer.latitude.toString(), lon: observer.longitude.toString(), elevation: String(observer.elevationM ?? 0), minKm: String(range.min), maxKm: String(range.max),
      });
      let response: Response | null = null;
      try {
        // no-store also skips responses that older versions let the browser cache for minutes.
        response = await fetch(`/api/opportunities?${params}`, { signal: controller.signal, cache: "no-store" });
      } catch {
        if (controller.signal.aborted) return false;
      }
      let payload: OpportunityResponse;
      if (response && response.status < 500) {
        const serverPayload = (await response.json()) as OpportunityResponse & { error?: Localized };
        // Client errors (invalid input, rate limit) are reported, not retried from the browser.
        if (!response.ok) throw new LocalizedError(serverPayload.error ?? tx("Αποτυχία ανάκτησης μετεωρολογικών δεδομένων.", "Failed to load weather data."));
        payload = serverPayload;
      } else {
        // The server is unreachable or its upstream failed: query the keyless forecast directly.
        const { fetchOpportunities } = await import("@/lib/providers/open-meteo");
        const directPayload = await fetchOpportunities(
          { latitude: observer.latitude, longitude: observer.longitude, elevationM: observer.elevationM },
          range.min,
          range.max,
          { serverOnlySources: false },
        );
        payload = {
          ...directPayload,
          providers: directPayload.providers.map((provider) => provider.id === "open_meteo"
            ? { ...provider, message: tx(`${provider.message.el} Άμεση σύνδεση browser μετά από σφάλμα του server.`, `${provider.message.en} Direct browser connection after a server error.`) }
            : provider),
          warnings: [
            ...directPayload.warnings,
            tx(
              `Το server API δεν απάντησε (${response ? `HTTP ${response.status}` : "σφάλμα δικτύου"})· χρησιμοποιήθηκε browser fallback χωρίς METAR και MeteoAlarm.`,
              `The server API did not respond (${response ? `HTTP ${response.status}` : "network error"}); a browser fallback without METAR and MeteoAlarm was used.`,
            ),
          ],
        };
      }
      if (!isCurrent()) return false;
      loadedOnceRef.current = true;
      setData(payload);
      setCheckedAt(Date.now());
      // Follow the user's pick across refreshes; without one, keep showing the best target.
      setSelectedId((current) => (current == null ? null : followSelection(selectedRef.current, payload.candidates)));
      return true;
    } catch (refreshError) {
      if (!isCurrent() || controller.signal.aborted) return false;
      setError(refreshError instanceof LocalizedError
        ? refreshError.text
        : refreshError instanceof Error ? tx(refreshError.message, refreshError.message) : tx("Άγνωστο σφάλμα δεδομένων.", "Unknown data error."));
      return false;
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [observer.latitude, observer.longitude, observer.elevationM, range.min, range.max]);

  // Wait for the stored location before the first scan, then debounce edits to location and range.
  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(refresh, loadedOnceRef.current ? LOCATION_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [refresh, hydrated]);
  // While the app is open, rescan at the provider cache period so alerts can fire.
  useEffect(() => {
    if (!hydrated) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    const onVisible = () => {
      if (document.visibilityState === "visible" && checkedAt != null && Date.now() - checkedAt > RETURN_REFRESH_MS) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh, hydrated, checkedAt]);
  // The forecast is cached on the server, so a refresh can return the same targets in a
  // fraction of a second; confirm it briefly so the button does not look dead.
  const manualRefresh = async () => {
    if (!(await refresh())) return;
    setRefreshConfirmed(true);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setRefreshConfirmed(false), 2_500);
  };
  useEffect(() => () => { if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current); }, []);
  useEffect(() => {
    fetch("/api/radar").then(async (response) => {
      if (!response.ok) throw new Error("Radar unavailable");
      setRadar((await response.json()) as RadarMetadata);
      setRadarStatus("available");
    }).catch(() => { setRadar(null); setRadarStatus("unavailable"); });
    fetch("/api/eumetsat").then(async (response) => {
      const payload = (await response.json()) as EumetsatMetadata;
      setEumetsat(payload);
    }).catch(() => setEumetsat(null));
    setNotificationPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, []);
  // Space weather is only needed on the aurora screen.
  const auroraActive = screen === "aurora";
  useEffect(() => {
    if (!auroraActive || !hydrated) return;
    const controller = new AbortController();
    setAuroraLoading(true);
    const params = new URLSearchParams({ lat: observer.latitude.toString(), lon: observer.longitude.toString() });
    fetch(`/api/aurora?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as AuroraResponse;
        if (!response.ok) throw new Error(payload.message.en);
        setAurora(payload);
      })
      .catch((requestError) => {
        if ((requestError as Error).name !== "AbortError") setAurora(null);
      })
      .finally(() => { if (!controller.signal.aborted) setAuroraLoading(false); });
    return () => controller.abort();
  }, [auroraActive, hydrated, observer.latitude, observer.longitude]);
  // One DEM request covers the bearings of all listed targets; the server caches each for a week.
  const terrainBearings = useMemo(
    () => Array.from(new Set((data?.candidates ?? []).map((candidate) => terrainBearingKey(candidate.bearingDeg)))).sort((a, b) => a - b).join(","),
    [data],
  );
  useEffect(() => {
    if (!terrainBearings || !hydrated) return;
    const controller = new AbortController();
    const site = `${observer.latitude}:${observer.longitude}:${observer.cameraHeightM}`;
    setTerrainLoading(true);
    const params = new URLSearchParams({ lat: observer.latitude.toString(), lon: observer.longitude.toString(), bearings: terrainBearings, cameraHeight: observer.cameraHeightM.toString() });
    fetch(`/api/terrain?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as { profiles: TerrainProfile[] };
        setTerrainState((current) => {
          // A failed bearing never replaces a profile that was already verified.
          const profiles = new Map(current?.site === site ? current.profiles : []);
          for (const profile of payload.profiles) {
            if (profile.status === "available" || profiles.get(profile.bearingDeg)?.status !== "available") profiles.set(profile.bearingDeg, profile);
          }
          return { site, profiles };
        });
      })
      // Without a DEM answer the targets stay marked as unverified.
      .catch(() => {})
      .finally(() => { if (!controller.signal.aborted) setTerrainLoading(false); });
    return () => controller.abort();
  }, [terrainBearings, hydrated, observer.latitude, observer.longitude, observer.cameraHeightM]);
  // In-app watch: notify when the best target passes the user's rules.
  const topCandidate = candidates[0] ?? null;
  useEffect(() => {
    if (!topCandidate || notificationPermission !== "granted") return;
    const now = new Date();
    if (!evaluateAlert({ score: topCandidate.score.total, confidence: topCandidate.score.confidence, last: lastAlert, prefs: alertPrefs, now })) return;
    setLastAlert({ at: now.toISOString(), score: topCandidate.score.total });
    void showBrowserNotification(
      `SpriteHunter · ${L(language, "δείκτης", "index")} ${topCandidate.score.total}/100`,
      alertBody(topCandidate, language),
    );
  }, [topCandidate, notificationPermission, lastAlert, alertPrefs, setLastAlert, language]);
  // Keep the active item visible in the horizontally scrolling mobile navigation.
  useEffect(() => {
    const nav = mobileNavRef.current;
    const active = nav?.querySelector<HTMLElement>("button.active");
    if (!nav || !active) return;
    nav.scrollTo({ left: active.offsetLeft - nav.clientWidth / 2 + active.clientWidth / 2, behavior: "smooth" });
  }, [screen]);

  const selectCandidate = (id: string) => setSelectedId(id);
  // A new screen starts at its top: otherwise it opened at the previous screen's scroll
  // position, often past its heading.
  useEffect(() => { window.scrollTo(0, 0); }, [screen]);
  const goPoint = () => setScreen("point");
  const requestNotifications = async () => {
    if (typeof Notification === "undefined") return;
    setNotificationPermission(await Notification.requestPermission());
  };
  const checkedLabel = checkedAt ? `${t("Ενημερώθηκε", "Updated")} ${formatAthensTime(new Date(checkedAt), language)}` : null;
  const confirmed = refreshConfirmed && !loading;

  return (
    <LanguageContext.Provider value={language}>
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setScreen("dashboard")} aria-label={t("SpriteHunter αρχική", "SpriteHunter home")}>
          {/* Lazy: the sidebar is hidden on phones, where an eager image would still download. */}
          <img className="brand-logo" src="/spritehunter-logo.webp" alt="" width="216" height="72" loading="lazy" decoding="async" />
        </button>
        <nav aria-label={t("Κύρια πλοήγηση", "Main navigation")}>
          {navItems.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={screen === item.id ? "active" : ""} onClick={() => setScreen(item.id)}><Icon size={18} /><span>{language === "el" ? item.label : item.labelEn}</span></button>;
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="source-mini"><StatusDot status={error ? "unavailable" : loading ? "stale" : "available"} /><span>{loading ? t("Έλεγχος πηγών…", "Checking sources…") : error ? t("Σφάλμα παρόχου", "Provider error") : t("Ζωντανά μοντέλα", "Live models")}</span></div>
          <p className="made-by">{t("Δημιουργία", "Created by")} <a href={CREATOR.url} target="_blank" rel="noopener noreferrer">{CREATOR.name}</a></p>
          <p>v{APP_VERSION} · installable PWA</p>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <img className="mobile-brand-icon" src="/spritehunter-icon-128.webp" alt="" width="34" height="34" loading="lazy" decoding="async" />
          <div className="location-control">
            <MapPin size={18} />
            <div><span>{t("Θέση παρατήρησης", "Observing site")}</span><p className="location-line"><strong>{siteTitle.place}{siteTitle.detail && <span className="site-detail"> — {siteTitle.detail}</span>}</strong><span className="coordinate">{observer.latitude.toFixed(4)}°, {observer.longitude.toFixed(4)}°</span></p></div>
          </div>
          <div className="top-actions">
            <PwaInstallButton language={language} />
            <button className="lang-toggle" title={t("Αλλαγή γλώσσας", "Change language")} aria-label={t("Αλλαγή γλώσσας σε English", "Switch language to Ελληνικά")} onClick={() => setLanguage(language === "el" ? "en" : "el")}><span className={language === "el" ? "active" : ""}>ΕΛ</span><span className={language === "en" ? "active" : ""}>EN</span></button>
            <button className={`refresh-button${confirmed ? " confirmed" : ""}`} onClick={manualRefresh} disabled={loading} aria-label={confirmed && checkedLabel ? checkedLabel : t("Ανανέωση δεδομένων", "Refresh data")} title={checkedLabel ?? undefined}>
              {confirmed ? <Check size={17} /> : <RefreshCw size={17} className={loading ? "spin" : ""} />}
              <span>{confirmed && checkedLabel ? checkedLabel : t("Ανανέωση δεδομένων", "Refresh data")}</span>
            </button>
          </div>
        </header>

        <div className="content">
          {screen === "dashboard" && <DashboardView data={data} candidates={candidates} selected={selected} loading={loading} error={error} observer={site} language={language} eumetsat={eumetsat} radarStatus={radarStatus} onPoint={goPoint} onMap={() => setScreen("map")} onSelect={selectCandidate} />}
          {screen === "map" && <MapView candidates={candidates} selected={selected} observer={observer} radar={radar} radarVisible={radarVisible} lightningVisible={lightningVisible} infraredVisible={infraredVisible} cloudTopVisible={cloudTopVisible} instabilityVisible={instabilityVisible} ringsVisible={ringsVisible} eumetsat={eumetsat} onRadar={setRadarVisible} onLightning={setLightningVisible} onInfrared={setInfraredVisible} onCloudTop={setCloudTopVisible} onInstability={setInstabilityVisible} onRings={setRingsVisible} onSelect={selectCandidate} onPoint={goPoint} />}
          {screen === "forecast" && <ForecastView candidates={candidates} selected={selected} onSelect={selectCandidate} onPoint={goPoint} />}
          {screen === "point" && <PointView candidate={selected} observer={observer} lens={selectedLens} fov={fov} framing={framing} terrain={terrain} terrainLoading={terrainLoading && !terrain} sky={currentSky} language={language} />}
          {screen === "sky" && <SkyView candidate={selected} terrain={terrain} fov={fov} lens={selectedLens} orientation={orientation} sky={currentSky} onOrientation={setOrientation} />}
          {screen === "aurora" && <AuroraView aurora={aurora} loading={auroraLoading} lens={selectedLens} observer={site} forecast={data?.observerForecast ?? []} />}
          {screen === "locations" && <LocationsView observer={site} locations={siteList} candidate={selected} onObserver={setObserver} onLocations={setLocations} />}
          {screen === "camera" && <CameraView candidate={selected} lenses={lenses} selectedLens={selectedLens} fov={fov} framing={framing} orientation={orientation} sky={currentSky} onSelect={setSelectedLensId} onLenses={setLenses} onOrientation={setOrientation} />}
          {screen === "logbook" && <LogbookView logs={logs} candidate={selected} lens={selectedLens} onLogs={setLogs} />}
          {screen === "alerts" && <AlertsView candidate={topCandidate} prefs={alertPrefs} lastAlert={lastAlert} permission={notificationPermission} onPrefs={setAlertPrefs} onRequestPermission={requestNotifications} />}
          {screen === "settings" && <SettingsView observer={site} range={range} data={data} language={language} eumetsat={eumetsat} radarStatus={radarStatus} onObserver={setObserver} onRange={setRange} onLanguage={setLanguage} onRefresh={manualRefresh} />}
        </div>
      </main>

      <nav ref={mobileNavRef} className="mobile-nav" aria-label={t("Πλοήγηση κινητού", "Mobile navigation")}>
        {navItems.map((item) => { const Icon = item.icon; return <button key={item.id} className={screen === item.id ? "active" : ""} onClick={() => setScreen(item.id)}><Icon size={19} /><span>{language === "el" ? item.label : item.labelEn}</span></button>; })}
      </nav>
    </div>
    </LanguageContext.Provider>
  );
}

/** Carries a server error in both languages through `throw`. */
class LocalizedError extends Error {
  constructor(readonly text: Localized) {
    super(text.en);
  }
}

function DashboardView({ data, candidates, selected, loading, error, observer, language, eumetsat, radarStatus, onPoint, onMap, onSelect }: {
  data: OpportunityResponse | null; candidates: StormCandidate[]; selected: StormCandidate | null; loading: boolean; error: Localized | null; observer: SavedLocation; language: Language; eumetsat: EumetsatMetadata | null; radarStatus: DataStatus; onPoint: () => void; onMap: () => void; onSelect: (id: string) => void;
}) {
  const { t, pick, locale } = useI18n();
  // The clock renders only after mount: a server-rendered time differs from the client's
  // whenever a minute boundary falls between them, which broke hydration.
  const [clock, setClock] = useState<number | null>(null);
  useEffect(() => {
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const referenceTime = data ? new Date(data.fetchedAt).getTime() : 0;
  const nowHour = data?.observerForecast.find((hour) => new Date(hour.time).getTime() >= referenceTime) ?? data?.observerForecast[0];
  const skyHours = (data?.observerForecast ?? []).filter((hour) => new Date(hour.time).getTime() >= referenceTime).slice(0, 10);
  // Sources that gave cloud for at least one of the shown hours.
  const skySourceCount = (["openMeteo", "weatherApi", "openWeather"] as const).filter((key) => skyHours.some((hour) => hour.cloudSources?.[key] != null)).length;
  const airNow = data?.airQuality.find((hour) => new Date(hour.time).getTime() >= referenceTime - 30 * 60_000);
  const aviation = data?.aviation;
  // Only a fresh report counts as an observation; a stale METAR is shown as such in the field panel.
  const observedSky = aviation?.status === "available" && aviation.cloudCoverPercent != null ? aviation : null;
  const alerts = data?.weatherAlerts;
  const lightning = data?.lightning;
  const observedTargets = lightning?.inRangeCount ?? candidates.filter((candidate) => candidate.source === "observed").length;
  const alertTotal = alerts?.totalCount ?? alerts?.alerts.length ?? 0;
  const providers = (data?.providers ?? []).map((provider) => provider.id === "rainviewer"
    ? { ...provider, status: radarStatus, message: radarStatus === "available" ? tx("Live metadata διαθέσιμα· η γεωγραφική κάλυψη παραμένει best-effort.", "Live metadata available; geographic coverage stays best-effort.") : tx("Το live radar metadata δεν απάντησε τώρα.", "The live radar metadata did not respond.") }
    : provider);
  return (
    <div className="view-stack">
      <section className="hero-panel">
        <div className="eyebrow"><span className="live-pulse" /> {clock && skyState(new Date(clock), observer.latitude, observer.longitude, 0).sunAltitudeDeg > -6 ? "DAY WATCH" : "NIGHT WATCH"} · {clock ? formatAthens(new Date(clock), language) : "—"}</div>
        <div className="hero-grid">
          <div className="hero-copy">
            <span className={`opportunity-kicker ${selected ? `category-${selected.score.category}` : ""}`}>{loading && !data ? t("Σάρωση Μεσογείου…", "Scanning the Mediterranean…") : error ? t("Ανεπαρκή δεδομένα", "Insufficient data") : categoryLabel(selected, language)}</span>
            <h1>{selected ? targetTitle(selected, language) : !data && !error ? t("Αναζήτηση καταιγίδων για Red Sprites", "Scanning storms for Red Sprites") : t("Δεν εντοπίστηκε κατάλληλη ευκαιρία τώρα", "No suitable opportunity right now")}</h1>
            {selected && <p className="hero-valid-time">{selected.source === "observed" ? <><Zap size={16} />{t("Παρατήρηση", "Observed")} {formatAthens(selected.forecastValidAt, language)} · {t(`πριν από ${selected.observedLightning?.ageMinutes ?? "—"}′`, `${selected.observedLightning?.ageMinutes ?? "—"}′ ago`)}</> : <><CalendarClock size={16} />{t("Ισχύει", "Valid")} {formatAthens(selected.forecastValidAt, language)} · {relativeHours(selected.forecastValidAt, referenceTime, language)}</>}</p>}
            <p>{selected ? targetDescription(selected, language) : t("Η εφαρμογή θα συνεχίσει να ελέγχει πραγματικά προγνωστικά δεδομένα και κεραυνούς MTG-LI. Δεν δημιουργούνται τεχνητές καταιγίδες όταν δεν υπάρχει σήμα.", "The app keeps checking real forecast data and MTG-LI lightning. No artificial storms are created when there is no signal.")}{selected?.observedLightning?.cg && <> <XweatherCredit /></>}</p>
            {error && <div className="inline-error"><AlertTriangle size={17} />{pick(error)}</div>}
            <div className="hero-actions">
              <button className="primary-action" disabled={!selected} onClick={onPoint}><Crosshair size={18} />{t("Πού να στρέψω την κάμερα;", "Where should I point the camera?")}</button>
              <button className="secondary-action" disabled={!selected} onClick={onMap}><MapIcon size={18} />{t("Δες την καταιγίδα στον χάρτη", "View the storm on the map")}</button>
            </div>
          </div>
          <div className="hero-score">
            <ScoreDial value={selected?.score.total ?? 0} />
            <div><span>{t("Δείκτης ευκαιρίας", "Opportunity index")}</span><strong>{t("≠ πιθανότητα", "≠ probability")}</strong><small>{selected ? t(`${confidenceLabel(selected.score.confidence, language)} εμπιστοσύνη δεδομένων`, `${confidenceLabel(selected.score.confidence, language)} data confidence`) : t("Χωρίς διαθέσιμο στόχο", "No target available")}</small></div>
          </div>
        </div>
        <div className="hero-metrics">
          <Metric icon={Navigation} label={t("Αληθές αζιμούθιο", "True azimuth")} value={selected ? `${selected.bearingDeg.toFixed(1)}° · ${directionLabel(selected.bearingDeg, language)}` : "—"} />
          <Metric icon={Gauge} label={t("Απόσταση", "Distance")} value={selected ? `${selected.distanceKm.toFixed(0)} km` : "—"} hint={t("γεωδαιτική WGS84", "WGS84 geodesic")} />
          <Metric icon={Cloud} label={observedSky ? t("Νέφωση (METAR)", "Cloud (METAR)") : t("Υψηλή νέφωση εδώ", "High cloud here")} value={observedSky ? `${observedSky.cloudCoverPercent}%` : nowHour?.cloudCoverHigh != null ? `${nowHour.cloudCoverHigh}%` : "—"} hint={observedSky ? `${observedSky.stationId} · ${observedSky.distanceKm} km · ${t("υψηλή", "high")} ${nowHour?.cloudCoverHigh ?? "—"}%` : t("πρόγνωση μοντέλου", "model forecast")} />
          <Metric icon={Moon} label={t("Χρήσιμη ανύψωση", "Useful elevation")} value={selected ? `${selected.pointing[0].elevationDeg.toFixed(1)}°–${selected.pointing.at(-1)!.elevationDeg.toFixed(1)}°` : "—"} hint="50–90 km" />
        </div>
      </section>

      <div className="dashboard-grid">
        <section className="panel candidates-panel">
          <div className="panel-heading"><div><span className="eyebrow">RANKED TARGETS</span><h2>{t("Καλύτεροι στόχοι", "Best targets")}</h2></div><span className="count-badge">{candidates.length}</span></div>
          {candidates.length ? <div className="candidate-list">{candidates.slice(0, 5).map((candidate, index) => (
            <button key={candidate.id} className={`candidate-row ${selected?.id === candidate.id ? "selected" : ""} ${candidate.observedLightning ? "observed" : ""}`} onClick={() => onSelect(candidate.id)}>
              <span className="rank">0{index + 1}</span><span className="candidate-main"><strong>{candidate.observedLightning && <Zap size={13} className="observed-icon" aria-label={t("Παρατηρημένοι κεραυνοί", "Observed lightning")} />}{directionLabel(candidate.bearingDeg, language)} · {candidate.distanceKm.toFixed(0)} km</strong><small>{lightningLine(candidate, language) ?? formatAthens(candidate.forecastValidAt, language)}{candidate.capeJkg != null || !candidate.observedLightning ? ` · CAPE ${candidate.capeJkg?.toFixed(0) ?? "—"} J/kg` : ""}{candidate.lightningPotentialJkg != null ? ` · LPI ${candidate.lightningPotentialJkg.toFixed(0)}` : ""}</small></span><span className="candidate-score">{candidate.score.total}</span><ChevronRight size={17} />
            </button>
          ))}{candidates.slice(0, 5).some((candidate) => candidate.observedLightning?.cg) && <p className="credit-line"><XweatherCredit /></p>}</div> : <EmptyState title={loading ? t("Σάρωση σε εξέλιξη", "Scan in progress") : t("Κανένας κατάλληλος στόχος", "No suitable target")} description={t("Το κενό αποτέλεσμα είναι έγκυρο: ούτε κεραυνοί MTG-LI ούτε αρκετό προγνωστικό σήμα στην ακτίνα σάρωσης.", "An empty result is valid: no MTG-LI lightning and not enough forecast signal within the scan range.")} />}
        </section>

        <section className="panel timeline-panel">
          <div className="panel-heading"><div><span className="eyebrow">OBSERVER SKY</span><h2>{t("Ο ουρανός πάνω από", "The sky above")} {observer.name.split("—")[0]}</h2></div><Eye size={20} /></div>
          <div className="mini-timeline">
            {skyHours.map((hour) => (
              <div key={hour.time} className="timeline-hour"><span>{new Intl.DateTimeFormat(locale, { timeZone: "Europe/Athens", hour: "2-digit", hourCycle: "h23" }).format(new Date(hour.time))}</span><div className="cloud-bar"><i style={{ height: `${Math.max(8, hour.cloudCoverHigh ?? 0)}%` }} /></div><strong>{hour.cloudCoverHigh ?? "—"}%</strong></div>
            ))}
          </div>
          {skySourceCount >= 2 && <div className="consensus-row" aria-label={t("Συνολική νέφωση, διάμεσος των πηγών", "Total cloud, median of the sources")}>
            {skyHours.map((hour) => {
              const sources = hour.cloudSources;
              const values = sources ? Object.values(sources).filter((value): value is number => value != null) : [];
              const disagree = values.length >= 2 && Math.max(...values) - Math.min(...values) >= 40;
              const detail = sources ? [["Open-Meteo", sources.openMeteo], ["WeatherAPI", sources.weatherApi], ["OpenWeather", sources.openWeather]].filter(([, value]) => value != null).map(([name, value]) => `${name} ${value}%`).join(" · ") : "";
              return <span key={hour.time} className={disagree ? "disagree" : ""} title={detail}>{hour.cloudConsensus ?? "—"}%</span>;
            })}
          </div>}
          <p className="timeline-legend">{t("Ύψος στήλης = πρόγνωση υψηλής νέφωσης (%). Χαμηλότερες στήλες σημαίνουν πιο καθαρή ανώτερη ατμόσφαιρα.", "Bar height = forecast high cloud (%). Lower bars mean a clearer upper atmosphere.")}{skySourceCount >= 2 && ` ${t(`Κάτω σειρά: συνολική νέφωση, διάμεσος ${skySourceCount} προγνώσεων· πορτοκαλί όπου διαφωνούν.`, `Bottom row: total cloud, median of ${skySourceCount} forecasts; orange where they disagree.`)}`}</p>
          {airNow && <p className="air-quality-line"><Wind size={14} />AOD {airNow.aerosolOpticalDepth?.toFixed(2) ?? "—"} · {t("σκόνη", "dust")} {airNow.dust?.toFixed(0) ?? "—"} µg/m³ · PM10 {airNow.pm10?.toFixed(0) ?? "—"} µg/m³ <small>{t("CAMS πρόγνωση", "CAMS forecast")}</small></p>}
        </section>

        <section className="panel field-intel-panel">
          <div className="panel-heading"><div><span className="eyebrow">GROUND TRUTH & SAFETY</span><h2>{t("Πραγματικές παρατηρήσεις", "Real observations")}</h2></div><Radio size={20} /></div>
          <div className="field-intel-grid">
            <article>
              <div><span>{t("ΚΕΡΑΥΝΟΙ · EUMETSAT MTG-LI", "LIGHTNING · EUMETSAT MTG-LI")}</span><StatusDot status={lightning?.status ?? "stale"} /></div>
              <strong>{lightning?.status === "available" ? (observedTargets ? t(`${observedTargets} ${observedTargets === 1 ? "καταιγίδα" : "καταιγίδες"} στην ακτίνα σάρωσης`, `${observedTargets} ${observedTargets === 1 ? "storm" : "storms"} within the scan range`) : t("Καμία καταιγίδα στην ακτίνα σάρωσης", "No storm within the scan range")) : t("Χωρίς ζωντανή παρατήρηση", "No live observation")}</strong>
              <p>{lightning ? pick(lightning.message) : t("Αναμονή για δορυφορικά δεδομένα…", "Waiting for satellite data…")}</p>
            </article>
            <article>
              <div><span>METAR / TAF</span><StatusDot status={aviation?.status ?? "stale"} /></div>
              <strong>{aviation?.stationId ? `${aviation.stationId} · ${aviation.distanceKm} km` : t("Χωρίς κοντινή παρατήρηση", "No nearby observation")}</strong>
              <p>{!aviation ? t("Αναμονή για AviationWeather…", "Waiting for AviationWeather…") : aviation.status !== "stale" && aviation.cloudSummary ? pick(aviation.cloudSummary) : pick(aviation.message)}</p>
              {aviation?.visibilityM != null && <small>{t("Ορατότητα", "Visibility")} {aviation.visibilityAtLeast ? "≥" : ""}{(aviation.visibilityM / 1000).toFixed(aviation.visibilityM >= 10_000 ? 0 : 1)} km · {t("άνεμος", "wind")} {aviation.windSpeedKmh ?? "—"} km/h · {aviation.flightCategory ?? "—"}</small>}
              {aviation?.rawMetar && <code title={t("Το αυτούσιο δελτίο METAR του αεροδρομίου", "The airport's raw METAR report")}>{aviation.rawMetar}</code>}
            </article>
            <article>
              <div><span>{t("METEOALARM · ΕΛΛΑΔΑ", "METEOALARM · GREECE")}</span><StatusDot status={alerts?.status ?? "stale"} /></div>
              <strong>{alertTotal ? t(`${alertTotal} προειδοποιήσεις · ${alerts?.nearbyCount ?? 0} κοντά σου`, `${alertTotal} warnings · ${alerts?.nearbyCount ?? 0} near you`) : t("Καμία ενεργή προειδοποίηση", "No active warning")}</strong>
              <p>{alerts ? pick(alerts.message) : t("Αναμονή για επίσημη ροή…", "Waiting for the official feed…")}</p>
              <div className="alert-chips">{alerts?.alerts.slice(0, 4).map((alert) => <a key={alert.id} href={alert.link} target="_blank" rel="noreferrer"><b>{alert.severity}</b>{alert.event.replace(/ warning/i, "")} · {alert.area}</a>)}</div>
            </article>
          </div>
        </section>

        <section className="panel provider-panel">
          <div className="panel-heading"><div><span className="eyebrow">PROVENANCE</span><h2>{t("Κατάσταση δεδομένων", "Data status")}</h2></div><Database size={20} /></div>
          <div className="provider-list"><div><StatusDot status={eumetsat?.status ?? "stale"} /><span><strong>EUMETSAT MTG / MSG</strong><small>{eumetsat ? pick(eumetsat.message) : t("Έλεγχος δημόσιων δορυφορικών στρωμάτων…", "Checking public satellite layers…")}</small></span></div>{providers.map((provider) => <div key={provider.id}><StatusDot status={provider.status} /><span><strong>{pick(provider.label)}</strong><small>{pick(provider.message)}</small></span></div>)}</div>
          <p className="data-note"><ShieldAlert size={15} /> {t("Τα μη διαθέσιμα δεδομένα δεν λογίζονται ως μηδενική δραστηριότητα.", "Unavailable data never counts as zero activity.")}</p>
        </section>
      </div>
    </div>
  );
}

function MapView({ candidates, selected, observer, radar, radarVisible, lightningVisible, infraredVisible, cloudTopVisible, instabilityVisible, ringsVisible, eumetsat, onRadar, onLightning, onInfrared, onCloudTop, onInstability, onRings, onSelect, onPoint }: {
  candidates: StormCandidate[]; selected: StormCandidate | null; observer: SavedLocation; radar: RadarMetadata | null; radarVisible: boolean; lightningVisible: boolean; infraredVisible: boolean; cloudTopVisible: boolean; instabilityVisible: boolean; ringsVisible: boolean; eumetsat: EumetsatMetadata | null; onRadar: (value: boolean) => void; onLightning: (value: boolean) => void; onInfrared: (value: boolean) => void; onCloudTop: (value: boolean) => void; onInstability: (value: boolean) => void; onRings: (value: boolean) => void; onSelect: (id: string) => void; onPoint: () => void;
}) {
  const { t, language } = useI18n();
  const detail = selected?.observedLightning;
  return (
    <div className="map-layout">
      <section className="map-panel">
        <div className="map-toolbar"><div><span className="eyebrow">MEDITERRANEAN WATCH</span><h1>{t("Ζωντανός χάρτης & πρόγνωση", "Live map & forecast")}</h1></div><div className="layer-toggles"><label><input type="checkbox" checked={lightningVisible} onChange={(event) => onLightning(event.target.checked)} /> {t("Κεραυνοί MTG", "MTG lightning")}</label><label><input type="checkbox" checked={infraredVisible} onChange={(event) => onInfrared(event.target.checked)} /> {t("IR νέφη", "IR clouds")}</label><label><input type="checkbox" checked={cloudTopVisible} onChange={(event) => onCloudTop(event.target.checked)} /> {t("Ύψος κορυφών", "Cloud tops")}</label><label><input type="checkbox" checked={instabilityVisible} onChange={(event) => onInstability(event.target.checked)} /> K-index</label><label><input type="checkbox" checked={radarVisible} onChange={(event) => onRadar(event.target.checked)} /> Radar</label><label><input type="checkbox" checked={ringsVisible} onChange={(event) => onRings(event.target.checked)} /> {t("Δακτύλιοι", "Range rings")}</label></div></div>
        <div className="map-wrap"><StormMap observer={observer} candidates={candidates} selectedId={selected?.id ?? null} radar={radar} radarVisible={radarVisible} lightningVisible={lightningVisible} infraredVisible={infraredVisible} cloudTopVisible={cloudTopVisible} instabilityVisible={instabilityVisible} ringsVisible={ringsVisible} eumetsat={eumetsat} language={language} onSelect={onSelect} /><div className="map-legend"><span><i className="legend-observer" /> {t("Παρατηρητής", "Observer")}</span><span><i className="legend-target" /> {t("Πρόγνωση", "Forecast")}</span><span><i className="legend-observed" /> {t("Παρατηρημένη καταιγίδα", "Observed storm")}</span><span><i className="legend-lightning" /> {t("MTG-LI οπτικές εκπομπές", "MTG-LI optical flashes")}</span><span><i className="legend-uncertainty" /> {t("Αβεβαιότητα στόχου", "Target uncertainty")}</span></div></div>
        <p className="attribution">{t("© OpenStreetMap contributors · Lightning/IR/CTH/K-index: EUMETSAT μέσω EUMETView WMS · Radar: RainViewer · Πρόγνωση: Open-Meteo. Το MTG-LI αναλύεται επίσης στον server και τροφοδοτεί τη βαθμολογία· τα IR, CTH και K-index είναι μόνο οπτικές απεικονίσεις.", "© OpenStreetMap contributors · Lightning/IR/CTH/K-index: EUMETSAT via EUMETView WMS · Radar: RainViewer · Forecast: Open-Meteo. MTG-LI is also analysed on the server and feeds the score; IR, CTH and K-index are display layers only.")}</p>
        <div className="lightning-shortcuts"><span>{t("Εξωτερική διασταύρωση:", "Cross-check:")}</span><a href={`https://www.lightningmaps.org/?lang=${language}`} target="_blank" rel="noreferrer">LightningMaps Europe <ExternalLink size={13} /></a><a href="https://www.windy.com/-Weather-radar-radar" target="_blank" rel="noreferrer">Windy Radar + Lightning <ExternalLink size={13} /></a></div>
      </section>
      <aside className="target-drawer">
        {selected ? <><span className="eyebrow">{selected.source === "observed" ? "OBSERVED STORM · MTG-LI" : "SELECTED FORECAST CELL"}</span><div className="drawer-score"><ScoreDial value={selected.score.total} /><div><h2>{directionLabel(selected.bearingDeg, language)} · {selected.distanceKm.toFixed(0)} km</h2><span className="confidence-chip">{t(`${confidenceLabel(selected.score.confidence, language)} εμπιστοσύνη`, `${confidenceLabel(selected.score.confidence, language)} confidence`)}</span></div></div><div className="drawer-metrics"><Metric icon={Navigation} label={t("Αζιμούθιο", "Azimuth")} value={`${selected.bearingDeg.toFixed(1)}°`} />{detail && <Metric icon={Zap} label={t("Κεραυνοί MTG-LI", "MTG-LI lightning")} value={`~${areaText(detail.areaKm2, language)} km²`} hint={t(`πριν ${detail.ageMinutes}′ · έως ${detail.maxFlashesPer5Min >= 20 ? "20+" : Math.round(detail.maxFlashesPer5Min)}/5′`, `${detail.ageMinutes}′ ago · up to ${detail.maxFlashesPer5Min >= 20 ? "20+" : Math.round(detail.maxFlashesPer5Min)}/5′`)} />}{detail?.cg && <Metric icon={Zap} label={t("Θετικοί CG (Xweather)", "Positive CG (Xweather)")} value={`${detail.cg.positiveCount} +CG`} hint={`${detail.cg.maxPositiveKa != null ? `${t("έως", "up to")} +${detail.cg.maxPositiveKa} kA · ` : ""}${t(`${detail.cg.cgCount} CG σε ${detail.cg.windowMinutes}′`, `${detail.cg.cgCount} CG in ${detail.cg.windowMinutes}′`)}`} />}<Metric icon={Activity} label="CAPE" value={`${selected.capeJkg?.toFixed(0) ?? "—"} J/kg`} /><Metric icon={Gauge} label="Lifted Index" value={selected.liftedIndex == null ? "—" : selected.liftedIndex.toFixed(1)} /><Metric icon={ShieldAlert} label="CIN" value={selected.convectiveInhibitionJkg == null ? "—" : `${selected.convectiveInhibitionJkg.toFixed(0)} J/kg`} /><Metric icon={Sparkles} label="Lightning potential" value={selected.lightningPotentialJkg == null ? t("μη διαθέσιμο", "unavailable") : `${selected.lightningPotentialJkg.toFixed(0)} J/kg`} /><Metric icon={Cloud} label={t("Υετός", "Precipitation")} value={`${selected.precipitationMm?.toFixed(1) ?? "—"} mm`} /><Metric icon={Wind} label={t("Άνεμος μοντέλου", "Model wind")} value={`${selected.windSpeedKmh?.toFixed(0) ?? "—"} km/h`} /></div><div className="warning-box"><AlertTriangle size={17} /><p><strong>{t("Δύο διαφορετικά σήματα.", "Two different signals.")}</strong> {t("Τα χρωματιστά σημεία του MTG-LI είναι ζωντανή συνολική κεραυνική δραστηριότητα. Το lightning potential είναι πρόγνωση μοντέλου.", "The coloured MTG-LI dots are live total lightning activity. Lightning potential is a model forecast.")} {detail?.cg ? <>{t("Η πολικότητα και η ένταση των κεραυνών CG έρχονται από το δίκτυο κεραυνών του Xweather.", "CG polarity and peak current come from the Xweather lightning network.")} <XweatherCredit /></> : t("Κανένα από τα δύο δεν δίνει πολικότητα +CG ή peak current.", "Neither gives +CG polarity or peak current.")}</p></div><div className="science-note"><strong>{t("Για sprites", "For sprites")}</strong><p>{t("Τα ισχυρά +CG είναι σημαντικά, αλλά το peak current μόνο του δεν αρκεί. Ισχυρότερος φυσικός δείκτης είναι η μεταβολή ροπής φορτίου (charge moment change), η οποία δεν παρέχεται από το MTG-LI.", "Strong +CG strokes matter, but peak current alone is not enough. The stronger physical indicator is the charge moment change, which MTG-LI does not provide.")}</p></div><button className="primary-action full" onClick={onPoint}><Crosshair size={18} />{t("Άνοιγμα στόχευσης", "Open pointing")}</button></> : <EmptyState title={t("Χωρίς επιλεγμένο στόχο", "No target selected")} description={t("Επίλεξε έναν στόχο στον χάρτη.", "Pick a target on the map.")} />}
      </aside>
    </div>
  );
}

function ForecastView({ candidates, selected, onSelect, onPoint }: { candidates: StormCandidate[]; selected: StormCandidate | null; onSelect: (id: string) => void; onPoint: () => void }) {
  const { t, pick, language } = useI18n();
  const explanationRef = useRef<HTMLElement>(null);
  // The explanation below the table is what a row click changes; bring it into view,
  // otherwise the click looked like it did nothing.
  const choose = (id: string) => {
    onSelect(id);
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    requestAnimationFrame(() => explanationRef.current?.scrollIntoView({ behavior, block: "nearest" }));
  };
  const parts = selected ? [
    { label: t("Δραστηριότητα", "Activity"), hint: t("κεραυνοί MTG-LI, +CG ή αστάθεια μοντέλου", "MTG-LI lightning, +CG or model instability"), value: selected.score.activity, max: 35 },
    { label: t("Ατμόσφαιρα", "Atmosphere"), hint: t("νέφωση και ορατότητα στη θέση σου", "cloud and visibility at your location"), value: selected.score.atmosphere, max: 30 },
    { label: t("Έδαφος", "Terrain"), hint: t("ορίζοντας DEM προς τον στόχο", "DEM horizon towards the target"), value: selected.score.terrain, max: 20 },
    { label: t("Απόσταση", "Distance"), hint: t("ιδανικά 250–550 km", "ideally 250–550 km"), value: selected.score.distance, max: 10 },
    { label: t("Σκοτάδι", "Darkness"), hint: t("ύψος ήλιου και σελήνη", "Sun altitude and Moon"), value: selected.score.darkness, max: 5 },
  ] : [];
  return (
    <div className="view-stack">
      <div className="view-heading"><div><span className="eyebrow">NEXT 48 HOURS</span><h1>{t("Ευκαιρίες", "Opportunities")}</h1><p>{t("Καταιγίδες που βλέπει τώρα το MTG-LI και χονδροειδής προγνωστική σάρωση όλων των διευθύνσεων. Οι προγνωστικές θέσεις μπορούν να μετακινηθούν σημαντικά. Πάτησε μια γραμμή για την επεξήγηση του δείκτη.", "Storms MTG-LI sees now plus a coarse forecast scan in every direction. Forecast positions can shift a lot. Tap a row to see why it scored as it did.")}</p></div><CalendarClock size={30} /></div>
      <section className="panel"><div className="forecast-table"><div className="forecast-head"><span>{t("Έγκυρη ώρα", "Valid time")}</span><span>{t("Κατεύθυνση", "Direction")}</span><span>{t("Απόσταση", "Distance")}</span><span>{t("CAPE / Υετός", "CAPE / Precip.")}</span><span>{t("Δείκτης", "Index")}</span><span /></div>{candidates.length ? candidates.map((candidate) => <button key={candidate.id} className={selected?.id === candidate.id ? "selected" : ""} aria-current={selected?.id === candidate.id ? "true" : undefined} aria-controls="score-explanation" onClick={() => choose(candidate.id)}><span>{candidate.source === "observed" ? <><Zap size={13} className="observed-icon" />{t("τώρα (MTG-LI)", "now (MTG-LI)")}</> : formatAthens(candidate.forecastValidAt, language)}</span><span>{directionLabel(candidate.bearingDeg, language)} · {candidate.bearingDeg.toFixed(0)}°</span><span>{candidate.distanceKm.toFixed(0)} km</span><span>{candidate.capeJkg?.toFixed(0) ?? "—"} J/kg · {candidate.precipitationMm?.toFixed(1) ?? "—"} mm</span><strong>{candidate.score.total}/100</strong><ChevronDown size={17} /></button>) : <EmptyState title={t("Καμία υποψήφια κυψέλη", "No candidate cell")} description={t("Δεν βρέθηκε συνδυασμός αστάθειας και υετού που να περνά τα αρχικά φίλτρα.", "No mix of instability and precipitation passed the first filters.")} />}</div></section>
      {selected && (
        <section ref={explanationRef} id="score-explanation" className="panel explanation-panel">
          <div className="explanation-heading">
            <div>
              <span className="eyebrow">WHY THIS SCORE</span>
              <h2>{t("Επεξήγηση δείκτη", "Score explained")} {selected.score.total}/100</h2>
              <p>{directionLabel(selected.bearingDeg, language)} · {selected.bearingDeg.toFixed(0)}° · {selected.distanceKm.toFixed(0)} km · {selected.source === "observed" ? t("παρατήρηση MTG-LI τώρα", "MTG-LI observation now") : t(`ισχύει ${formatAthens(selected.forecastValidAt, language)}`, `valid ${formatAthens(selected.forecastValidAt, language)}`)}</p>
            </div>
            <span className="confidence-chip">{t(`${confidenceLabel(selected.score.confidence, language)} εμπιστοσύνη`, `${confidenceLabel(selected.score.confidence, language)} confidence`)}</span>
          </div>
          <div className="score-breakdown">{parts.map((part) => (
            <div key={part.label}><span><strong>{part.label}</strong><small>{part.hint}</small></span><div className="score-bar"><i style={{ width: `${part.value / part.max * 100}%` }} /></div><b>{part.value}/{part.max}</b></div>
          ))}</div>
          <div className="reason-columns">
            {selected.score.reasons.length > 0 && <div><h3><Check size={15} />{t("Υπέρ του στόχου", "In favour")}</h3><ul>{selected.score.reasons.map((reason) => <li key={reason.en}>{pick(reason)}</li>)}</ul></div>}
            {selected.score.limitations.length > 0 && <div className="limitations"><h3><AlertTriangle size={15} />{t("Περιορισμοί", "Limitations")}</h3><ul>{selected.score.limitations.map((limitation) => <li key={limitation.en}>{pick(limitation)}</li>)}</ul></div>}
          </div>
          {selected.observedLightning?.cg && <p className="credit-line"><XweatherCredit /></p>}
          <button className="primary-action" onClick={onPoint}><Crosshair size={18} />{t("Άνοιγμα στόχευσης", "Open pointing")}</button>
        </section>
      )}
    </div>
  );
}

function signedAngle(target: number, current: number) {
  return ((target - current + 540) % 360) - 180;
}

const SETTING_LABELS: Record<string, Localized> = {
  aperture: tx("Διάφραγμα", "Aperture"),
  iso: tx("ISO", "ISO"),
  shutter: tx("Έκθεση", "Exposure"),
  whiteBalance: tx("Ισορροπία λευκού", "White balance"),
  format: tx("Μορφή αρχείου", "File format"),
  interval: tx("Διάστημα λήψεων", "Interval"),
};

type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };

function PointView({ candidate, observer, lens, fov, framing, terrain, terrainLoading, sky, language }: {
  candidate: StormCandidate | null; observer: SavedLocation; lens: LensProfile; fov: { horizontalDeg: number; verticalDeg: number }; framing: ReturnType<typeof framingAssessment> | null; terrain: TerrainProfile | null; terrainLoading: boolean; sky: ReturnType<typeof skyState> | null; language: Language;
}) {
  const { t, pick } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const orientationRef = useRef<{ eventName: string; handler: EventListener } | null>(null);
  const relativeWarningRef = useRef(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraMessage, setCameraMessage] = useState<Localized>(tx("Η εικόνα μένει στη συσκευή και δεν μεταφορτώνεται.", "The image stays on the device and is never uploaded."));
  const [heading, setHeading] = useState<number | null>(null);
  const [sensorsActive, setSensorsActive] = useState(false);
  const [applyDeclination, setApplyDeclination] = useState(true);
  const [manualHeading, setManualHeading] = useState(candidate?.bearingDeg ?? 0);
  const [elevation, setElevation] = useState(candidate ? (candidate.pointing[0].elevationDeg + candidate.pointing.at(-1)!.elevationDeg) / 2 : 10);
  const [sensorMessage, setSensorMessage] = useState<Localized>(tx("Χειροκίνητη λειτουργία — χρησιμοποίησε τα ρυθμιστικά ή ενεργοποίησε τους αισθητήρες.", "Manual mode — use the sliders or enable the sensors."));

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
  }, []);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (orientationRef.current) window.removeEventListener(orientationRef.current.eventName, orientationRef.current.handler);
  }, []);
  useEffect(() => {
    if (!candidate) return;
    setManualHeading(candidate.bearingDeg);
    setElevation((candidate.pointing[0].elevationDeg + candidate.pointing.at(-1)!.elevationDeg) / 2);
  }, [candidate]);

  const toggleCamera = async () => {
    if (cameraActive) { stopCamera(); return; }
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new LocalizedError(tx("Η κάμερα απαιτεί HTTPS και σύγχρονο browser.", "The camera needs HTTPS and a modern browser."));
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
      setCameraMessage(tx("Ζωντανή εικόνα ενεργή · καμία εικόνα δεν αποθηκεύεται ή αποστέλλεται.", "Live view on · no image is stored or sent."));
    } catch (error) {
      setCameraMessage(error instanceof LocalizedError ? error.text : error instanceof Error ? tx(error.message, error.message) : tx("Δεν ήταν δυνατή η πρόσβαση στην κάμερα.", "Could not access the camera."));
      stopCamera();
    }
  };

  const enableCompass = async () => {
    type PermissionDeviceOrientationEvent = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> };
    try {
      if (typeof DeviceOrientationEvent === "undefined") throw new LocalizedError(tx("Οι αισθητήρες προσανατολισμού δεν υποστηρίζονται.", "Orientation sensors are not supported."));
      const OrientationEvent = DeviceOrientationEvent as PermissionDeviceOrientationEvent;
      if (OrientationEvent.requestPermission) {
        const permission = await OrientationEvent.requestPermission();
        if (permission !== "granted") throw new LocalizedError(tx("Δεν δόθηκε άδεια αισθητήρων.", "Sensor permission was not granted."));
      }
      if (orientationRef.current) window.removeEventListener(orientationRef.current.eventName, orientationRef.current.handler);
      // Listen to one stream only: on Android the plain event has a relative (arbitrary) alpha,
      // and mixing it with the absolute event made the heading jump between two references.
      const supportsAbsolute = "ondeviceorientationabsolute" in window;
      const eventName = supportsAbsolute ? "deviceorientationabsolute" : "deviceorientation";
      const handler = ((event: CompassEvent) => {
        if (event.beta == null || event.gamma == null) return;
        const pointing = cameraPointing(event.alpha ?? 0, event.beta, event.gamma);
        const absolute = supportsAbsolute || event.absolute;
        const nextHeading = typeof event.webkitCompassHeading === "number" ? event.webkitCompassHeading : absolute && event.alpha != null ? pointing.headingDeg : null;
        if (nextHeading != null) setHeading(nextHeading);
        else if (!relativeWarningRef.current) {
          relativeWarningRef.current = true;
          setSensorMessage(tx("Η συσκευή δίνει μόνο σχετικό προσανατολισμό· η ανύψωση είναι ζωντανή, αλλά όρισε το αζιμούθιο χειροκίνητα.", "The device gives only relative orientation; elevation is live, but set the azimuth by hand."));
        }
        setElevation(Math.max(-10, Math.min(90, pointing.elevationDeg)));
        setSensorsActive(true);
      }) as EventListener;
      orientationRef.current = { eventName, handler };
      window.addEventListener(eventName, handler);
      setSensorMessage(tx("Αισθητήρες ενεργοί. Κάνε κίνηση ∞ για βαθμονόμηση και κράτησε το κινητό μακριά από μέταλλα ή μαγνήτες.", "Sensors on. Move the phone in a ∞ to calibrate and keep it away from metal or magnets."));
    } catch (error) { setSensorMessage(error instanceof LocalizedError ? error.text : error instanceof Error ? tx(error.message, error.message) : tx("Οι αισθητήρες δεν υποστηρίζονται.", "Sensors are not supported.")); }
  };

  if (!candidate) return <EmptyState title={t("Δεν υπάρχει στόχος για σκόπευση", "No target to point at")} description={t("Επίλεξε πρώτα μια διαθέσιμη προγνωστική κυψέλη.", "Pick an available target first.")} />;
  const elevations = candidate.pointing.map((point) => point.elevationDeg);
  const minElevation = Math.min(...elevations);
  const maxElevation = Math.max(...elevations);
  const targetElevation = (minElevation + maxElevation) / 2;
  const targetHalfWidth = (Math.atan2(candidate.uncertaintyKm, candidate.distanceKm) * 180) / Math.PI;
  const targetMin = (candidate.bearingDeg - targetHalfWidth + 360) % 360;
  const targetMax = (candidate.bearingDeg + targetHalfWidth) % 360;
  const visibility = terrainVisibility(terrain, candidate.pointing);
  const declination = magneticDeclination(observer.latitude, observer.longitude, observer.elevationM ?? 0);
  const effectiveHeading = heading == null ? manualHeading : normalizeBearing(heading + (applyDeclination ? declination : 0));
  const horizontalError = signedAngle(candidate.bearingDeg, effectiveHeading);
  const verticalError = targetElevation - elevation;
  // "Centred" only means something when the reading comes from the device sensors.
  const aligned = sensorsActive && angularDifference(effectiveHeading, candidate.bearingDeg) < 3 && Math.abs(verticalError) < 3;
  const markerLeft = Math.max(7, Math.min(93, 50 + horizontalError / 60 * 100));
  // Keep the moving reticle inside the clear middle band, away from the top instruction and bottom readout.
  const markerTop = Math.max(28, Math.min(70, 50 - verticalError / 45 * 100));
  const directions = `${horizontalError > 3 ? t("στρέψε δεξιά", "turn right") : horizontalError < -3 ? t("στρέψε αριστερά", "turn left") : t("σωστό αζιμούθιο", "azimuth OK")} · ${verticalError > 3 ? t("σήκωσε", "tilt up") : verticalError < -3 ? t("χαμήλωσε", "tilt down") : t("σωστή ανύψωση", "elevation OK")}`;
  const instruction = !sensorsActive ? t("Χειροκίνητη προεπισκόπηση · ενεργοποίησε τους αισθητήρες για ζωντανή καθοδήγηση", "Manual preview · enable the sensors for live guidance") : aligned ? t("Στόχος κεντραρισμένος", "Target centred") : directions;
  const bandWidthPercent = Math.max(6, Math.min(100, (targetHalfWidth * 2) / fov.horizontalDeg * 100));
  const recommendation = photoRecommendation(lens, sky?.moonInterference ?? false, framing?.fits ?? true, language);

  return <div className="point-layout">
    <section className="point-hero">
      <span className="eyebrow">LIVE CAMERA GUIDANCE · WMM2025 TRUE NORTH</span>
      <h1>{t("Στρέψε την κάμερα προς", "Point the camera to the")} <em>{directionLabel(candidate.bearingDeg, language)}</em></h1>
      <div className="bearing-number"><strong>{candidate.bearingDeg.toFixed(1)}°</strong><span>{t(`αληθές αζιμούθιο · στόχος ${targetElevation.toFixed(1)}° ψηλά`, `true azimuth · target ${targetElevation.toFixed(1)}° high`)} · {formatAthens(candidate.forecastValidAt, language)}</span></div>
      <div className={`camera-guidance ${cameraActive ? "active" : ""}`}>
        <video ref={videoRef} muted playsInline aria-label={t("Ζωντανή εικόνα πίσω κάμερας", "Live rear-camera view")} />
        <div className="camera-horizon" />
        <div className={`camera-target ${aligned ? "aligned" : ""}`} style={{ left: `${markerLeft}%`, top: `${markerTop}%` }}><Crosshair size={34} /><span>TLE</span></div>
        <div className={`guidance-instruction ${aligned ? "aligned" : ""}`} role="status" aria-live="polite">{instruction}</div>
        <div className="camera-readout">{sensorsActive ? t("Τώρα", "Now") : t("Χειροκίνητα", "Manual")} {effectiveHeading.toFixed(0)}° {t("αληθές", "true")} / {elevation.toFixed(0)}° · {t("στόχος", "target")} {candidate.bearingDeg.toFixed(0)}° / {targetElevation.toFixed(0)}°</div>
      </div>
      {!cameraActive && <div className="camera-start-note"><Camera size={22} /><div><strong>{t("Η κάμερα είναι κλειστή", "The camera is off")}</strong><span>{t("Πάτησε «Άνοιγμα κάμερας» για ζωντανή εικόνα. Ο δείκτης στόχευσης λειτουργεί και χειροκίνητα.", "Tap “Open camera” for a live view. The pointing guide also works manually.")}</span></div></div>}
      <div className="guidance-actions"><button className="primary-action" onClick={toggleCamera}><Camera size={18} />{cameraActive ? t("Κλείσιμο κάμερας", "Close camera") : t("Άνοιγμα κάμερας", "Open camera")}</button><button className="secondary-action" onClick={enableCompass}><Compass size={18} />{sensorsActive ? t("Αισθητήρες ενεργοί", "Sensors on") : t("Αισθητήρες", "Sensors")}</button></div>
      <p className="sensor-note">{pick(cameraMessage)} {pick(sensorMessage)}</p>
      <label className="wmm-toggle"><input type="checkbox" checked={applyDeclination} onChange={(event) => setApplyDeclination(event.target.checked)} disabled={heading == null} /><span><strong>{t("Διόρθωση", "Correction")} WMM2025 {declination >= 0 ? "+" : ""}{declination.toFixed(1)}°</strong> {t("από μαγνητικό σε αληθή βορρά. Απενεργοποίησέ την μόνο αν η συσκευή σου δίνει ήδη αληθές αζιμούθιο.", "from magnetic to true north. Turn it off only if your device already gives a true azimuth.")}</span></label>
      <div className="manual-guidance"><label>{t("Αζιμούθιο συσκευής", "Device azimuth")} <strong>{effectiveHeading.toFixed(0)}°</strong><input type="range" min="0" max="359" value={Math.round(effectiveHeading) % 360} onChange={(event) => { setHeading(null); setManualHeading(Number(event.target.value)); }} /></label><label>{t("Ανύψωση κάμερας", "Camera elevation")} <strong>{elevation.toFixed(0)}°</strong><input type="range" min="-10" max="90" value={Math.round(elevation)} onChange={(event) => setElevation(Number(event.target.value))} /></label></div>
      <div className="point-grid"><div><span>{t("Οριζόντιος τομέας", "Horizontal sector")}</span><strong>{targetMin.toFixed(1)}° → {targetMax.toFixed(1)}°</strong></div><div><span>{t("Χρήσιμη ανύψωση", "Useful elevation")}</span><strong>{minElevation.toFixed(1)}° → {maxElevation.toFixed(1)}°</strong></div><div><span>{t("Ορίζοντας εδάφους", "Terrain horizon")}</span><strong>{terrainLoading ? t("υπολογισμός…", "computing…") : terrain?.horizonAngleDeg != null ? `${terrain.horizonAngleDeg.toFixed(1)}°` : t("μη επαληθευμένος", "unverified")}</strong></div><div><span>{t("Ορατό εύρος TLE", "Visible TLE range")}</span><strong>{visibility.status === "clear" ? "50–90 km" : visibility.status === "partial" ? `${visibility.visibleAltitudesKm[0]}–${visibility.visibleAltitudesKm.at(-1)} km` : visibility.status === "blocked" ? t("Αποκλεισμένο", "Blocked") : t("Άγνωστο", "Unknown")}</strong></div></div>
    </section>
    <aside className="point-sidebar"><section className="panel compact"><span className="eyebrow">FRAME CHECK</span><h2>{lens.name}</h2><div className="fov-visual"><div className="fov-frame"><div className="target-band" style={{ width: `${bandWidthPercent}%`, height: `${Math.min(80, Math.max(4, ((maxElevation - minElevation) / fov.verticalDeg) * 100))}%` }} /></div></div><div className="fov-values"><span>{t("Οριζόντια", "Horizontal")} <strong>{fov.horizontalDeg.toFixed(1)}°</strong></span><span>{t("Κάθετα", "Vertical")} <strong>{fov.verticalDeg.toFixed(1)}°</strong></span></div><p className={framing?.fits ? "fit-ok" : "fit-warn"}>{framing?.fits ? t("Η εκτιμώμενη περιοχή χωρά με περιθώριο στο κάδρο.", "The estimated area fits the frame with margin.") : t("Η αβεβαιότητα δεν χωρά άνετα. Προτίμησε ευρύτερο φακό.", "The uncertainty does not fit comfortably. Prefer a wider lens.")}</p></section><section className="panel compact"><span className="eyebrow">FIELD SETTINGS</span>{Object.entries(recommendation).filter(([key]) => key in SETTING_LABELS).map(([key, value]) => <div className="setting-row" key={key}><span>{pick(SETTING_LABELS[key])}</span><strong>{value}</strong></div>)}</section><section className="safety-card"><ShieldAlert size={20} /><div><strong>{t("Προτεραιότητα η ασφάλεια", "Safety first")}</strong><p>{t("Μην παρατηρείς σε εκτεθειμένο σημείο όταν η καταιγίδα πλησιάζει.", "Do not observe from an exposed spot when the storm approaches.")} {candidate.observedLightning ? t("Η καταιγίδα είναι παρατηρημένη από δορυφόρο· η ακριβής θέση των sprites παραμένει αβέβαιη.", "The storm is observed by satellite; the exact position of sprites stays uncertain.") : t("Ο στόχος εδώ είναι προγνωστικός, όχι επιβεβαιωμένος.", "This target is a forecast, not confirmed.")}</p></div></section></aside>
  </div>;
}

// A dark outline keeps sky labels readable where they cross grid and frame lines.
const SKY_LABEL_HALO = { stroke: "#0b1729", strokeWidth: 4, strokeOpacity: 0.85, paintOrder: "stroke" } as const;

function SkyView({ candidate, terrain, fov, lens, orientation, sky, onOrientation }: { candidate: StormCandidate | null; terrain: TerrainProfile | null; fov: { horizontalDeg: number; verticalDeg: number }; lens: LensProfile; orientation: "landscape" | "portrait"; sky: ReturnType<typeof skyState> | null; onOrientation: (value: "landscape" | "portrait") => void }) {
  const { t, language } = useI18n();
  if (!candidate) return <EmptyState title={t("Δεν υπάρχει στόχος", "No target")} description={t("Η πανοραμική όψη απαιτεί επιλεγμένο στόχο.", "The sky view needs a selected target.")} />;
  const low = Math.min(...candidate.pointing.map((point) => point.elevationDeg));
  const high = Math.max(...candidate.pointing.map((point) => point.elevationDeg));
  const horizon = Math.max(0, terrain?.horizonAngleDeg ?? 0);
  const maxElevation = Math.ceil(Math.max(30, high + 5, horizon + 5) / 5) * 5;
  const y = (angle: number) => 260 - Math.max(0, Math.min(maxElevation, angle)) / maxElevation * 225;
  const sectorWidth = Math.max(50, fov.horizontalDeg * 1.35);
  const targetAngularWidth = Math.atan2(candidate.uncertaintyKm, candidate.distanceKm) * 360 / Math.PI;
  const targetWidth = Math.max(18, Math.min(560, targetAngularWidth / sectorWidth * 560));
  const moonOffset = sky ? signedAngle(sky.moonAzimuthDeg, candidate.bearingDeg) : 0;
  const moonX = 350 + moonOffset / sectorWidth * 560;
  const leftBearing = (candidate.bearingDeg - sectorWidth / 2 + 360) % 360;
  const rightBearing = (candidate.bearingDeg + sectorWidth / 2) % 360;
  // Elevation labels are drawn inside the SVG so they stay on their grid lines at every width.
  const gridAngles = [0, maxElevation / 2, maxElevation];
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">ANGULAR CAMERA VIEW</span><h1>{t("Ορίζοντας & πραγματικό κάδρο", "Horizon & real frame")}</h1><p>{t("Ο οριζόντιος άξονας είναι αζιμούθιο γύρω από τον στόχο και ο κάθετος πραγματική γωνία ανύψωσης.", "The horizontal axis is azimuth around the target and the vertical axis is true elevation angle.")}</p></div><div className="segmented"><button className={orientation === "landscape" ? "active" : ""} onClick={() => onOrientation("landscape")}>{t("Οριζόντια", "Landscape")}</button><button className={orientation === "portrait" ? "active" : ""} onClick={() => onOrientation("portrait")}>{t("Κάθετα", "Portrait")}</button></div></div><section className="panel sky-panel"><svg viewBox="0 0 700 300" role="img" aria-label={t("Γωνιακό κάδρο, ζώνη TLE και κεντρικός ορίζοντας εδάφους", "Angular frame, TLE band and terrain horizon on the central bearing")}><defs><linearGradient id="skyGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0a1530" /><stop offset="1" stopColor="#18283b" /></linearGradient><linearGradient id="terrainGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#263b45" /><stop offset="1" stopColor="#101a20" /></linearGradient></defs><rect width="700" height="300" fill="url(#skyGradient)" />{[0, .25, .5, .75, 1].map((ratio) => <line key={ratio} x1="0" x2="700" y1={260 - ratio * 225} y2={260 - ratio * 225} stroke="#7390aa" strokeOpacity=".16" />)}<rect x="70" y={y(Math.min(maxElevation, fov.verticalDeg))} width="560" height={260 - y(Math.min(maxElevation, fov.verticalDeg))} rx="8" fill="none" stroke="#7de4ca" strokeWidth="2" strokeDasharray="7 5" /><line x1="350" x2="350" y1="30" y2="260" stroke="#7de4ca" strokeOpacity=".45" /><rect x={350 - targetWidth / 2} y={y(high)} width={targetWidth} height={Math.max(7, y(low) - y(high))} rx="5" fill="#f04362" fillOpacity=".34" stroke="#ff6d84" /><text x="350" y={Math.max(22, y(high) - 9)} textAnchor="middle" fill="#ffb1be" fontSize="12" {...SKY_LABEL_HALO}>TLE 50–90 km</text>{sky && sky.moonAltitudeDeg > 0 && moonX >= 20 && moonX <= 680 && <g transform={`translate(${moonX},${y(sky.moonAltitudeDeg)})`}><circle r="9" fill="#f4dfad" /><text x="14" y="4" fill="#dce8f3" fontSize="11">{t("Σελήνη", "Moon")}</text></g>}<rect x="0" y={y(horizon)} width="700" height={300 - y(horizon)} fill="url(#terrainGradient)" /><line x1="0" x2="700" y1={y(horizon)} y2={y(horizon)} stroke="#91a49c" strokeWidth="2" />{gridAngles.map((angle) => <text key={angle} x="8" y={angle === 0 ? y(0) + 4 : y(angle) - 4} dominantBaseline={angle === 0 ? "hanging" : undefined} fill="#d3e1eb" fillOpacity=".75" fontSize="11" {...SKY_LABEL_HALO}>{angle}°</text>)}<text x="692" y={y(horizon) + 4} dominantBaseline="hanging" textAnchor="end" fill="#b9c8c3" fontSize="11" {...SKY_LABEL_HALO}>{t("Ορίζοντας DEM", "DEM horizon")}: {terrain?.horizonAngleDeg == null ? t("μη διαθέσιμος", "unavailable") : `${terrain.horizonAngleDeg.toFixed(1)}°`}</text></svg><div className="horizon-caption"><span>{directionLabel(leftBearing, language)} {leftBearing.toFixed(0)}°</span><strong>{t("Στόχος", "Target")} {candidate.bearingDeg.toFixed(1)}°</strong><span>{directionLabel(rightBearing, language)} {rightBearing.toFixed(0)}°</span></div><div className="sky-key"><span><i className="key-tle" />{t("Θεωρητική ζώνη TLE", "Theoretical TLE band")}</span><span><i className="key-fov" />{t("Κάδρο", "Frame")} {lens.focalLengthMm} mm</span><span><i className="key-terrain" />{t("Όριο DEM στην κεντρική διεύθυνση", "DEM limit on the central bearing")}</span></div></section><div className="warning-box"><Mountain size={18} /><p><strong>{t("Περιορισμός:", "Limitation:")}</strong> {t("το DEM ελέγχει τη γραμμή προς το κέντρο του στόχου και δεν παριστάνεται πλέον ως ψεύτικο πανοραμικό ανάγλυφο 360°.", "the DEM checks the line towards the target's centre and is not drawn as a fake 360° panorama.")}</p></div></div>;
}

function AuroraView({ aurora, loading, lens, observer, forecast }: { aurora: AuroraResponse | null; loading: boolean; lens: LensProfile; observer: SavedLocation; forecast: OpportunityResponse["observerForecast"] }) {
  const { t, pick } = useI18n();
  const referenceTime = aurora?.retrievedAt ? new Date(aurora.retrievedAt).getTime() : 0;
  const currentHour = forecast.find((hour) => new Date(hour.time).getTime() >= referenceTime) ?? forecast[0];
  const active = aurora?.level === "strong" || aurora?.level === "possible";
  const preset = aurora?.kp != null && aurora.kp >= 7
    ? { shutter: "2–5 s", iso: "1600–3200", aperture: `f/${Math.min(2.8, lens.maxAperture).toFixed(1)}`, interval: "1 s" }
    : { shutter: "5–10 s", iso: "3200–6400", aperture: `f/${Math.min(2.8, lens.maxAperture).toFixed(1)}`, interval: "1–2 s" };
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">NOAA SPACE WEATHER · AURORA MODE</span><h1>{t("Φωτογράφιση σέλαος", "Aurora photography")}</h1><p>{t(`Πραγματικά δεδομένα NOAA/SWPC, με ειλικρινή αξιολόγηση για τη θέση ${observer.name}.`, `Real NOAA/SWPC data, with an honest assessment for ${observer.name}.`)}</p></div><Sparkles size={31} /></div><div className="aurora-grid"><section className={`panel aurora-status level-${aurora?.level ?? "unknown"}`}><div className="aurora-gauge"><span>Kp</span><strong>{loading ? "…" : aurora?.kp?.toFixed(1) ?? "—"}</strong><small>/ 9</small></div><div><span className="eyebrow">CURRENT ASSESSMENT</span><h2>{loading ? t("Ανάκτηση διαστημικού καιρού…", "Fetching space weather…") : aurora ? pick(aurora.message) : t("Τα δεδομένα NOAA δεν είναι διαθέσιμα.", "NOAA data is unavailable.")}</h2><p>{active ? t("Κατεύθυνση: σκοτεινός βόρειος ορίζοντας, συνήθως 0–15° ανύψωση από την Ελλάδα.", "Direction: the dark northern horizon, usually 0–15° elevation from Greece.") : t("Από την Ελλάδα το σέλας είναι σπάνιο και συνήθως απαιτεί ακραία γεωμαγνητική καταιγίδα.", "From Greece the aurora is rare and usually needs an extreme geomagnetic storm.")}</p></div><div className="aurora-metrics"><Metric icon={Activity} label={t("Τοπικό OVATION", "Local OVATION")} value={aurora?.localProbabilityPercent == null ? "—" : `${aurora.localProbabilityPercent}%`} /><Metric icon={Navigation} label={t("Βόρειος τομέας", "Northern sector")} value={aurora?.northernSectorProbabilityPercent == null ? "—" : `${aurora.northernSectorProbabilityPercent}%`} /><Metric icon={Cloud} label={t("Υψηλή νέφωση εδώ", "High cloud here")} value={currentHour?.cloudCoverHigh == null ? "—" : `${currentHour.cloudCoverHigh}%`} /></div></section><section className="panel aurora-camera"><span className="eyebrow">AURORA STARTING PRESET</span><h2>{lens.name}</h2><div className="settings-grid"><Metric icon={Camera} label={t("Διάφραγμα", "Aperture")} value={preset.aperture} /><Metric icon={Gauge} label="ISO" value={preset.iso} /><Metric icon={Activity} label={t("Έκθεση", "Exposure")} value={preset.shutter} /><Metric icon={RefreshCw} label="Interval" value={preset.interval} /></div><ul className="aurora-checklist"><li>{t("Τρίποδο, RAW και χειροκίνητη εστίαση σε φωτεινό άστρο.", "Tripod, RAW and manual focus on a bright star.")}</li><li>{t("Ισορροπία λευκού 3.500–4.000 K και απενεργοποιημένη μακρά αποθορυβοποίηση.", "White balance 3,500–4,000 K and long-exposure noise reduction off.")}</li><li>{t("Κάνε δοκιμές προς Βορρά και έλεγχε το ιστόγραμμα χωρίς να καίγεται ο ορίζοντας.", "Take test shots to the north and check the histogram without burning out the horizon.")}</li></ul></section><section className="panel ovation-panel"><div className="panel-heading"><div><span className="eyebrow">LIVE OVATION AURORA</span><h2>{t("Βόρειο ημισφαίριο", "Northern hemisphere")}</h2></div><a href="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast" target="_blank" rel="noreferrer">NOAA <ExternalLink size={14} /></a></div><img src="https://services.swpc.noaa.gov/images/animations/ovation/north/latest.jpg" width="800" height="800" loading="lazy" decoding="async" alt={t("Τελευταία πρόγνωση OVATION για το βόρειο ημισφαίριο από NOAA SWPC", "Latest NOAA SWPC OVATION forecast for the northern hemisphere")} /><p className="data-note">{t("Το OVATION είναι βραχυπρόθεσμο μοντέλο ωοειδούς σέλαος. Η πιθανότητα πάνω σε βόρεια γεωγραφικά πλάτη δεν σημαίνει ότι είναι ορατό από την Ελλάδα.", "OVATION is a short-term model of the auroral oval. A probability over northern latitudes does not mean it is visible from Greece.")}</p></section></div></div>;
}

function LocationsView({ observer, locations, candidate, onObserver, onLocations }: { observer: SavedLocation; locations: SavedLocation[]; candidate: StormCandidate | null; onObserver: (value: SavedLocation) => void; onLocations: (value: SavedLocation[]) => void }) {
  const { t, pick, language } = useI18n();
  const [name, setName] = useState("");
  const [gpsStatus, setGpsStatus] = useState<Localized | null>(null);
  const addCurrent = () => {
    const item = { ...observer, id: createId(), name: name.trim() || t(`Θέση ${locations.length + 1}`, `Location ${locations.length + 1}`), favorite: false };
    onLocations([...locations, item]); setName("");
  };
  const useGps = () => {
    if (!navigator.geolocation) { setGpsStatus(tx("Το GPS δεν υποστηρίζεται.", "GPS is not supported.")); return; }
    setGpsStatus(tx("Αναμονή άδειας GPS…", "Waiting for GPS permission…"));
    navigator.geolocation.getCurrentPosition((position) => {
      onObserver({ ...observer, name: t("Τρέχουσα θέση GPS", "Current GPS position"), latitude: position.coords.latitude, longitude: position.coords.longitude, elevationM: position.coords.altitude ?? observer.elevationM });
      const accuracy = position.coords.accuracy.toFixed(0);
      setGpsStatus(tx(`Ακρίβεια περίπου ±${accuracy} m.`, `Accuracy about ±${accuracy} m.`));
    }, (gpsError) => setGpsStatus(tx(gpsError.message, gpsError.message)), { enableHighAccuracy: true, timeout: 12_000 });
  };
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">OBSERVER NETWORK</span><h1>{t("Θέσεις παρατήρησης", "Observing sites")}</h1><p>{t("Οι συντεταγμένες αποθηκεύονται μόνο σε αυτόν τον browser.", "Coordinates are stored only in this browser.")}</p></div><button className="secondary-action" onClick={useGps}><LocateFixed size={18} />{t("Χρήση GPS", "Use GPS")}</button></div>{gpsStatus && <div className="info-strip">{pick(gpsStatus)}</div>}<div className="locations-grid"><section className="panel location-editor"><h2>{t("Ακριβής ενεργή θέση", "Exact active site")}</h2><label>{t("Όνομα", "Name")}<input value={observer.name} onChange={(event) => onObserver({ ...observer, name: event.target.value })} /></label><div className="two-fields"><label>{t("Γεωγραφικό πλάτος", "Latitude")}<NumberField min={-90} max={90} value={observer.latitude} onCommit={(latitude) => onObserver({ ...observer, latitude })} /></label><label>{t("Γεωγραφικό μήκος", "Longitude")}<NumberField min={-180} max={180} value={observer.longitude} onCommit={(longitude) => onObserver({ ...observer, longitude })} /></label></div><div className="two-fields"><label>{t("Υψόμετρο εδάφους (m)", "Ground elevation (m)")}<NumberField min={-500} max={9000} value={observer.elevationM ?? 0} onCommit={(elevationM) => onObserver({ ...observer, elevationM })} /></label><label>{t("Ύψος κάμερας (m)", "Camera height (m)")}<NumberField min={0} max={100} value={observer.cameraHeightM} onCommit={(cameraHeightM) => onObserver({ ...observer, cameraHeightM })} /></label></div><label>{t("Φωτορύπανση / εκτίμηση Bortle", "Light pollution / Bortle estimate")}<select value={observer.lightPollution} onChange={(event) => onObserver({ ...observer, lightPollution: event.target.value as SavedLocation["lightPollution"] })}><option value="unknown">{t("Άγνωστη", "Unknown")}</option><option value="low">{t("Χαμηλή", "Low")} · Bortle 1–3</option><option value="medium">{t("Μέτρια", "Medium")} · Bortle 4–6</option><option value="high">{t("Υψηλή", "High")} · Bortle 7–9</option></select></label><p className="data-note">{t("Χειροκίνητη εκτίμηση θέσης· δεν παρουσιάζεται ως live μέτρηση φωτορύπανσης και δεν αλλάζει ακόμη τον επιστημονικό δείκτη.", "A manual estimate for the site; it is not a live light-pollution measurement and does not change the score yet.")}</p><div className="save-row"><input placeholder={t("Όνομα νέας αποθηκευμένης θέσης", "Name for the new saved site")} value={name} onChange={(event) => setName(event.target.value)} /><button className="primary-action" onClick={addCurrent}><Plus size={17} />{t("Αποθήκευση", "Save")}</button></div></section><section className="panel"><h2>{t("Σύγκριση για τον ίδιο στόχο", "Comparison for the same target")}</h2><div className="location-list">{locations.map((location) => { const geometry = candidate ? inverseGeodesic(location, candidate.coordinates) : null; return <div key={location.id} className={location.id === observer.id ? "active" : ""}><button className="location-select" onClick={() => onObserver(location)}><MapPin size={18} /><span><strong>{location.name}</strong><small>{location.latitude.toFixed(4)}°, {location.longitude.toFixed(4)}° · {t("φωτορύπανση", "light pollution")} {lightPollutionLabel(location.lightPollution, language)}{geometry ? ` · ${(geometry.distanceM / 1000).toFixed(0)} km · ${geometry.initialBearingDeg.toFixed(0)}°` : ""}</small></span></button>{location.id !== "sparta-home" && <button className="delete-icon" aria-label={t("Διαγραφή θέσης", "Delete site")} onClick={() => onLocations(locations.filter((item) => item.id !== location.id))}><Trash2 size={16} /></button>}</div>; })}</div><p className="data-note">{t("Η σύγκριση απόστασης/αζιμουθίου είναι διαθέσιμη άμεσα. Η σύγκριση νεφών και DEM απαιτεί ξεχωριστό έλεγχο ανά θέση.", "Distance and azimuth compare instantly. Cloud and DEM comparison needs a separate check per site.")}</p></section></div></div>;
}

function CameraView({ candidate, lenses, selectedLens, fov, framing, orientation, sky, onSelect, onLenses, onOrientation }: { candidate: StormCandidate | null; lenses: LensProfile[]; selectedLens: LensProfile; fov: { horizontalDeg: number; verticalDeg: number }; framing: ReturnType<typeof framingAssessment> | null; orientation: "landscape" | "portrait"; sky: ReturnType<typeof skyState> | null; onSelect: (id: string) => void; onLenses: (value: LensProfile[]) => void; onOrientation: (value: "landscape" | "portrait") => void }) {
  const { t, language } = useI18n();
  const [custom, setCustom] = useState({ name: "", focal: 24, aperture: 2.8 });
  const recommendation = photoRecommendation(selectedLens, sky?.moonInterference ?? false, !candidate || (framing?.fits ?? true), language);
  const addLens = (event: FormEvent) => { event.preventDefault(); if (!custom.name.trim() || custom.focal <= 0 || custom.aperture <= 0) return; const lens: LensProfile = { id: createId(), name: custom.name, focalLengthMm: custom.focal, maxAperture: custom.aperture, mount: "Canon EF/EF-S", owned: true }; onLenses([...lenses, lens]); onSelect(lens.id); setCustom({ name: "", focal: 24, aperture: 2.8 }); };
  return (
    <div className="view-stack">
      <div className="view-heading">
        <div><span className="eyebrow">PHOTOGRAPHY ENGINE</span><h1>{t("Κάμερα & φακοί", "Camera & lenses")}</h1><p>{t("Canon EOS 750D · APS-C 22,3 × 14,9 mm · crop 1,6×", "Canon EOS 750D · APS-C 22.3 × 14.9 mm · crop 1.6×")}</p></div>
        <Camera size={31} />
      </div>
      <div className="equipment-grid">
        <section className="panel lens-library">
          <div className="panel-heading">
            <div><h2>{t("Ο εξοπλισμός μου", "My gear")}</h2><p className="panel-subtitle">{t(`${lenses.length} φακοί · ${lenses.filter((lens) => lens.owned).length} διαθέσιμοι`, `${lenses.length} lenses · ${lenses.filter((lens) => lens.owned).length} owned`)}</p></div>
            <div className="segmented"><button className={orientation === "landscape" ? "active" : ""} onClick={() => onOrientation("landscape")}>{t("Οριζόντια", "Landscape")}</button><button className={orientation === "portrait" ? "active" : ""} onClick={() => onOrientation("portrait")}>{t("Κάθετα", "Portrait")}</button></div>
          </div>
          <div className="lens-list">
            {lenses.map((lens) => {
              const isSelected = lens.id === selectedLens.id;
              const isZoom = lens.minFocalLengthMm !== undefined && lens.maxFocalLengthMm !== undefined;
              const focalRange = isZoom ? `${lens.minFocalLengthMm}–${lens.maxFocalLengthMm} mm` : `${lens.focalLengthMm} mm`;
              const apertureRange = lens.maxApertureTele !== undefined ? `f/${lens.maxAperture}–${lens.maxApertureTele}` : `f/${lens.maxAperture}`;
              return (
                <div key={lens.id} className={isSelected ? "selected" : ""}>
                  <button onClick={() => onSelect(lens.id)}>
                    <span><strong>{lens.name}</strong><small>{lens.mount} · {lens.owned ? t("Διαθέσιμος", "Owned") : t("Μη διαθέσιμος", "Not owned")}</small></span>
                    <span>{focalRange}<br /><small>{apertureRange}</small></span>
                  </button>
                  <label><input type="checkbox" checked={lens.owned} onChange={(event) => onLenses(lenses.map((item) => item.id === lens.id ? { ...item, owned: event.target.checked } : item))} /> {t("δικός μου", "mine")}</label>
                  {isSelected && isZoom && (
                    <div className="zoom-control">
                      <div><span>{t("Ενεργή εστιακή", "Active focal length")}</span><strong>{lens.focalLengthMm} mm</strong></div>
                      <input
                        type="range"
                        min={lens.minFocalLengthMm}
                        max={lens.maxFocalLengthMm}
                        step="1"
                        value={lens.focalLengthMm}
                        aria-label={t(`Ενεργή εστιακή απόσταση για ${lens.name}`, `Active focal length for ${lens.name}`)}
                        onChange={(event) => onLenses(lenses.map((item) => item.id === lens.id ? { ...item, focalLengthMm: Number(event.target.value) } : item))}
                      />
                      <small>{t("Μέγιστο διάφραγμα στην τρέχουσα θέση: περίπου", "Widest aperture at this setting: about")} f/{effectiveMaxAperture(lens)}</small>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <form className="custom-lens" onSubmit={addLens}><h3>{t("Προσθήκη φακού", "Add lens")}</h3><input placeholder={t("Όνομα", "Name")} value={custom.name} onChange={(event) => setCustom({ ...custom, name: event.target.value })} /><NumberField aria-label={t("Εστιακή απόσταση (mm)", "Focal length (mm)")} min={1} max={2000} value={custom.focal} onCommit={(focal) => setCustom({ ...custom, focal })} /><NumberField aria-label={t("Μέγιστο διάφραγμα (f/)", "Widest aperture (f/)")} min={0.5} max={64} value={custom.aperture} onCommit={(aperture) => setCustom({ ...custom, aperture })} /><button><Plus size={16} />{t("Προσθήκη", "Add")}</button></form>
        </section>
        <aside className="view-stack">
          <section className="panel fov-card"><span className="eyebrow">CALCULATED FIELD OF VIEW</span><div className="big-fov"><strong>{fov.horizontalDeg.toFixed(1)}° × {fov.verticalDeg.toFixed(1)}°</strong><span>{t(`πραγματικό γωνιακό κάδρο στα ${selectedLens.focalLengthMm} mm`, `real angular frame at ${selectedLens.focalLengthMm} mm`)}</span></div>{candidate && <div className={framing?.fits ? "fit-ok" : "fit-warn"}>{framing?.fits ? <Check size={17} /> : <AlertTriangle size={17} />}{framing?.fits ? t("Ο στόχος και η αβεβαιότητά του χωρούν.", "The target and its uncertainty fit.") : t("Ο στόχος μπορεί να βγει από το κάδρο.", "The target may fall outside the frame.")}</div>}<p className="data-note">{t("Για αρχική αναζήτηση sprites ξεκίνα με τον Tokina στα 11 mm. Ο Jupiter 200 mm είναι κατάλληλος μόνο όταν η περιοχή έχει επιβεβαιωθεί πολύ καλά.", "For a first sprite search start with the Tokina at 11 mm. The Jupiter 200 mm suits only an area that is very well confirmed.")}</p></section>
          <section className="panel recommendation-card"><span className="eyebrow">EXPERIMENTAL STARTING POINT</span><h2>{recommendation.preset}</h2><div className="settings-grid"><Metric icon={Camera} label={t("Διάφραγμα", "Aperture")} value={recommendation.aperture} /><Metric icon={Gauge} label={t("Ευαισθησία", "Sensitivity")} value={recommendation.iso} /><Metric icon={Activity} label={t("Έκθεση", "Exposure")} value={recommendation.shutter} /><Metric icon={Moon} label={t("Ισορροπία λευκού", "White balance")} value={recommendation.whiteBalance} /></div><div className="warning-box"><AlertTriangle size={17} /><p>{recommendation.warning} {t("Οι ρυθμίσεις είναι πειραματική αφετηρία, όχι εγγύηση.", "These settings are an experimental starting point, not a guarantee.")}</p></div></section>
        </aside>
      </div>
    </div>
  );
}

function LogbookView({ logs, candidate, lens, onLogs }: { logs: LogEntry[]; candidate: StormCandidate | null; lens: LensProfile; onLogs: (value: LogEntry[]) => void }) {
  const { t, language } = useI18n();
  // A malformed stored entry is skipped, not allowed to break the screen.
  const entries = logs.filter(isLogEntry);
  const [form, setForm] = useState({ tleType: "Red Sprite", iso: 3200, aperture: effectiveMaxAperture(lens), shutter: "3 s", success: "uncertain" as LogEntry["success"], notes: "" });
  const add = (event: FormEvent) => { event.preventDefault(); onLogs([{ id: createId(), timestamp: new Date().toISOString(), target: candidate ? `${candidate.bearingDeg.toFixed(1)}° / ${candidate.distanceKm.toFixed(0)} km` : t("Χωρίς στόχο", "No target"), lens: lens.name, ...form }, ...logs]); setForm({ ...form, notes: "" }); };
  const download = (format: "json" | "csv") => {
    const content = format === "json" ? JSON.stringify(logs, null, 2) : ["timestamp,target,tleType,lens,iso,aperture,shutter,success,notes", ...logs.map((entry) => [entry.timestamp, entry.target, entry.tleType, entry.lens, entry.iso, entry.aperture, entry.shutter, entry.success, entry.notes].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))].join("\n");
    // The BOM makes Excel read the CSV as UTF-8 (Greek notes were garbled); Safari starts the
    // download after click() returns, so the blob URL is released a little later.
    const blob = new Blob([format === "csv" ? `﻿${content}` : content], { type: format === "json" ? "application/json" : "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `spritehunter-logbook.${format}`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">OBSERVATION ARCHIVE</span><h1>{t("Ημερολόγιο παρατήρησης", "Observation logbook")}</h1><p>{t("Οι καταχωρίσεις αποθηκεύονται τοπικά και οι ώρες εσωτερικά σε UTC.", "Entries are stored locally, with times kept in UTC.")}</p></div><div className="export-actions"><button onClick={() => download("csv")}><Download size={16} />CSV</button><button onClick={() => download("json")}><Download size={16} />JSON</button></div></div><div className="log-grid"><form className="panel log-form" onSubmit={add}><h2>{t("Νέα καταχώριση", "New entry")}</h2><label>{t("Τύπος TLE", "TLE type")}<select value={form.tleType} onChange={(event) => setForm({ ...form, tleType: event.target.value })}><option>Red Sprite</option><option>Sprite Halo</option><option>ELVES</option><option>Blue Jet</option><option>Gigantic Jet</option></select></label><div className="three-fields"><label>ISO<NumberField min={50} max={409600} value={form.iso} onCommit={(iso) => setForm({ ...form, iso })} /></label><label>{t("Διάφραγμα", "Aperture")}<NumberField min={0.5} max={64} value={form.aperture} onCommit={(aperture) => setForm({ ...form, aperture })} /></label><label>{t("Έκθεση", "Exposure")}<input value={form.shutter} onChange={(event) => setForm({ ...form, shutter: event.target.value })} /></label></div><label>{t("Αποτέλεσμα", "Result")}<select value={form.success} onChange={(event) => setForm({ ...form, success: event.target.value as LogEntry["success"] })}><option value="yes">{t("Επιτυχία", "Success")}</option><option value="no">{t("Όχι", "No")}</option><option value="uncertain">{t("Αβέβαιο", "Uncertain")}</option></select></label><label>{t("Σημειώσεις", "Notes")}<textarea rows={4} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label><button className="primary-action"><Plus size={17} />{t("Καταχώριση", "Add entry")}</button></form><section className="panel"><h2>{t("Προηγούμενες παρατηρήσεις", "Past observations")}</h2>{entries.length ? <div className="log-list">{entries.map((entry) => <article key={entry.id}><div><strong>{entry.tleType}</strong><span className={`result-${entry.success}`}>{entry.success === "yes" ? t("Επιτυχία", "Success") : entry.success === "no" ? t("Όχι", "No") : t("Αβέβαιο", "Uncertain")}</span></div><small>{formatAthens(entry.timestamp, language)} · {entry.target}</small><p>{entry.lens} · f/{entry.aperture} · ISO {entry.iso} · {entry.shutter}</p>{entry.notes && <blockquote>{entry.notes}</blockquote>}<button aria-label={t("Διαγραφή", "Delete")} onClick={() => onLogs(logs.filter((item) => item.id !== entry.id))}><Trash2 size={15} /></button></article>)}</div> : <EmptyState title={t("Το ημερολόγιο είναι κενό", "The logbook is empty")} description={t("Κατέγραψε τις πραγματικές προσπάθειες για μελλοντική αξιολόγηση του δείκτη.", "Record your real attempts to evaluate the index later.")} />}</section></div></div>;
}

function AlertsView({ candidate, prefs, lastAlert, permission, onPrefs, onRequestPermission }: {
  candidate: StormCandidate | null; prefs: AlertPreferences; lastAlert: { at: string; score: number } | null; permission: NotificationPermission | "unsupported"; onPrefs: (value: AlertPreferences) => void; onRequestPermission: () => void;
}) {
  const { t, language } = useI18n();
  const minimumScore = prefs.minimumScore;
  const passes = candidate != null && candidate.score.total >= minimumScore;
  const permissionLabel = (language === "el"
    ? { granted: "επιτρέπεται", denied: "απορρίφθηκε (άλλαξέ το από τις ρυθμίσεις του browser)", default: "δεν έχει ζητηθεί", unsupported: "δεν υποστηρίζεται σε αυτόν τον browser" }
    : { granted: "allowed", denied: "denied (change it in the browser settings)", default: "not requested yet", unsupported: "not supported in this browser" })[permission];
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">EVENT-DRIVEN WATCH</span><h1>{t("Ειδοποιήσεις", "Alerts")}</h1><p>{t("Ειδοποίηση μόνο όταν η ευκαιρία αλλάζει ουσιαστικά — όχι συνεχής θόρυβος.", "Alerts only when the opportunity really changes — no constant noise.")}</p></div><Bell size={30} /></div><div className="alerts-grid"><section className="panel alert-settings"><h2>{t("Κανόνες ειδοποίησης", "Alert rules")}</h2><label>{t("Ελάχιστος δείκτης", "Minimum index")} <strong>{minimumScore}/100</strong><input type="range" min="30" max="95" value={minimumScore} onChange={(event) => onPrefs({ ...prefs, minimumScore: Number(event.target.value) })} /></label><p className="data-note">{minimumScore > MAX_FORECAST_SCORE ? t(`Πάνω από ${MAX_FORECAST_SCORE} ειδοποιείσαι μόνο για καταιγίδες με παρατηρημένους κεραυνούς MTG-LI.`, `Above ${MAX_FORECAST_SCORE} you are alerted only for storms with observed MTG-LI lightning.`) : t(`Οι προγνωστικοί στόχοι φτάνουν έως ${MAX_FORECAST_SCORE}· πάνω από αυτό απαιτούνται παρατηρημένοι κεραυνοί.`, `Forecast targets reach at most ${MAX_FORECAST_SCORE}; above that, observed lightning is needed.`)}</p><label>{t("Ελάχιστη εμπιστοσύνη", "Minimum confidence")}<select value={prefs.confidence} onChange={(event) => onPrefs({ ...prefs, confidence: event.target.value as AlertPreferences["confidence"] })}><option value="low">{t("Χαμηλή", "Low")}</option><option value="medium">{t("Μέτρια — έδαφος ή κεραυνοί", "Medium — terrain or lightning")}</option><option value="high">{t("Υψηλή — κεραυνοί και έδαφος ή +CG", "High — lightning and terrain, or +CG")}</option></select></label><p className="data-note">{t("Μέτρια: επαληθευμένο έδαφος ή παρατηρημένοι κεραυνοί MTG-LI. Υψηλή: παρατηρημένοι κεραυνοί μαζί με επαληθευμένο έδαφος ή ισχυρούς θετικούς +CG (Xweather).", "Medium: verified terrain or observed MTG-LI lightning. High: observed lightning together with verified terrain or strong positive +CG strokes (Xweather).")}</p><label>{t("Cooldown (λεπτά)", "Cooldown (minutes)")}<NumberField min={0} max={1440} value={prefs.cooldown} onCommit={(cooldown) => onPrefs({ ...prefs, cooldown })} /></label><div className="two-fields"><label>{t("Έναρξη ησυχίας", "Quiet from")}<input type="time" value={prefs.quietStart} onChange={(event) => event.target.value && onPrefs({ ...prefs, quietStart: event.target.value })} /></label><label>{t("Λήξη ησυχίας", "Quiet until")}<input type="time" value={prefs.quietEnd} onChange={(event) => event.target.value && onPrefs({ ...prefs, quietEnd: event.target.value })} /></label></div><button className="secondary-action" onClick={onRequestPermission} disabled={permission === "granted" || permission === "unsupported"}><Bell size={17} />{permission === "granted" ? t("Οι ειδοποιήσεις είναι ενεργές", "Notifications are on") : t("Άδεια browser notification", "Allow browser notifications")}</button><p className="data-note">{t("Κατάσταση άδειας", "Permission")}: {permissionLabel}{lastAlert ? t(` · τελευταία ειδοποίηση ${formatAthens(lastAlert.at, language)} (δείκτης ${lastAlert.score})`, ` · last alert ${formatAthens(lastAlert.at, language)} (index ${lastAlert.score})`) : ""}</p></section><section className="panel"><span className="eyebrow">CURRENT EVALUATION</span><h2>{passes ? t("Περνά το όριο δείκτη", "Passes the index threshold") : t("Δεν περνά το όριο", "Below the threshold")}</h2><div className="alert-preview"><Bell size={20} /><div><strong>{t("Παράδειγμα παραγόμενης ειδοποίησης", "Example of the alert you would get")}</strong><p>{candidate ? `${alertBody(candidate, language)} ${t(`Δείκτης ${candidate.score.total}/100 (${confidenceLabel(candidate.score.confidence, language).toLowerCase()} εμπιστοσύνη).`, `Index ${candidate.score.total}/100 (${confidenceLabel(candidate.score.confidence, language).toLowerCase()} confidence).`)}` : t("Δεν υπάρχει κατάλληλος στόχος τώρα.", "No suitable target right now.")}</p></div></div><div className="warning-box"><AlertTriangle size={17} /><p><strong>{t("Ο browser δεν είναι server.", "The browser is not a server.")}</strong> {t("Όσο η εφαρμογή είναι ανοιχτή, ελέγχει ξανά κάθε 15 λεπτά και ειδοποιεί σύμφωνα με τους κανόνες, εκτός από τις ώρες ησυχίας. Με κλειστή εφαρμογή δεν γίνεται παρακολούθηση· αυτό απαιτεί server push και προγραμματισμένο worker.", "While the app is open it rechecks every 15 minutes and alerts by your rules, except during quiet hours. With the app closed nothing is watched; that needs server push and a scheduled worker.")}</p></div></section></div></div>;
}

function SettingsView({ observer, range, data, language, eumetsat, radarStatus, onObserver, onRange, onLanguage, onRefresh }: { observer: SavedLocation; range: { min: number; max: number }; data: OpportunityResponse | null; language: Language; eumetsat: EumetsatMetadata | null; radarStatus: DataStatus; onObserver: (value: SavedLocation) => void; onRange: (value: { min: number; max: number }) => void; onLanguage: (value: Language) => void; onRefresh: () => void }) {
  const { t, pick } = useI18n();
  const providers = (data?.providers ?? []).map((provider) => provider.id === "rainviewer"
    ? { ...provider, status: radarStatus, message: radarStatus === "available" ? tx("Live metadata διαθέσιμα· κάλυψη best-effort.", "Live metadata available; best-effort coverage.") : tx("Το live radar metadata δεν απάντησε τώρα.", "The live radar metadata did not respond.") }
    : provider);
  const sources: Array<[Localized, string, Localized]> = [
    [tx("ΕΝΣΩΜΑΤΩΜΕΝΟ · ΕΥΡΩΠΗ", "BUILT IN · EUROPE"), "EUMETSAT MTG / MSG", tx("Live συνολικοί κεραυνοί, IR, ύψος κορυφών και δείκτης K. Δεν δίνουν πολικότητα +/−, CG/IC ή peak current.", "Live total lightning, IR, cloud-top height and K-index. They give no +/− polarity, CG/IC or peak current.")],
    [tx("ΚΛΕΙΔΙ · +CG", "KEY · +CG"), "Vaisala Xweather", tx("Θετικοί και αρνητικοί κεραυνοί CG με ένταση ρεύματος σε κάθε παρατηρημένη καταιγίδα, μόνο τη νύχτα και με cache, για να μένει μέσα στο μηνιαίο όριο.", "Positive and negative CG strokes with peak current in every observed storm, checked only at night and cached to stay within the monthly allowance.")],
    [tx("ΚΛΕΙΔΙ · ΝΕΦΩΣΗ", "KEY · CLOUD"), "WeatherAPI.com · OpenWeatherMap", tx("Δεύτερη και τρίτη πρόγνωση νέφωσης για τη θέση σου· η βαθμολογία παίρνει τη διάμεσο και σε προειδοποιεί όταν διαφωνούν.", "Second and third cloud forecasts for your site; the score takes the median and warns you when they disagree.")],
    [tx("ΠΡΑΓΜΑΤΙΚΗ ΠΑΡΑΤΗΡΗΣΗ", "REAL OBSERVATION"), "AviationWeather METAR / TAF", tx("Δωρεάν μετρήσεις νέφωσης, ορατότητας και ανέμου από τον κοντινότερο αεροπορικό σταθμό, μόνο όταν είναι χρονικά και γεωγραφικά σχετικές.", "Free cloud, visibility and wind reports from the nearest airport station, used only when relevant in time and place.")],
    [tx("ΕΠΙΣΗΜΗ ΠΡΟΕΙΔΟΠΟΙΗΣΗ", "OFFICIAL WARNINGS"), "MeteoAlarm", tx("Ενεργές προειδοποιήσεις καταιγίδας και ακραίου καιρού για την Ελλάδα. Βελτιώνει την επίγνωση κινδύνου, όχι την ταυτοποίηση sprites.", "Active storm and severe-weather warnings for Greece. It improves risk awareness, not sprite detection.")],
    [tx("ΠΡΟΣΑΝΑΤΟΛΙΣΜΟΣ · OFFLINE", "ORIENTATION · OFFLINE"), "NOAA WMM2025", tx("Μετατρέπει τη μαγνητική ένδειξη της συσκευής σε αληθές αζιμούθιο, τοπικά και χωρίς κλειδί.", "Turns the device's magnetic heading into a true azimuth, locally and without a key.")],
    [tx("ΕΞΩΤΕΡΙΚΟΣ LIVE ΧΑΡΤΗΣ", "EXTERNAL LIVE MAP"), "LightningMaps / Blitzortung", tx("Χρήσιμο για οπτική διασταύρωση. Το δίκτυο δεν ξεχωρίζει αξιόπιστα CG/IC, πολικότητα ή ρεύμα.", "Useful for a visual cross-check. The network does not reliably tell CG/IC, polarity or current.")],
    [tx("ΔΩΡΕΑΝ · ΑΜΕΡΙΚΗ", "FREE · AMERICAS"), "NOAA GOES-GLM", tx("Δημόσια total-lightning δεδομένα για Αμερική και γειτονικούς ωκεανούς· δεν καλύπτει την Ελλάδα.", "Public total-lightning data for the Americas and nearby oceans; it does not cover Greece.")],
  ];
  const envelopes: Array<[string, string, Localized]> = [
    ["Red Sprites", "50–90 km", tx("κύριο μοντέλο", "main model")],
    ["Sprite Halos", "70–90 km", tx("ενημερωτικό", "informative")],
    ["ELVES", "70–100 km", tx("πειραματικό", "experimental")],
    ["Blue Jets", "15–50 km", tx("πειραματικό", "experimental")],
    ["Gigantic Jets", "15–90 km", tx("πειραματικό", "experimental")],
  ];
  return (
    <div className="view-stack">
      <div className="view-heading"><div><span className="eyebrow">SCIENTIFIC CONFIGURATION</span><h1>{t("Ρυθμίσεις & πηγές", "Settings & sources")}</h1><p>{t("Οι επιστημονικές παραδοχές είναι ορατές και δεν παρουσιάζονται ως βεβαιότητες.", "The scientific assumptions are visible and never presented as certainties.")}</p></div><Settings size={30} /></div>
      <div className="settings-columns">
        <section className="panel settings-form"><h2>{t("Παρατήρηση", "Observation")}</h2><label>{t("Γλώσσα", "Language")}<select value={language} onChange={(event) => onLanguage(event.target.value as Language)}><option value="el">Ελληνικά</option><option value="en">English</option></select></label><div className="two-fields"><label>{t("Ελάχιστη ακτίνα (km)", "Minimum range (km)")}<NumberField min={100} max={800} isValid={(min) => min < range.max} value={range.min} onCommit={(min) => onRange({ ...range, min })} /></label><label>{t("Μέγιστη ακτίνα (km)", "Maximum range (km)")}<NumberField min={100} max={800} isValid={(max) => max > range.min} value={range.max} onCommit={(max) => onRange({ ...range, max })} /></label></div><label>{t("Σημειώσεις ασφάλειας", "Safety notes")}<textarea rows={3} value={observer.safetyNotes} onChange={(event) => onObserver({ ...observer, safetyNotes: event.target.value })} /></label><button className="primary-action" onClick={onRefresh}><RefreshCw size={17} />{t("Εφαρμογή & νέα σάρωση", "Apply & rescan")}</button></section>
        <section className="panel assumptions"><h2>{t("Υψομετρικά περιβλήματα", "Altitude envelopes")}</h2>{envelopes.map(([name, altitude, status]) => <div key={name}><span><strong>{name}</strong><small>{pick(status)}</small></span><b>{altitude}</b></div>)}<p className="data-note">{t("Τα TLE είναι στιγμιαία φαινόμενα πάνω από καταιγίδες και δεν προβλέπονται με βεβαιότητα από κοινά μετεωρολογικά δεδομένα.", "TLEs are momentary events above storms and cannot be predicted with certainty from ordinary weather data.")}</p></section>
        <section className="panel data-sources-panel">
          <h2>{t("Πηγές δεδομένων", "Data sources")}</h2>
          <div className="provider-list detailed"><div><StatusDot status={eumetsat?.status ?? "stale"} /><span><strong>EUMETSAT MTG / MSG</strong><small>{eumetsat ? pick(eumetsat.message) : t("Έλεγχος δημόσιου WMS…", "Checking the public WMS…")}</small></span></div>{providers.map((provider) => <div key={provider.id}><StatusDot status={provider.status} /><span><strong>{pick(provider.label)}</strong><small>{pick(provider.message)}</small></span></div>)}</div>
          <div className="source-comparison">
            {sources.map(([kind, name, text]) => <article key={name}><span>{pick(kind)}</span><strong>{name}</strong><p>{pick(text)}</p></article>)}
          </div>
          <div className="source-links"><a href="https://view.eumetsat.int/productviewer/productDetails/mtg_fd%3Ali_afa" target="_blank" rel="noreferrer">EUMETSAT MTG-LI <ExternalLink size={14} /></a><a href="https://www.xweather.com/" target="_blank" rel="noreferrer">Vaisala Xweather <ExternalLink size={14} /></a><a href="https://www.weatherapi.com/" target="_blank" rel="noreferrer">WeatherAPI.com <ExternalLink size={14} /></a><a href="https://openweathermap.org/" target="_blank" rel="noreferrer">OpenWeatherMap <ExternalLink size={14} /></a><a href="https://aviationweather.gov/data/api/" target="_blank" rel="noreferrer">AviationWeather API <ExternalLink size={14} /></a><a href="https://meteoalarm.org/" target="_blank" rel="noreferrer">MeteoAlarm <ExternalLink size={14} /></a><a href="https://www.ncei.noaa.gov/products/world-magnetic-model" target="_blank" rel="noreferrer">NOAA WMM2025 <ExternalLink size={14} /></a><a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">Open-Meteo <ExternalLink size={14} /></a><a href="https://www.rainviewer.com/api.html" target="_blank" rel="noreferrer">RainViewer <ExternalLink size={14} /></a><a href={`https://www.lightningmaps.org/?lang=${language}`} target="_blank" rel="noreferrer">LightningMaps Live <ExternalLink size={14} /></a><a href="https://www.blitzortung.org/en/compendium.php" target="_blank" rel="noreferrer">Blitzortung <ExternalLink size={14} /></a><a href="https://goes-r.noaa.gov/spacesegment/glm.html" target="_blank" rel="noreferrer">NOAA GOES-GLM <ExternalLink size={14} /></a><a href="https://science.nasa.gov/citizen-science/spritacular/" target="_blank" rel="noreferrer">NASA Spritacular <ExternalLink size={14} /></a><a href="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast" target="_blank" rel="noreferrer">NOAA Aurora <ExternalLink size={14} /></a><a href="https://www.opentopodata.org/" target="_blank" rel="noreferrer">OpenTopoData <ExternalLink size={14} /></a></div>
          <p className="credit-line"><XweatherCredit /></p>
        </section>
        <section className="panel sprite-evidence"><div className="panel-heading"><div><span className="eyebrow">SPRITE EVIDENCE LADDER</span><h2>{t("Τι προσθέτει πραγματική βεβαιότητα", "What adds real certainty")}</h2></div><Radio size={20} /></div><div className="signal-guide"><article><span>01 · LIVE</span><strong>MTG Lightning Imager</strong><p>{t("Δωρεάν οπτική ανίχνευση συνολικών κεραυνών ανά 5 λεπτά για Ευρώπη. Δεν ξεχωρίζει CG/IC ούτε πολικότητα.", "Free optical detection of total lightning every 5 minutes over Europe. It cannot tell CG/IC or polarity.")}</p></article><article><span>02 · POLARITY</span><strong>{t("+CG και ένταση ρεύματος", "+CG and peak current")}</strong><p>{t("Με κλειδί Xweather η εφαρμογή μετρά τους θετικούς κεραυνούς +CG και την ένταση ρεύματος κάθε καταιγίδας. Το peak current όμως δεν είναι πιθανότητα sprite· ισχυρότερος δείκτης είναι η μεταβολή ροπής φορτίου, που δεν διατίθεται.", "With an Xweather key the app counts positive +CG strokes and the peak current in each storm. Peak current is not a sprite probability, though; the stronger indicator is the charge moment change, which is not available.")}</p></article><article><span>03 · VALIDATION</span><strong>NASA Spritacular</strong><p>{t("Χρησιμοποίησέ το για υποβολή και επιστημονική επιβεβαίωση φωτογραφιών με ακριβή ώρα, θέση και κατεύθυνση.", "Use it to submit photos for scientific confirmation with exact time, place and direction.")}</p></article></div><p className="data-note">{t("Η εφαρμογή δεν κάνει scraping και δεν παρουσιάζει συνολικούς κεραυνούς ως +CG.", "The app does no scraping and never presents total lightning as +CG.")}</p></section>
      </div>
    </div>
  );
}
