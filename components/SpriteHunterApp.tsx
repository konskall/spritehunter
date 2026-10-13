"use client";
/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- small pre-sized brand PNGs and a live third-party NOAA image that must not be re-encoded */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type InputHTMLAttributes } from "react";
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
  Languages,
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
  DataStatus,
  EumetsatMetadata,
  LensProfile,
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
import { isAlertPrefs, isArray, isLanguage, isLastAlert, isLensList, isLocationList, isOrientation, isSavedLocation, isSearchRange, isString } from "@/lib/persisted-validators";
import { PwaInstallButton } from "@/components/PwaRegister";

const StormMap = dynamic(() => import("@/components/StormMap"), { ssr: false });

type Screen = "dashboard" | "map" | "forecast" | "point" | "sky" | "aurora" | "locations" | "camera" | "logbook" | "alerts" | "settings";
type Language = "el" | "en";

interface RadarMetadata {
  host: string;
  generated: number;
  radar: { past: Array<{ time: number; path: string }> };
}

interface LogEntry {
  id: string;
  timestamp: string;
  target: string;
  tleType: string;
  lens: string;
  iso: number;
  aperture: number;
  shutter: string;
  success: "yes" | "no" | "uncertain";
  notes: string;
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

const strings = {
  el: {
    subtitle: "Παρατηρητήριο Ανώτερης Ατμόσφαιρας",
    refresh: "Ανανέωση δεδομένων",
    updated: "Ενημερώθηκε",
    scanning: "Αναζήτηση καταιγίδων για Red Sprites",
    noOpportunity: "Δεν εντοπίστηκε κατάλληλη ευκαιρία τώρα",
    insufficient: "Ανεπαρκή δεδομένα",
    possible: "Πιθανή ευκαιρία",
    camera: "Πού να στρέψω την κάμερα;",
    map: "Δες την καταιγίδα στον χάρτη",
    forecastOnly: "Προγνωστικός στόχος",
    score: "Δείκτης ευκαιρίας",
  },
  en: {
    subtitle: "Upper Atmosphere Observatory",
    refresh: "Refresh data",
    updated: "Updated",
    scanning: "Scanning storms for Red Sprites",
    noOpportunity: "No suitable opportunity currently detected",
    insufficient: "Insufficient data",
    possible: "Possible opportunity",
    camera: "Where should I point the camera?",
    map: "View storm on map",
    forecastOnly: "Forecast target",
    score: "Opportunity index",
  },
};

const DEFAULT_ALERT_PREFS: AlertPreferences = { minimumScore: 60, confidence: "medium", cooldown: 90, quietStart: "01:00", quietEnd: "08:00" };
// Without observed lightning the score is capped at 69; only MTG-LI storms can go higher.
const MAX_FORECAST_SCORE = 69;
const AUTO_REFRESH_MS = 15 * 60_000;
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

function relativeHours(iso: string, now: number) {
  const hours = Math.round((new Date(iso).getTime() - now) / 3_600_000);
  if (hours <= 0) return "τώρα";
  return hours === 1 ? "σε 1 ώρα" : `σε ${hours} ώρες`;
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
  if (!candidate) return strings[language].noOpportunity;
  const labels = language === "el"
    ? { poor: "Φτωχές συνθήκες", low: "Χαμηλή ευκαιρία", possible: "Πιθανή ευκαιρία", promising: "Υποσχόμενη", very_promising: "Πολύ υποσχόμενη" }
    : { poor: "Poor conditions", low: "Low opportunity", possible: "Possible opportunity", promising: "Promising", very_promising: "Very promising" };
  return labels[candidate.score.category];
}

function lightningLine(candidate: StormCandidate) {
  const detail = candidate.observedLightning;
  if (!detail) return null;
  return `MTG-LI ~${Math.round(detail.areaKm2).toLocaleString("el-GR")} km² · πριν ${detail.ageMinutes}′`;
}

function targetTitle(candidate: StormCandidate, language: Language) {
  const direction = directionLabel(candidate.bearingDeg, language);
  if (candidate.source === "observed") return `Παρατηρημένη καταιγίδα προς ${direction}`;
  return candidate.scoreInput.lightning === "observed" ? `Επιβεβαιωμένη κυψέλη προς ${direction}` : `Προγνωστική κυψέλη προς ${direction}`;
}

function targetDescription(candidate: StormCandidate) {
  const detail = candidate.observedLightning;
  if (detail) {
    return `Ο δορυφόρος MTG-LI καταγράφει κεραυνούς σε ~${Math.round(detail.areaKm2).toLocaleString("el-GR")} km² εκεί (τελευταία πριν από ${detail.ageMinutes}′, σε ${detail.frames} από ${detail.windowMinutes / 5} πεντάλεπτα). Η καταιγίδα είναι πραγματική· το MTG-LI όμως δεν διακρίνει +CG ή πολικότητα.`;
  }
  if (candidate.scoreInput.lightning === "not_detected") {
    return "Το μοντέλο δίνει καταιγίδα για αυτή την ώρα, αλλά το MTG-LI δεν ανιχνεύει κεραυνούς εκεί τώρα. Η πρόγνωση δεν επιβεβαιώνεται.";
  }
  return "Μακρινή περιοχή μοντέλου με συνδυασμό αστάθειας και υετού. Απαιτείται επιβεβαίωση κεραυνικής δραστηριότητας πριν θεωρηθεί ενεργή καταιγίδα.";
}

function alertBody(candidate: StormCandidate) {
  const where = `${candidate.distanceKm.toFixed(0)} km προς ${directionLabel(candidate.bearingDeg, "el")}`;
  const detail = candidate.observedLightning;
  if (detail) return `${candidate.source === "observed" ? "Παρατηρημένη καταιγίδα" : "Επιβεβαιωμένη κυψέλη"} ${where}: κεραυνοί MTG-LI σε ~${Math.round(detail.areaKm2).toLocaleString("el-GR")} km² πριν από ${detail.ageMinutes}′.`;
  return `Προγνωστική κυψέλη ${where} για ${formatAthens(candidate.forecastValidAt)}. Δεν έχει επιβεβαιωθεί ηλεκτρική δραστηριότητα.`;
}

function confidenceLabel(value: StormCandidate["score"]["confidence"]) {
  return { high: "Υψηλή", medium: "Μέτρια", low: "Χαμηλή", insufficient: "Ανεπαρκής" }[value];
}

function lightPollutionLabel(value: SavedLocation["lightPollution"]) {
  if (value === "low") return "χαμηλή · Bortle 1–3";
  if (value === "medium") return "μέτρια · Bortle 4–6";
  if (value === "high") return "υψηλή · Bortle 7–9";
  return "άγνωστη";
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

function Metric({ label, value, hint, icon: Icon }: { label: string; value: string; hint?: string; icon: LucideIcon }) {
  return (
    <div className="metric">
      <Icon size={17} />
      <div><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>
    </div>
  );
}

export default function SpriteHunterApp() {
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [language, setLanguage] = usePersistedState<Language>("spritehunter.language", "el", isLanguage);
  const [locations, setLocations] = usePersistedState<SavedLocation[]>("spritehunter.locations", [DEFAULT_LOCATION], isLocationList);
  const [observer, setObserver, observerHydrated] = usePersistedState<SavedLocation>("spritehunter.observer", DEFAULT_LOCATION, isSavedLocation);
  const [lenses, setLenses] = usePersistedState<LensProfile[]>("spritehunter.lenses.v2", DEFAULT_LENSES, isLensList);
  const [selectedLensId, setSelectedLensId] = usePersistedState("spritehunter.selected-lens.v2", "tokina-atxi-11-16", isString);
  const [orientation, setOrientation] = usePersistedState<"landscape" | "portrait">("spritehunter.orientation", "landscape", isOrientation);
  const [logs, setLogs] = usePersistedState<LogEntry[]>("spritehunter.logs", [], isArray<LogEntry>);
  const [range, setRange, rangeHydrated] = usePersistedState("spritehunter.range", { min: 200, max: 600 }, isSearchRange);
  const [alertPrefs, setAlertPrefs] = usePersistedState<AlertPreferences>("spritehunter.alerts", DEFAULT_ALERT_PREFS, isAlertPrefs);
  const [lastAlert, setLastAlert] = usePersistedState<{ at: string; score: number } | null>("spritehunter.last-alert", null, isLastAlert);
  const [data, setData] = useState<OpportunityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [terrain, setTerrain] = useState<TerrainProfile | null>(null);
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
  const t = strings[language];

  const rawSelected = data?.candidates.find((candidate) => candidate.id === selectedId) ?? data?.candidates[0] ?? null;
  useEffect(() => { selectedRef.current = rawSelected; }, [rawSelected]);
  // Once the DEM line of sight for the selected bearing is known, re-score that target so
  // the terrain component and confidence reflect the verified horizon everywhere it is shown.
  const selected = useMemo(() => {
    if (!rawSelected?.scoreInput || !terrain || terrain.bearingDeg !== terrainBearingKey(rawSelected.bearingDeg)) return rawSelected;
    const visibility = terrainVisibility(terrain, rawSelected.pointing);
    return visibility.status === "unknown" ? rawSelected : { ...rawSelected, score: rescoreWithTerrain(rawSelected.scoreInput, visibility.status) };
  }, [rawSelected, terrain]);
  const candidates = useMemo(
    () => (data?.candidates ?? []).map((candidate) => (selected && candidate.id === selected.id ? selected : candidate)),
    [data, selected],
  );
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
        const serverPayload = (await response.json()) as OpportunityResponse & { error?: string };
        // Client errors (invalid input, rate limit) are reported, not retried from the browser.
        if (!response.ok) throw new Error(serverPayload.error ?? "Αποτυχία ανάκτησης μετεωρολογικών δεδομένων.");
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
            ? { ...provider, message: `${provider.message} Άμεση σύνδεση browser μετά από σφάλμα του server.` }
            : provider),
          warnings: [
            ...directPayload.warnings,
            `Το server API δεν απάντησε (${response ? `HTTP ${response.status}` : "σφάλμα δικτύου"})· χρησιμοποιήθηκε browser fallback χωρίς METAR και MeteoAlarm.`,
          ],
        };
      }
      if (!isCurrent()) return false;
      loadedOnceRef.current = true;
      setData(payload);
      setCheckedAt(Date.now());
      setSelectedId(followSelection(selectedRef.current, payload.candidates));
      return true;
    } catch (refreshError) {
      if (!isCurrent() || controller.signal.aborted) return false;
      setError(refreshError instanceof Error ? refreshError.message : "Άγνωστο σφάλμα δεδομένων.");
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
        if (!response.ok) throw new Error(payload.message);
        setAurora(payload);
      })
      .catch((requestError) => {
        if ((requestError as Error).name !== "AbortError") setAurora(null);
      })
      .finally(() => { if (!controller.signal.aborted) setAuroraLoading(false); });
    return () => controller.abort();
  }, [auroraActive, hydrated, observer.latitude, observer.longitude]);
  const terrainBearing = rawSelected ? terrainBearingKey(rawSelected.bearingDeg) : null;
  useEffect(() => {
    if (terrainBearing == null || !hydrated) { setTerrain(null); return; }
    const controller = new AbortController();
    setTerrainLoading(true);
    const params = new URLSearchParams({ lat: observer.latitude.toString(), lon: observer.longitude.toString(), bearing: terrainBearing.toString(), cameraHeight: observer.cameraHeightM.toString() });
    fetch(`/api/terrain?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as TerrainProfile;
        setTerrain(response.ok ? payload : null);
      })
      .catch((terrainError) => {
        if ((terrainError as Error).name !== "AbortError") setTerrain(null);
      })
      .finally(() => { if (!controller.signal.aborted) setTerrainLoading(false); });
    return () => controller.abort();
  }, [terrainBearing, hydrated, observer.latitude, observer.longitude, observer.cameraHeightM]);
  // In-app watch: notify when the best target passes the user's rules.
  const topCandidate = data?.candidates[0] ?? null;
  useEffect(() => {
    if (!topCandidate || notificationPermission !== "granted") return;
    const now = new Date();
    if (!evaluateAlert({ score: topCandidate.score.total, confidence: topCandidate.score.confidence, last: lastAlert, prefs: alertPrefs, now })) return;
    setLastAlert({ at: now.toISOString(), score: topCandidate.score.total });
    void showBrowserNotification(
      `SpriteHunter · δείκτης ${topCandidate.score.total}/100`,
      alertBody(topCandidate),
    );
  }, [topCandidate, notificationPermission, lastAlert, alertPrefs, setLastAlert]);
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
  const checkedLabel = checkedAt ? `${t.updated} ${formatAthensTime(new Date(checkedAt), language)}` : null;
  const confirmed = refreshConfirmed && !loading;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setScreen("dashboard")} aria-label="SpriteHunter αρχική">
          <img className="brand-logo" src="/spritehunter-logo.png" alt="" width="216" height="72" />
        </button>
        <nav aria-label="Κύρια πλοήγηση">
          {navItems.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={screen === item.id ? "active" : ""} onClick={() => setScreen(item.id)}><Icon size={18} /><span>{language === "el" ? item.label : item.labelEn}</span></button>;
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="source-mini"><StatusDot status={error ? "unavailable" : loading ? "stale" : "available"} /><span>{loading ? "Έλεγχος πηγών…" : error ? "Σφάλμα παρόχου" : "Ζωντανά μοντέλα"}</span></div>
          <p>v0.4 · installable PWA</p>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <img className="mobile-brand-icon" src="/spritehunter-icon-192.png" alt="" width="34" height="34" />
          <div className="location-control">
            <MapPin size={18} />
            <div><span>Θέση παρατήρησης</span><p className="location-line"><strong>{observer.name}</strong><span className="coordinate">{observer.latitude.toFixed(4)}°, {observer.longitude.toFixed(4)}°</span></p></div>
          </div>
          <div className="top-actions">
            <PwaInstallButton />
            <button className="icon-button" title="Αλλαγή γλώσσας" aria-label="Αλλαγή γλώσσας" onClick={() => setLanguage(language === "el" ? "en" : "el")}><Languages size={18} /><span>{language.toUpperCase()}</span></button>
            <button className={`refresh-button${confirmed ? " confirmed" : ""}`} onClick={manualRefresh} disabled={loading} aria-label={confirmed && checkedLabel ? checkedLabel : t.refresh} title={checkedLabel ?? undefined}>
              {confirmed ? <Check size={17} /> : <RefreshCw size={17} className={loading ? "spin" : ""} />}
              <span>{confirmed && checkedLabel ? checkedLabel : t.refresh}</span>
            </button>
          </div>
        </header>

        <div className="content">
          {screen === "dashboard" && <DashboardView data={data} candidates={candidates} selected={selected} loading={loading} error={error} observer={observer} language={language} eumetsat={eumetsat} radarStatus={radarStatus} onPoint={goPoint} onMap={() => setScreen("map")} onSelect={selectCandidate} />}
          {screen === "map" && <MapView candidates={candidates} selected={selected} observer={observer} radar={radar} radarVisible={radarVisible} lightningVisible={lightningVisible} infraredVisible={infraredVisible} cloudTopVisible={cloudTopVisible} instabilityVisible={instabilityVisible} ringsVisible={ringsVisible} eumetsat={eumetsat} onRadar={setRadarVisible} onLightning={setLightningVisible} onInfrared={setInfraredVisible} onCloudTop={setCloudTopVisible} onInstability={setInstabilityVisible} onRings={setRingsVisible} onSelect={selectCandidate} onPoint={goPoint} />}
          {screen === "forecast" && <ForecastView candidates={candidates} selected={selected} onSelect={selectCandidate} onPoint={goPoint} />}
          {screen === "point" && <PointView candidate={selected} observer={observer} lens={selectedLens} fov={fov} framing={framing} terrain={terrain} terrainLoading={terrainLoading} sky={currentSky} language={language} />}
          {screen === "sky" && <SkyView candidate={selected} terrain={terrain} fov={fov} lens={selectedLens} orientation={orientation} sky={currentSky} onOrientation={setOrientation} />}
          {screen === "aurora" && <AuroraView aurora={aurora} loading={auroraLoading} lens={selectedLens} observer={observer} forecast={data?.observerForecast ?? []} />}
          {screen === "locations" && <LocationsView observer={observer} locations={locations} candidate={selected} onObserver={setObserver} onLocations={setLocations} />}
          {screen === "camera" && <CameraView candidate={selected} lenses={lenses} selectedLens={selectedLens} fov={fov} framing={framing} orientation={orientation} sky={currentSky} onSelect={setSelectedLensId} onLenses={setLenses} onOrientation={setOrientation} />}
          {screen === "logbook" && <LogbookView logs={logs} candidate={selected} lens={selectedLens} onLogs={setLogs} />}
          {screen === "alerts" && <AlertsView candidate={topCandidate} prefs={alertPrefs} lastAlert={lastAlert} permission={notificationPermission} onPrefs={setAlertPrefs} onRequestPermission={requestNotifications} />}
          {screen === "settings" && <SettingsView observer={observer} range={range} data={data} language={language} eumetsat={eumetsat} radarStatus={radarStatus} onObserver={setObserver} onRange={setRange} onLanguage={setLanguage} onRefresh={manualRefresh} />}
        </div>
      </main>

      <nav ref={mobileNavRef} className="mobile-nav" aria-label="Πλοήγηση κινητού">
        {navItems.map((item) => { const Icon = item.icon; return <button key={item.id} className={screen === item.id ? "active" : ""} onClick={() => setScreen(item.id)}><Icon size={19} /><span>{language === "el" ? item.label : item.labelEn}</span></button>; })}
      </nav>
    </div>
  );
}

function DashboardView({ data, candidates, selected, loading, error, observer, language, eumetsat, radarStatus, onPoint, onMap, onSelect }: {
  data: OpportunityResponse | null; candidates: StormCandidate[]; selected: StormCandidate | null; loading: boolean; error: string | null; observer: SavedLocation; language: Language; eumetsat: EumetsatMetadata | null; radarStatus: DataStatus; onPoint: () => void; onMap: () => void; onSelect: (id: string) => void;
}) {
  const t = strings[language];
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
  const airNow = data?.airQuality.find((hour) => new Date(hour.time).getTime() >= referenceTime - 30 * 60_000);
  const aviation = data?.aviation;
  // Only a fresh report counts as an observation; a stale METAR is shown as such in the field panel.
  const observedSky = aviation?.status === "available" && aviation.cloudCoverPercent != null ? aviation : null;
  const alerts = data?.weatherAlerts;
  const lightning = data?.lightning;
  const observedTargets = lightning?.inRangeCount ?? candidates.filter((candidate) => candidate.source === "observed").length;
  const alertTotal = alerts?.totalCount ?? alerts?.alerts.length ?? 0;
  const providers = (data?.providers ?? []).map((provider) => provider.id === "rainviewer"
    ? { ...provider, status: radarStatus, message: radarStatus === "available" ? "Live metadata διαθέσιμα· η γεωγραφική κάλυψη παραμένει best-effort." : "Το live radar metadata δεν απάντησε τώρα." }
    : provider);
  return (
    <div className="view-stack">
      <section className="hero-panel">
        <div className="eyebrow"><span className="live-pulse" /> {clock && skyState(new Date(clock), observer.latitude, observer.longitude, 0).sunAltitudeDeg > -6 ? "DAY WATCH" : "NIGHT WATCH"} · {clock ? formatAthens(new Date(clock), language) : "—"}</div>
        <div className="hero-grid">
          <div className="hero-copy">
            <span className={`opportunity-kicker ${selected ? `category-${selected.score.category}` : ""}`}>{loading && !data ? "Σάρωση Μεσογείου…" : error ? t.insufficient : categoryLabel(selected, language)}</span>
            <h1>{selected ? targetTitle(selected, language) : !data && !error ? t.scanning : t.noOpportunity}</h1>
            {selected && <p className="hero-valid-time">{selected.source === "observed" ? <><Zap size={16} />Παρατήρηση {formatAthens(selected.forecastValidAt, language)} · πριν από {selected.observedLightning?.ageMinutes ?? "—"}′</> : <><CalendarClock size={16} />Ισχύει {formatAthens(selected.forecastValidAt, language)} · {relativeHours(selected.forecastValidAt, referenceTime)}</>}</p>}
            <p>{selected ? targetDescription(selected) : "Η εφαρμογή θα συνεχίσει να ελέγχει πραγματικά προγνωστικά δεδομένα και κεραυνούς MTG-LI. Δεν δημιουργούνται τεχνητές καταιγίδες όταν δεν υπάρχει σήμα."}</p>
            {error && <div className="inline-error"><AlertTriangle size={17} />{error}</div>}
            <div className="hero-actions">
              <button className="primary-action" disabled={!selected} onClick={onPoint}><Crosshair size={18} />{t.camera}</button>
              <button className="secondary-action" disabled={!selected} onClick={onMap}><MapIcon size={18} />{t.map}</button>
            </div>
          </div>
          <div className="hero-score">
            <ScoreDial value={selected?.score.total ?? 0} />
            <div><span>{t.score}</span><strong>≠ πιθανότητα</strong><small>{selected ? `${confidenceLabel(selected.score.confidence)} εμπιστοσύνη δεδομένων` : "Χωρίς διαθέσιμο στόχο"}</small></div>
          </div>
        </div>
        <div className="hero-metrics">
          <Metric icon={Navigation} label="Αληθές αζιμούθιο" value={selected ? `${selected.bearingDeg.toFixed(1)}° · ${directionLabel(selected.bearingDeg, language)}` : "—"} />
          <Metric icon={Gauge} label="Απόσταση" value={selected ? `${selected.distanceKm.toFixed(0)} km` : "—"} hint="γεωδαιτική WGS84" />
          <Metric icon={Cloud} label={observedSky ? "Νέφωση (METAR)" : "Υψηλή νέφωση εδώ"} value={observedSky ? `${observedSky.cloudCoverPercent}%` : nowHour?.cloudCoverHigh != null ? `${nowHour.cloudCoverHigh}%` : "—"} hint={observedSky ? `${observedSky.stationId} · ${observedSky.distanceKm} km · υψηλή ${nowHour?.cloudCoverHigh ?? "—"}%` : "πρόγνωση μοντέλου"} />
          <Metric icon={Moon} label="Χρήσιμη ανύψωση" value={selected ? `${selected.pointing[0].elevationDeg.toFixed(1)}°–${selected.pointing.at(-1)!.elevationDeg.toFixed(1)}°` : "—"} hint="50–90 km" />
        </div>
      </section>

      <div className="dashboard-grid">
        <section className="panel candidates-panel">
          <div className="panel-heading"><div><span className="eyebrow">RANKED TARGETS</span><h2>Καλύτεροι στόχοι</h2></div><span className="count-badge">{candidates.length}</span></div>
          {candidates.length ? <div className="candidate-list">{candidates.slice(0, 5).map((candidate, index) => (
            <button key={candidate.id} className={`candidate-row ${selected?.id === candidate.id ? "selected" : ""} ${candidate.observedLightning ? "observed" : ""}`} onClick={() => onSelect(candidate.id)}>
              <span className="rank">0{index + 1}</span><span className="candidate-main"><strong>{candidate.observedLightning && <Zap size={13} className="observed-icon" aria-label="Παρατηρημένοι κεραυνοί" />}{directionLabel(candidate.bearingDeg, language)} · {candidate.distanceKm.toFixed(0)} km</strong><small>{lightningLine(candidate) ?? formatAthens(candidate.forecastValidAt, language)}{candidate.capeJkg != null || !candidate.observedLightning ? ` · CAPE ${candidate.capeJkg?.toFixed(0) ?? "—"} J/kg` : ""}{candidate.lightningPotentialJkg != null ? ` · LPI ${candidate.lightningPotentialJkg.toFixed(0)}` : ""}</small></span><span className="candidate-score">{candidate.score.total}</span><ChevronRight size={17} />
            </button>
          ))}</div> : <EmptyState title={loading ? "Σάρωση σε εξέλιξη" : "Κανένας κατάλληλος στόχος"} description="Το κενό αποτέλεσμα είναι έγκυρο: ούτε κεραυνοί MTG-LI ούτε αρκετό προγνωστικό σήμα στην ακτίνα σάρωσης." />}
        </section>

        <section className="panel timeline-panel">
          <div className="panel-heading"><div><span className="eyebrow">OBSERVER SKY</span><h2>Ο ουρανός πάνω από {observer.name.split("—")[0]}</h2></div><Eye size={20} /></div>
          <div className="mini-timeline">
            {(data?.observerForecast ?? []).filter((hour) => new Date(hour.time).getTime() >= referenceTime).slice(0, 10).map((hour) => (
              <div key={hour.time} className="timeline-hour"><span>{new Intl.DateTimeFormat("el-GR", { timeZone: "Europe/Athens", hour: "2-digit", hourCycle: "h23" }).format(new Date(hour.time))}</span><div className="cloud-bar"><i style={{ height: `${Math.max(8, hour.cloudCoverHigh ?? 0)}%` }} /></div><strong>{hour.cloudCoverHigh ?? "—"}%</strong></div>
            ))}
          </div>
          <p className="timeline-legend">Ύψος στήλης = πρόγνωση υψηλής νέφωσης (%). Χαμηλότερες στήλες σημαίνουν πιο καθαρή ανώτερη ατμόσφαιρα.</p>
          {airNow && <p className="air-quality-line"><Wind size={14} />AOD {airNow.aerosolOpticalDepth?.toFixed(2) ?? "—"} · σκόνη {airNow.dust?.toFixed(0) ?? "—"} µg/m³ · PM10 {airNow.pm10?.toFixed(0) ?? "—"} µg/m³ <small>CAMS πρόγνωση</small></p>}
        </section>

        <section className="panel field-intel-panel">
          <div className="panel-heading"><div><span className="eyebrow">GROUND TRUTH & SAFETY</span><h2>Πραγματικές παρατηρήσεις</h2></div><Radio size={20} /></div>
          <div className="field-intel-grid">
            <article>
              <div><span>ΚΕΡΑΥΝΟΙ · EUMETSAT MTG-LI</span><StatusDot status={lightning?.status ?? "stale"} /></div>
              <strong>{lightning?.status === "available" ? (observedTargets ? `${observedTargets} ${observedTargets === 1 ? "καταιγίδα" : "καταιγίδες"} στην ακτίνα σάρωσης` : "Καμία καταιγίδα στην ακτίνα σάρωσης") : "Χωρίς ζωντανή παρατήρηση"}</strong>
              <p>{lightning?.message ?? "Αναμονή για δορυφορικά δεδομένα…"}</p>
            </article>
            <article>
              <div><span>METAR / TAF</span><StatusDot status={aviation?.status ?? "stale"} /></div>
              <strong>{aviation?.stationId ? `${aviation.stationId} · ${aviation.distanceKm} km` : "Χωρίς κοντινή παρατήρηση"}</strong>
              <p>{aviation?.status === "stale" ? aviation.message : aviation?.cloudSummary ?? aviation?.message ?? "Αναμονή για AviationWeather…"}</p>
              {aviation?.visibilityM != null && <small>Ορατότητα {(aviation.visibilityM / 1000).toFixed(1)} km · άνεμος {aviation.windSpeedKmh ?? "—"} km/h · {aviation.flightCategory ?? "—"}</small>}
              {aviation?.rawMetar && <code>{aviation.rawMetar}</code>}
            </article>
            <article>
              <div><span>METEOALARM · ΕΛΛΑΔΑ</span><StatusDot status={alerts?.status ?? "stale"} /></div>
              <strong>{alertTotal ? `${alertTotal} προειδοποιήσεις · ${alerts?.nearbyCount ?? 0} κοντά σου` : "Καμία ενεργή προειδοποίηση"}</strong>
              <p>{alerts?.message ?? "Αναμονή για επίσημη ροή…"}</p>
              <div className="alert-chips">{alerts?.alerts.slice(0, 4).map((alert) => <a key={alert.id} href={alert.link} target="_blank" rel="noreferrer"><b>{alert.severity}</b>{alert.event.replace(/ warning/i, "")} · {alert.area}</a>)}</div>
            </article>
          </div>
        </section>

        <section className="panel provider-panel">
          <div className="panel-heading"><div><span className="eyebrow">PROVENANCE</span><h2>Κατάσταση δεδομένων</h2></div><Database size={20} /></div>
          <div className="provider-list"><div><StatusDot status={eumetsat?.status ?? "stale"} /><span><strong>EUMETSAT MTG / MSG</strong><small>{eumetsat?.message ?? "Έλεγχος δημόσιων δορυφορικών στρωμάτων…"}</small></span></div>{providers.map((provider) => <div key={provider.id}><StatusDot status={provider.status} /><span><strong>{provider.label}</strong><small>{provider.message}</small></span></div>)}</div>
          <p className="data-note"><ShieldAlert size={15} /> Τα μη διαθέσιμα δεδομένα δεν λογίζονται ως μηδενική δραστηριότητα.</p>
        </section>
      </div>
    </div>
  );
}

function MapView({ candidates, selected, observer, radar, radarVisible, lightningVisible, infraredVisible, cloudTopVisible, instabilityVisible, ringsVisible, eumetsat, onRadar, onLightning, onInfrared, onCloudTop, onInstability, onRings, onSelect, onPoint }: {
  candidates: StormCandidate[]; selected: StormCandidate | null; observer: SavedLocation; radar: RadarMetadata | null; radarVisible: boolean; lightningVisible: boolean; infraredVisible: boolean; cloudTopVisible: boolean; instabilityVisible: boolean; ringsVisible: boolean; eumetsat: EumetsatMetadata | null; onRadar: (value: boolean) => void; onLightning: (value: boolean) => void; onInfrared: (value: boolean) => void; onCloudTop: (value: boolean) => void; onInstability: (value: boolean) => void; onRings: (value: boolean) => void; onSelect: (id: string) => void; onPoint: () => void;
}) {
  return (
    <div className="map-layout">
      <section className="map-panel">
        <div className="map-toolbar"><div><span className="eyebrow">MEDITERRANEAN WATCH</span><h1>Ζωντανός χάρτης & πρόγνωση</h1></div><div className="layer-toggles"><label><input type="checkbox" checked={lightningVisible} onChange={(event) => onLightning(event.target.checked)} /> Κεραυνοί MTG</label><label><input type="checkbox" checked={infraredVisible} onChange={(event) => onInfrared(event.target.checked)} /> IR νέφη</label><label><input type="checkbox" checked={cloudTopVisible} onChange={(event) => onCloudTop(event.target.checked)} /> Ύψος κορυφών</label><label><input type="checkbox" checked={instabilityVisible} onChange={(event) => onInstability(event.target.checked)} /> K-index</label><label><input type="checkbox" checked={radarVisible} onChange={(event) => onRadar(event.target.checked)} /> Radar</label><label><input type="checkbox" checked={ringsVisible} onChange={(event) => onRings(event.target.checked)} /> Δακτύλιοι</label></div></div>
        <div className="map-wrap"><StormMap observer={observer} candidates={candidates} selectedId={selected?.id ?? null} radar={radar} radarVisible={radarVisible} lightningVisible={lightningVisible} infraredVisible={infraredVisible} cloudTopVisible={cloudTopVisible} instabilityVisible={instabilityVisible} ringsVisible={ringsVisible} eumetsat={eumetsat} onSelect={onSelect} /><div className="map-legend"><span><i className="legend-observer" /> Παρατηρητής</span><span><i className="legend-target" /> Πρόγνωση</span><span><i className="legend-observed" /> Παρατηρημένη καταιγίδα</span><span><i className="legend-lightning" /> MTG-LI οπτικές εκπομπές</span><span><i className="legend-uncertainty" /> Αβεβαιότητα στόχου</span></div></div>
        <p className="attribution">© OpenStreetMap contributors · Lightning/IR/CTH/K-index: EUMETSAT μέσω EUMETView WMS · Radar: RainViewer · Πρόγνωση: Open-Meteo. Το MTG-LI αναλύεται επίσης στον server και τροφοδοτεί τη βαθμολογία· τα IR, CTH και K-index είναι μόνο οπτικές απεικονίσεις.</p>
        <div className="lightning-shortcuts"><span>Εξωτερική διασταύρωση:</span><a href="https://www.lightningmaps.org/?lang=el" target="_blank" rel="noreferrer">LightningMaps Europe <ExternalLink size={13} /></a><a href="https://www.windy.com/-Weather-radar-radar" target="_blank" rel="noreferrer">Windy Radar + Lightning <ExternalLink size={13} /></a></div>
      </section>
      <aside className="target-drawer">
        {selected ? <><span className="eyebrow">{selected.source === "observed" ? "OBSERVED STORM · MTG-LI" : "SELECTED FORECAST CELL"}</span><div className="drawer-score"><ScoreDial value={selected.score.total} /><div><h2>{directionLabel(selected.bearingDeg, "el")} · {selected.distanceKm.toFixed(0)} km</h2><span className="confidence-chip">{confidenceLabel(selected.score.confidence)} εμπιστοσύνη</span></div></div><div className="drawer-metrics"><Metric icon={Navigation} label="Αζιμούθιο" value={`${selected.bearingDeg.toFixed(1)}°`} />{selected.observedLightning && <Metric icon={Zap} label="Κεραυνοί MTG-LI" value={`~${Math.round(selected.observedLightning.areaKm2).toLocaleString("el-GR")} km²`} hint={`πριν ${selected.observedLightning.ageMinutes}′ · έως ${selected.observedLightning.maxFlashesPer5Min >= 20 ? "20+" : Math.round(selected.observedLightning.maxFlashesPer5Min)}/5′`} />}<Metric icon={Activity} label="CAPE" value={`${selected.capeJkg?.toFixed(0) ?? "—"} J/kg`} /><Metric icon={Gauge} label="Lifted Index" value={selected.liftedIndex == null ? "—" : selected.liftedIndex.toFixed(1)} /><Metric icon={ShieldAlert} label="CIN" value={selected.convectiveInhibitionJkg == null ? "—" : `${selected.convectiveInhibitionJkg.toFixed(0)} J/kg`} /><Metric icon={Sparkles} label="Lightning potential" value={selected.lightningPotentialJkg == null ? "μη διαθέσιμο" : `${selected.lightningPotentialJkg.toFixed(0)} J/kg`} /><Metric icon={Cloud} label="Υετός" value={`${selected.precipitationMm?.toFixed(1) ?? "—"} mm`} /><Metric icon={Wind} label="Άνεμος μοντέλου" value={`${selected.windSpeedKmh?.toFixed(0) ?? "—"} km/h`} /></div><div className="warning-box"><AlertTriangle size={17} /><p><strong>Δύο διαφορετικά σήματα.</strong> Τα χρωματιστά σημεία του MTG-LI είναι ζωντανή συνολική κεραυνική δραστηριότητα. Το lightning potential είναι πρόγνωση μοντέλου. Κανένα από τα δύο δεν δίνει πολικότητα +CG ή peak current.</p></div><div className="science-note"><strong>Για sprites</strong><p>Τα ισχυρά +CG είναι σημαντικά, αλλά το peak current μόνο του δεν αρκεί. Ισχυρότερος φυσικός δείκτης είναι η μεταβολή ροπής φορτίου (charge moment change), η οποία δεν παρέχεται από το MTG-LI.</p></div><button className="primary-action full" onClick={onPoint}><Crosshair size={18} />Άνοιγμα στόχευσης</button></> : <EmptyState title="Χωρίς επιλεγμένο στόχο" description="Επίλεξε έναν στόχο στον χάρτη." />}
      </aside>
    </div>
  );
}

function ForecastView({ candidates, selected, onSelect, onPoint }: { candidates: StormCandidate[]; selected: StormCandidate | null; onSelect: (id: string) => void; onPoint: () => void }) {
  const explanationRef = useRef<HTMLElement>(null);
  // The explanation below the table is what a row click changes; bring it into view,
  // otherwise the click looked like it did nothing.
  const choose = (id: string) => {
    onSelect(id);
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    requestAnimationFrame(() => explanationRef.current?.scrollIntoView({ behavior, block: "nearest" }));
  };
  const parts = selected ? [
    { label: "Δραστηριότητα", hint: "κεραυνοί MTG-LI ή αστάθεια μοντέλου", value: selected.score.activity, max: 35 },
    { label: "Ατμόσφαιρα", hint: "νέφωση και ορατότητα στη θέση σου", value: selected.score.atmosphere, max: 30 },
    { label: "Έδαφος", hint: "ορίζοντας DEM προς τον στόχο", value: selected.score.terrain, max: 20 },
    { label: "Απόσταση", hint: "ιδανικά 250–550 km", value: selected.score.distance, max: 10 },
    { label: "Σκοτάδι", hint: "ύψος ήλιου και σελήνη", value: selected.score.darkness, max: 5 },
  ] : [];
  return (
    <div className="view-stack">
      <div className="view-heading"><div><span className="eyebrow">NEXT 48 HOURS</span><h1>Ευκαιρίες</h1><p>Καταιγίδες που βλέπει τώρα το MTG-LI και χονδροειδής προγνωστική σάρωση όλων των διευθύνσεων. Οι προγνωστικές θέσεις μπορούν να μετακινηθούν σημαντικά. Πάτησε μια γραμμή για την επεξήγηση του δείκτη.</p></div><CalendarClock size={30} /></div>
      <section className="panel"><div className="forecast-table"><div className="forecast-head"><span>Έγκυρη ώρα</span><span>Κατεύθυνση</span><span>Απόσταση</span><span>CAPE / Υετός</span><span>Δείκτης</span><span /></div>{candidates.length ? candidates.map((candidate) => <button key={candidate.id} className={selected?.id === candidate.id ? "selected" : ""} aria-current={selected?.id === candidate.id ? "true" : undefined} aria-controls="score-explanation" onClick={() => choose(candidate.id)}><span>{candidate.source === "observed" ? <><Zap size={13} className="observed-icon" />τώρα (MTG-LI)</> : formatAthens(candidate.forecastValidAt)}</span><span>{directionLabel(candidate.bearingDeg, "el")} · {candidate.bearingDeg.toFixed(0)}°</span><span>{candidate.distanceKm.toFixed(0)} km</span><span>{candidate.capeJkg?.toFixed(0) ?? "—"} J/kg · {candidate.precipitationMm?.toFixed(1) ?? "—"} mm</span><strong>{candidate.score.total}/100</strong><ChevronDown size={17} /></button>) : <EmptyState title="Καμία υποψήφια κυψέλη" description="Δεν βρέθηκε συνδυασμός αστάθειας και υετού που να περνά τα αρχικά φίλτρα." />}</div></section>
      {selected && (
        <section ref={explanationRef} id="score-explanation" className="panel explanation-panel">
          <div className="explanation-heading">
            <div>
              <span className="eyebrow">WHY THIS SCORE</span>
              <h2>Επεξήγηση δείκτη {selected.score.total}/100</h2>
              <p>{directionLabel(selected.bearingDeg, "el")} · {selected.bearingDeg.toFixed(0)}° · {selected.distanceKm.toFixed(0)} km · {selected.source === "observed" ? "παρατήρηση MTG-LI τώρα" : `ισχύει ${formatAthens(selected.forecastValidAt)}`}</p>
            </div>
            <span className="confidence-chip">{confidenceLabel(selected.score.confidence)} εμπιστοσύνη</span>
          </div>
          <div className="score-breakdown">{parts.map((part) => (
            <div key={part.label}><span><strong>{part.label}</strong><small>{part.hint}</small></span><div className="score-bar"><i style={{ width: `${part.value / part.max * 100}%` }} /></div><b>{part.value}/{part.max}</b></div>
          ))}</div>
          <div className="reason-columns">
            {selected.score.reasons.length > 0 && <div><h3><Check size={15} />Υπέρ του στόχου</h3><ul>{selected.score.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
            {selected.score.limitations.length > 0 && <div className="limitations"><h3><AlertTriangle size={15} />Περιορισμοί</h3><ul>{selected.score.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div>}
          </div>
          <button className="primary-action" onClick={onPoint}><Crosshair size={18} />Άνοιγμα στόχευσης</button>
        </section>
      )}
    </div>
  );
}

function signedAngle(target: number, current: number) {
  return ((target - current + 540) % 360) - 180;
}

const SETTING_LABELS: Record<string, string> = {
  aperture: "Διάφραγμα",
  iso: "ISO",
  shutter: "Έκθεση",
  whiteBalance: "Ισορροπία λευκού",
  format: "Μορφή αρχείου",
  interval: "Διάστημα λήψεων",
};

type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };

function PointView({ candidate, observer, lens, fov, framing, terrain, terrainLoading, sky, language }: {
  candidate: StormCandidate | null; observer: SavedLocation; lens: LensProfile; fov: { horizontalDeg: number; verticalDeg: number }; framing: ReturnType<typeof framingAssessment> | null; terrain: TerrainProfile | null; terrainLoading: boolean; sky: ReturnType<typeof skyState> | null; language: Language;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const orientationRef = useRef<{ eventName: string; handler: EventListener } | null>(null);
  const relativeWarningRef = useRef(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraMessage, setCameraMessage] = useState("Η εικόνα μένει στη συσκευή και δεν μεταφορτώνεται.");
  const [heading, setHeading] = useState<number | null>(null);
  const [sensorsActive, setSensorsActive] = useState(false);
  const [applyDeclination, setApplyDeclination] = useState(true);
  const [manualHeading, setManualHeading] = useState(candidate?.bearingDeg ?? 0);
  const [elevation, setElevation] = useState(candidate ? (candidate.pointing[0].elevationDeg + candidate.pointing.at(-1)!.elevationDeg) / 2 : 10);
  const [sensorMessage, setSensorMessage] = useState("Χειροκίνητη λειτουργία — χρησιμοποίησε τα ρυθμιστικά ή ενεργοποίησε τους αισθητήρες.");

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
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Η κάμερα απαιτεί HTTPS και σύγχρονο browser.");
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
      setCameraMessage("Ζωντανή εικόνα ενεργή · καμία εικόνα δεν αποθηκεύεται ή αποστέλλεται.");
    } catch (error) {
      setCameraMessage(error instanceof Error ? error.message : "Δεν ήταν δυνατή η πρόσβαση στην κάμερα.");
      stopCamera();
    }
  };

  const enableCompass = async () => {
    type PermissionDeviceOrientationEvent = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> };
    try {
      if (typeof DeviceOrientationEvent === "undefined") throw new Error("Οι αισθητήρες προσανατολισμού δεν υποστηρίζονται.");
      const OrientationEvent = DeviceOrientationEvent as PermissionDeviceOrientationEvent;
      if (OrientationEvent.requestPermission) {
        const permission = await OrientationEvent.requestPermission();
        if (permission !== "granted") throw new Error("Δεν δόθηκε άδεια αισθητήρων.");
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
          setSensorMessage("Η συσκευή δίνει μόνο σχετικό προσανατολισμό· η ανύψωση είναι ζωντανή, αλλά όρισε το αζιμούθιο χειροκίνητα.");
        }
        setElevation(Math.max(-10, Math.min(90, pointing.elevationDeg)));
        setSensorsActive(true);
      }) as EventListener;
      orientationRef.current = { eventName, handler };
      window.addEventListener(eventName, handler);
      setSensorMessage("Αισθητήρες ενεργοί. Κάνε κίνηση ∞ για βαθμονόμηση και κράτησε το κινητό μακριά από μέταλλα ή μαγνήτες.");
    } catch (error) { setSensorMessage(error instanceof Error ? error.message : "Οι αισθητήρες δεν υποστηρίζονται."); }
  };

  if (!candidate) return <EmptyState title="Δεν υπάρχει στόχος για σκόπευση" description="Επίλεξε πρώτα μια διαθέσιμη προγνωστική κυψέλη." />;
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
  const directions = `${horizontalError > 3 ? "στρέψε δεξιά" : horizontalError < -3 ? "στρέψε αριστερά" : "σωστό αζιμούθιο"} · ${verticalError > 3 ? "σήκωσε" : verticalError < -3 ? "χαμήλωσε" : "σωστή ανύψωση"}`;
  const instruction = !sensorsActive ? "Χειροκίνητη προεπισκόπηση · ενεργοποίησε τους αισθητήρες για ζωντανή καθοδήγηση" : aligned ? "Στόχος κεντραρισμένος" : directions;
  const bandWidthPercent = Math.max(6, Math.min(100, (targetHalfWidth * 2) / fov.horizontalDeg * 100));
  const recommendation = photoRecommendation(lens, sky?.moonInterference ?? false, targetHalfWidth * 2);

  return <div className="point-layout">
    <section className="point-hero">
      <span className="eyebrow">LIVE CAMERA GUIDANCE · WMM2025 TRUE NORTH</span>
      <h1>Στρέψε την κάμερα προς <em>{directionLabel(candidate.bearingDeg, language)}</em></h1>
      <div className="bearing-number"><strong>{candidate.bearingDeg.toFixed(1)}°</strong><span>αληθές αζιμούθιο · στόχος {targetElevation.toFixed(1)}° ψηλά · {formatAthens(candidate.forecastValidAt, language)}</span></div>
      <div className={`camera-guidance ${cameraActive ? "active" : ""}`}>
        <video ref={videoRef} muted playsInline aria-label="Ζωντανή εικόνα πίσω κάμερας" />
        <div className="camera-horizon" />
        <div className={`camera-target ${aligned ? "aligned" : ""}`} style={{ left: `${markerLeft}%`, top: `${markerTop}%` }}><Crosshair size={34} /><span>TLE</span></div>
        <div className={`guidance-instruction ${aligned ? "aligned" : ""}`} role="status" aria-live="polite">{instruction}</div>
        <div className="camera-readout">{sensorsActive ? "Τώρα" : "Χειροκίνητα"} {effectiveHeading.toFixed(0)}° αληθές / {elevation.toFixed(0)}° · στόχος {candidate.bearingDeg.toFixed(0)}° / {targetElevation.toFixed(0)}°</div>
      </div>
      {!cameraActive && <div className="camera-start-note"><Camera size={22} /><div><strong>Η κάμερα είναι κλειστή</strong><span>Πάτησε «Άνοιγμα κάμερας» για ζωντανή εικόνα. Ο δείκτης στόχευσης λειτουργεί και χειροκίνητα.</span></div></div>}
      <div className="guidance-actions"><button className="primary-action" onClick={toggleCamera}><Camera size={18} />{cameraActive ? "Κλείσιμο κάμερας" : "Άνοιγμα κάμερας"}</button><button className="secondary-action" onClick={enableCompass}><Compass size={18} />{sensorsActive ? "Αισθητήρες ενεργοί" : "Αισθητήρες"}</button></div>
      <p className="sensor-note">{cameraMessage} {sensorMessage}</p>
      <label className="wmm-toggle"><input type="checkbox" checked={applyDeclination} onChange={(event) => setApplyDeclination(event.target.checked)} disabled={heading == null} /><span><strong>Διόρθωση WMM2025 {declination >= 0 ? "+" : ""}{declination.toFixed(1)}°</strong> από μαγνητικό σε αληθή βορρά. Απενεργοποίησέ την μόνο αν η συσκευή σου δίνει ήδη αληθές αζιμούθιο.</span></label>
      <div className="manual-guidance"><label>Αζιμούθιο συσκευής <strong>{effectiveHeading.toFixed(0)}°</strong><input type="range" min="0" max="359" value={Math.round(effectiveHeading) % 360} onChange={(event) => { setHeading(null); setManualHeading(Number(event.target.value)); }} /></label><label>Ανύψωση κάμερας <strong>{elevation.toFixed(0)}°</strong><input type="range" min="-10" max="90" value={Math.round(elevation)} onChange={(event) => setElevation(Number(event.target.value))} /></label></div>
      <div className="point-grid"><div><span>Οριζόντιος τομέας</span><strong>{targetMin.toFixed(1)}° → {targetMax.toFixed(1)}°</strong></div><div><span>Χρήσιμη ανύψωση</span><strong>{minElevation.toFixed(1)}° → {maxElevation.toFixed(1)}°</strong></div><div><span>Ορίζοντας εδάφους</span><strong>{terrainLoading ? "υπολογισμός…" : terrain?.horizonAngleDeg != null ? `${terrain.horizonAngleDeg.toFixed(1)}°` : "μη επαληθευμένος"}</strong></div><div><span>Ορατό εύρος TLE</span><strong>{visibility.status === "clear" ? "50–90 km" : visibility.status === "partial" ? `${visibility.visibleAltitudesKm[0]}–${visibility.visibleAltitudesKm.at(-1)} km` : visibility.status === "blocked" ? "Αποκλεισμένο" : "Άγνωστο"}</strong></div></div>
    </section>
    <aside className="point-sidebar"><section className="panel compact"><span className="eyebrow">FRAME CHECK</span><h2>{lens.name}</h2><div className="fov-visual"><div className="fov-frame"><div className="target-band" style={{ width: `${bandWidthPercent}%`, height: `${Math.min(80, Math.max(4, ((maxElevation - minElevation) / fov.verticalDeg) * 100))}%` }} /></div></div><div className="fov-values"><span>Οριζόντια <strong>{fov.horizontalDeg.toFixed(1)}°</strong></span><span>Κάθετα <strong>{fov.verticalDeg.toFixed(1)}°</strong></span></div><p className={framing?.fits ? "fit-ok" : "fit-warn"}>{framing?.fits ? "Η εκτιμώμενη περιοχή χωρά με περιθώριο στο κάδρο." : "Η αβεβαιότητα δεν χωρά άνετα. Προτίμησε ευρύτερο φακό."}</p></section><section className="panel compact"><span className="eyebrow">FIELD SETTINGS</span>{Object.entries(recommendation).filter(([key]) => key in SETTING_LABELS).map(([key, value]) => <div className="setting-row" key={key}><span>{SETTING_LABELS[key]}</span><strong>{value}</strong></div>)}</section><section className="safety-card"><ShieldAlert size={20} /><div><strong>Προτεραιότητα η ασφάλεια</strong><p>Μην παρατηρείς σε εκτεθειμένο σημείο όταν η καταιγίδα πλησιάζει. {candidate.observedLightning ? "Η καταιγίδα είναι παρατηρημένη από δορυφόρο· η ακριβής θέση των sprites παραμένει αβέβαιη." : "Ο στόχος εδώ είναι προγνωστικός, όχι επιβεβαιωμένος."}</p></div></section></aside>
  </div>;
}

// A dark outline keeps sky labels readable where they cross grid and frame lines.
const SKY_LABEL_HALO = { stroke: "#0b1729", strokeWidth: 4, strokeOpacity: 0.85, paintOrder: "stroke" } as const;

function SkyView({ candidate, terrain, fov, lens, orientation, sky, onOrientation }: { candidate: StormCandidate | null; terrain: TerrainProfile | null; fov: { horizontalDeg: number; verticalDeg: number }; lens: LensProfile; orientation: "landscape" | "portrait"; sky: ReturnType<typeof skyState> | null; onOrientation: (value: "landscape" | "portrait") => void }) {
  if (!candidate) return <EmptyState title="Δεν υπάρχει στόχος" description="Η πανοραμική όψη απαιτεί επιλεγμένη προγνωστική κυψέλη." />;
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
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">ANGULAR CAMERA VIEW</span><h1>Ορίζοντας & πραγματικό κάδρο</h1><p>Ο οριζόντιος άξονας είναι αζιμούθιο γύρω από τον στόχο και ο κάθετος πραγματική γωνία ανύψωσης.</p></div><div className="segmented"><button className={orientation === "landscape" ? "active" : ""} onClick={() => onOrientation("landscape")}>Οριζόντια</button><button className={orientation === "portrait" ? "active" : ""} onClick={() => onOrientation("portrait")}>Κάθετα</button></div></div><section className="panel sky-panel"><svg viewBox="0 0 700 300" role="img" aria-label="Γωνιακό κάδρο, ζώνη TLE και κεντρικός ορίζοντας εδάφους"><defs><linearGradient id="skyGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0a1530" /><stop offset="1" stopColor="#18283b" /></linearGradient><linearGradient id="terrainGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#263b45" /><stop offset="1" stopColor="#101a20" /></linearGradient></defs><rect width="700" height="300" fill="url(#skyGradient)" />{[0, .25, .5, .75, 1].map((ratio) => <line key={ratio} x1="0" x2="700" y1={260 - ratio * 225} y2={260 - ratio * 225} stroke="#7390aa" strokeOpacity=".16" />)}<rect x="70" y={y(Math.min(maxElevation, fov.verticalDeg))} width="560" height={260 - y(Math.min(maxElevation, fov.verticalDeg))} rx="8" fill="none" stroke="#7de4ca" strokeWidth="2" strokeDasharray="7 5" /><line x1="350" x2="350" y1="30" y2="260" stroke="#7de4ca" strokeOpacity=".45" /><rect x={350 - targetWidth / 2} y={y(high)} width={targetWidth} height={Math.max(7, y(low) - y(high))} rx="5" fill="#f04362" fillOpacity=".34" stroke="#ff6d84" /><text x="350" y={Math.max(22, y(high) - 9)} textAnchor="middle" fill="#ffb1be" fontSize="12" {...SKY_LABEL_HALO}>TLE 50–90 km</text>{sky && sky.moonAltitudeDeg > 0 && moonX >= 20 && moonX <= 680 && <g transform={`translate(${moonX},${y(sky.moonAltitudeDeg)})`}><circle r="9" fill="#f4dfad" /><text x="14" y="4" fill="#dce8f3" fontSize="11">Σελήνη</text></g>}<rect x="0" y={y(horizon)} width="700" height={300 - y(horizon)} fill="url(#terrainGradient)" /><line x1="0" x2="700" y1={y(horizon)} y2={y(horizon)} stroke="#91a49c" strokeWidth="2" />{gridAngles.map((angle) => <text key={angle} x="8" y={angle === 0 ? y(0) + 4 : y(angle) - 4} dominantBaseline={angle === 0 ? "hanging" : undefined} fill="#d3e1eb" fillOpacity=".75" fontSize="11" {...SKY_LABEL_HALO}>{angle}°</text>)}<text x="692" y={y(horizon) + 4} dominantBaseline="hanging" textAnchor="end" fill="#b9c8c3" fontSize="11" {...SKY_LABEL_HALO}>Ορίζοντας DEM: {terrain?.horizonAngleDeg == null ? "μη διαθέσιμος" : `${terrain.horizonAngleDeg.toFixed(1)}°`}</text></svg><div className="horizon-caption"><span>{directionLabel(leftBearing, "el")} {leftBearing.toFixed(0)}°</span><strong>Στόχος {candidate.bearingDeg.toFixed(1)}°</strong><span>{directionLabel(rightBearing, "el")} {rightBearing.toFixed(0)}°</span></div><div className="sky-key"><span><i className="key-tle" />Θεωρητική ζώνη TLE</span><span><i className="key-fov" />Κάδρο {lens.focalLengthMm} mm</span><span><i className="key-terrain" />Όριο DEM στην κεντρική διεύθυνση</span></div></section><div className="warning-box"><Mountain size={18} /><p><strong>Περιορισμός:</strong> το DEM ελέγχει τη γραμμή προς το κέντρο του στόχου και δεν παριστάνεται πλέον ως ψεύτικο πανοραμικό ανάγλυφο 360°.</p></div></div>;
}

function AuroraView({ aurora, loading, lens, observer, forecast }: { aurora: AuroraResponse | null; loading: boolean; lens: LensProfile; observer: SavedLocation; forecast: OpportunityResponse["observerForecast"] }) {
  const referenceTime = aurora?.retrievedAt ? new Date(aurora.retrievedAt).getTime() : 0;
  const currentHour = forecast.find((hour) => new Date(hour.time).getTime() >= referenceTime) ?? forecast[0];
  const active = aurora?.level === "strong" || aurora?.level === "possible";
  const preset = aurora?.kp != null && aurora.kp >= 7
    ? { shutter: "2–5 s", iso: "1600–3200", aperture: `f/${Math.min(2.8, lens.maxAperture).toFixed(1)}`, interval: "1 s" }
    : { shutter: "5–10 s", iso: "3200–6400", aperture: `f/${Math.min(2.8, lens.maxAperture).toFixed(1)}`, interval: "1–2 s" };
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">NOAA SPACE WEATHER · AURORA MODE</span><h1>Φωτογράφιση σέλαος</h1><p>Πραγματικά δεδομένα NOAA/SWPC, με ειλικρινή αξιολόγηση για τη θέση {observer.name}.</p></div><Sparkles size={31} /></div><div className="aurora-grid"><section className={`panel aurora-status level-${aurora?.level ?? "unknown"}`}><div className="aurora-gauge"><span>Kp</span><strong>{loading ? "…" : aurora?.kp?.toFixed(1) ?? "—"}</strong><small>/ 9</small></div><div><span className="eyebrow">CURRENT ASSESSMENT</span><h2>{loading ? "Ανάκτηση διαστημικού καιρού…" : aurora?.message ?? "Τα δεδομένα NOAA δεν είναι διαθέσιμα."}</h2><p>{active ? "Κατεύθυνση: σκοτεινός βόρειος ορίζοντας, συνήθως 0–15° ανύψωση από την Ελλάδα." : "Από την Ελλάδα το σέλας είναι σπάνιο και συνήθως απαιτεί ακραία γεωμαγνητική καταιγίδα."}</p></div><div className="aurora-metrics"><Metric icon={Activity} label="Τοπικό OVATION" value={aurora?.localProbabilityPercent == null ? "—" : `${aurora.localProbabilityPercent}%`} /><Metric icon={Navigation} label="Βόρειος τομέας" value={aurora?.northernSectorProbabilityPercent == null ? "—" : `${aurora.northernSectorProbabilityPercent}%`} /><Metric icon={Cloud} label="Υψηλή νέφωση εδώ" value={currentHour?.cloudCoverHigh == null ? "—" : `${currentHour.cloudCoverHigh}%`} /></div></section><section className="panel aurora-camera"><span className="eyebrow">AURORA STARTING PRESET</span><h2>{lens.name}</h2><div className="settings-grid"><Metric icon={Camera} label="Διάφραγμα" value={preset.aperture} /><Metric icon={Gauge} label="ISO" value={preset.iso} /><Metric icon={Activity} label="Έκθεση" value={preset.shutter} /><Metric icon={RefreshCw} label="Interval" value={preset.interval} /></div><ul className="aurora-checklist"><li>Τρίποδο, RAW και χειροκίνητη εστίαση σε φωτεινό άστρο.</li><li>Ισορροπία λευκού 3.500–4.000 K και απενεργοποιημένη μακρά αποθορυβοποίηση.</li><li>Κάνε δοκιμές προς Βορρά και έλεγχε το ιστόγραμμα χωρίς να καίγεται ο ορίζοντας.</li></ul></section><section className="panel ovation-panel"><div className="panel-heading"><div><span className="eyebrow">LIVE OVATION AURORA</span><h2>Βόρειο ημισφαίριο</h2></div><a href="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast" target="_blank" rel="noreferrer">NOAA <ExternalLink size={14} /></a></div><img src="https://services.swpc.noaa.gov/images/animations/ovation/north/latest.jpg" alt="Τελευταία πρόγνωση OVATION για το βόρειο ημισφαίριο από NOAA SWPC" /><p className="data-note">Το OVATION είναι βραχυπρόθεσμο μοντέλο ωοειδούς σέλαος. Η πιθανότητα πάνω σε βόρεια γεωγραφικά πλάτη δεν σημαίνει ότι είναι ορατό από την Ελλάδα.</p></section></div></div>;
}

function LocationsView({ observer, locations, candidate, onObserver, onLocations }: { observer: SavedLocation; locations: SavedLocation[]; candidate: StormCandidate | null; onObserver: (value: SavedLocation) => void; onLocations: (value: SavedLocation[]) => void }) {
  const [name, setName] = useState("");
  const [gpsStatus, setGpsStatus] = useState("");
  const addCurrent = () => {
    const item = { ...observer, id: createId(), name: name.trim() || `Θέση ${locations.length + 1}`, favorite: false };
    onLocations([...locations, item]); setName("");
  };
  const useGps = () => {
    if (!navigator.geolocation) { setGpsStatus("Το GPS δεν υποστηρίζεται."); return; }
    setGpsStatus("Αναμονή άδειας GPS…");
    navigator.geolocation.getCurrentPosition((position) => { onObserver({ ...observer, name: "Τρέχουσα θέση GPS", latitude: position.coords.latitude, longitude: position.coords.longitude, elevationM: position.coords.altitude ?? observer.elevationM }); setGpsStatus(`Ακρίβεια περίπου ±${position.coords.accuracy.toFixed(0)} m.`); }, (gpsError) => setGpsStatus(gpsError.message), { enableHighAccuracy: true, timeout: 12_000 });
  };
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">OBSERVER NETWORK</span><h1>Θέσεις παρατήρησης</h1><p>Οι συντεταγμένες αποθηκεύονται μόνο σε αυτόν τον browser.</p></div><button className="secondary-action" onClick={useGps}><LocateFixed size={18} />Χρήση GPS</button></div>{gpsStatus && <div className="info-strip">{gpsStatus}</div>}<div className="locations-grid"><section className="panel location-editor"><h2>Ακριβής ενεργή θέση</h2><label>Όνομα<input value={observer.name} onChange={(event) => onObserver({ ...observer, name: event.target.value })} /></label><div className="two-fields"><label>Γεωγραφικό πλάτος<NumberField min={-90} max={90} value={observer.latitude} onCommit={(latitude) => onObserver({ ...observer, latitude })} /></label><label>Γεωγραφικό μήκος<NumberField min={-180} max={180} value={observer.longitude} onCommit={(longitude) => onObserver({ ...observer, longitude })} /></label></div><div className="two-fields"><label>Υψόμετρο εδάφους (m)<NumberField min={-500} max={9000} value={observer.elevationM ?? 0} onCommit={(elevationM) => onObserver({ ...observer, elevationM })} /></label><label>Ύψος κάμερας (m)<NumberField min={0} max={100} value={observer.cameraHeightM} onCommit={(cameraHeightM) => onObserver({ ...observer, cameraHeightM })} /></label></div><label>Φωτορύπανση / εκτίμηση Bortle<select value={observer.lightPollution} onChange={(event) => onObserver({ ...observer, lightPollution: event.target.value as SavedLocation["lightPollution"] })}><option value="unknown">Άγνωστη</option><option value="low">Χαμηλή · Bortle 1–3</option><option value="medium">Μέτρια · Bortle 4–6</option><option value="high">Υψηλή · Bortle 7–9</option></select></label><p className="data-note">Χειροκίνητη εκτίμηση θέσης· δεν παρουσιάζεται ως live μέτρηση φωτορύπανσης και δεν αλλάζει ακόμη τον επιστημονικό δείκτη.</p><div className="save-row"><input placeholder="Όνομα νέας αποθηκευμένης θέσης" value={name} onChange={(event) => setName(event.target.value)} /><button className="primary-action" onClick={addCurrent}><Plus size={17} />Αποθήκευση</button></div></section><section className="panel"><h2>Σύγκριση για τον ίδιο στόχο</h2><div className="location-list">{locations.map((location) => { const geometry = candidate ? inverseGeodesic(location, candidate.coordinates) : null; return <div key={location.id} className={location.id === observer.id ? "active" : ""}><button className="location-select" onClick={() => onObserver(location)}><MapPin size={18} /><span><strong>{location.name}</strong><small>{location.latitude.toFixed(4)}°, {location.longitude.toFixed(4)}° · φωτορύπανση {lightPollutionLabel(location.lightPollution)}{geometry ? ` · ${(geometry.distanceM / 1000).toFixed(0)} km · ${geometry.initialBearingDeg.toFixed(0)}°` : ""}</small></span></button>{location.id !== "sparta-home" && <button className="delete-icon" aria-label="Διαγραφή θέσης" onClick={() => onLocations(locations.filter((item) => item.id !== location.id))}><Trash2 size={16} /></button>}</div>; })}</div><p className="data-note">Η σύγκριση απόστασης/αζιμουθίου είναι διαθέσιμη άμεσα. Η σύγκριση νεφών και DEM απαιτεί ξεχωριστό έλεγχο ανά θέση.</p></section></div></div>;
}

function CameraView({ candidate, lenses, selectedLens, fov, framing, orientation, sky, onSelect, onLenses, onOrientation }: { candidate: StormCandidate | null; lenses: LensProfile[]; selectedLens: LensProfile; fov: { horizontalDeg: number; verticalDeg: number }; framing: ReturnType<typeof framingAssessment> | null; orientation: "landscape" | "portrait"; sky: ReturnType<typeof skyState> | null; onSelect: (id: string) => void; onLenses: (value: LensProfile[]) => void; onOrientation: (value: "landscape" | "portrait") => void }) {
  const [custom, setCustom] = useState({ name: "", focal: 24, aperture: 2.8 });
  const recommendation = photoRecommendation(selectedLens, sky?.moonInterference ?? false, candidate ? (Math.atan2(candidate.uncertaintyKm, candidate.distanceKm) * 360) / Math.PI : 10);
  const addLens = (event: FormEvent) => { event.preventDefault(); if (!custom.name.trim() || custom.focal <= 0 || custom.aperture <= 0) return; const lens: LensProfile = { id: createId(), name: custom.name, focalLengthMm: custom.focal, maxAperture: custom.aperture, mount: "Canon EF/EF-S", owned: true }; onLenses([...lenses, lens]); onSelect(lens.id); setCustom({ name: "", focal: 24, aperture: 2.8 }); };
  return (
    <div className="view-stack">
      <div className="view-heading">
        <div><span className="eyebrow">PHOTOGRAPHY ENGINE</span><h1>Κάμερα & φακοί</h1><p>Canon EOS 750D · APS-C 22,3 × 14,9 mm · crop 1,6×</p></div>
        <Camera size={31} />
      </div>
      <div className="equipment-grid">
        <section className="panel lens-library">
          <div className="panel-heading">
            <div><h2>Ο εξοπλισμός μου</h2><p className="panel-subtitle">{lenses.length} φακοί · {lenses.filter((lens) => lens.owned).length} διαθέσιμοι</p></div>
            <div className="segmented"><button className={orientation === "landscape" ? "active" : ""} onClick={() => onOrientation("landscape")}>Οριζόντια</button><button className={orientation === "portrait" ? "active" : ""} onClick={() => onOrientation("portrait")}>Κάθετα</button></div>
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
                    <span><strong>{lens.name}</strong><small>{lens.mount} · {lens.owned ? "Διαθέσιμος" : "Μη διαθέσιμος"}</small></span>
                    <span>{focalRange}<br /><small>{apertureRange}</small></span>
                  </button>
                  <label><input type="checkbox" checked={lens.owned} onChange={(event) => onLenses(lenses.map((item) => item.id === lens.id ? { ...item, owned: event.target.checked } : item))} /> δικός μου</label>
                  {isSelected && isZoom && (
                    <div className="zoom-control">
                      <div><span>Ενεργή εστιακή</span><strong>{lens.focalLengthMm} mm</strong></div>
                      <input
                        type="range"
                        min={lens.minFocalLengthMm}
                        max={lens.maxFocalLengthMm}
                        step="1"
                        value={lens.focalLengthMm}
                        aria-label={`Ενεργή εστιακή απόσταση για ${lens.name}`}
                        onChange={(event) => onLenses(lenses.map((item) => item.id === lens.id ? { ...item, focalLengthMm: Number(event.target.value) } : item))}
                      />
                      <small>Μέγιστο διάφραγμα στην τρέχουσα θέση: περίπου f/{effectiveMaxAperture(lens)}</small>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <form className="custom-lens" onSubmit={addLens}><h3>Προσθήκη φακού</h3><input placeholder="Όνομα" value={custom.name} onChange={(event) => setCustom({ ...custom, name: event.target.value })} /><NumberField aria-label="Εστιακή απόσταση (mm)" min={1} max={2000} value={custom.focal} onCommit={(focal) => setCustom({ ...custom, focal })} /><NumberField aria-label="Μέγιστο διάφραγμα (f/)" min={0.5} max={64} value={custom.aperture} onCommit={(aperture) => setCustom({ ...custom, aperture })} /><button><Plus size={16} />Προσθήκη</button></form>
        </section>
        <aside className="view-stack">
          <section className="panel fov-card"><span className="eyebrow">CALCULATED FIELD OF VIEW</span><div className="big-fov"><strong>{fov.horizontalDeg.toFixed(1)}° × {fov.verticalDeg.toFixed(1)}°</strong><span>πραγματικό γωνιακό κάδρο στα {selectedLens.focalLengthMm} mm</span></div>{candidate && <div className={framing?.fits ? "fit-ok" : "fit-warn"}>{framing?.fits ? <Check size={17} /> : <AlertTriangle size={17} />}{framing?.fits ? "Ο στόχος και η αβεβαιότητά του χωρούν." : "Ο στόχος μπορεί να βγει από το κάδρο."}</div>}<p className="data-note">Για αρχική αναζήτηση sprites ξεκίνα με τον Tokina στα 11 mm. Ο Jupiter 200 mm είναι κατάλληλος μόνο όταν η περιοχή έχει επιβεβαιωθεί πολύ καλά.</p></section>
          <section className="panel recommendation-card"><span className="eyebrow">EXPERIMENTAL STARTING POINT</span><h2>{recommendation.preset}</h2><div className="settings-grid"><Metric icon={Camera} label="Διάφραγμα" value={recommendation.aperture} /><Metric icon={Gauge} label="Ευαισθησία" value={recommendation.iso} /><Metric icon={Activity} label="Έκθεση" value={recommendation.shutter} /><Metric icon={Moon} label="Ισορροπία λευκού" value={recommendation.whiteBalance} /></div><div className="warning-box"><AlertTriangle size={17} /><p>{recommendation.warning} Οι ρυθμίσεις είναι πειραματική αφετηρία, όχι εγγύηση.</p></div></section>
        </aside>
      </div>
    </div>
  );
}

function LogbookView({ logs, candidate, lens, onLogs }: { logs: LogEntry[]; candidate: StormCandidate | null; lens: LensProfile; onLogs: (value: LogEntry[]) => void }) {
  const [form, setForm] = useState({ tleType: "Red Sprite", iso: 3200, aperture: effectiveMaxAperture(lens), shutter: "3 s", success: "uncertain" as LogEntry["success"], notes: "" });
  const add = (event: FormEvent) => { event.preventDefault(); onLogs([{ id: createId(), timestamp: new Date().toISOString(), target: candidate ? `${candidate.bearingDeg.toFixed(1)}° / ${candidate.distanceKm.toFixed(0)} km` : "Χωρίς στόχο", lens: lens.name, ...form }, ...logs]); setForm({ ...form, notes: "" }); };
  const download = (format: "json" | "csv") => {
    const content = format === "json" ? JSON.stringify(logs, null, 2) : ["timestamp,target,tleType,lens,iso,aperture,shutter,success,notes", ...logs.map((entry) => [entry.timestamp, entry.target, entry.tleType, entry.lens, entry.iso, entry.aperture, entry.shutter, entry.success, entry.notes].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([content], { type: format === "json" ? "application/json" : "text/csv" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `spritehunter-logbook.${format}`; anchor.click(); URL.revokeObjectURL(url);
  };
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">OBSERVATION ARCHIVE</span><h1>Ημερολόγιο παρατήρησης</h1><p>Οι καταχωρίσεις αποθηκεύονται τοπικά και οι ώρες εσωτερικά σε UTC.</p></div><div className="export-actions"><button onClick={() => download("csv")}><Download size={16} />CSV</button><button onClick={() => download("json")}><Download size={16} />JSON</button></div></div><div className="log-grid"><form className="panel log-form" onSubmit={add}><h2>Νέα καταχώριση</h2><label>Τύπος TLE<select value={form.tleType} onChange={(event) => setForm({ ...form, tleType: event.target.value })}><option>Red Sprite</option><option>Sprite Halo</option><option>ELVES</option><option>Blue Jet</option><option>Gigantic Jet</option></select></label><div className="three-fields"><label>ISO<NumberField min={50} max={409600} value={form.iso} onCommit={(iso) => setForm({ ...form, iso })} /></label><label>Διάφραγμα<NumberField min={0.5} max={64} value={form.aperture} onCommit={(aperture) => setForm({ ...form, aperture })} /></label><label>Έκθεση<input value={form.shutter} onChange={(event) => setForm({ ...form, shutter: event.target.value })} /></label></div><label>Αποτέλεσμα<select value={form.success} onChange={(event) => setForm({ ...form, success: event.target.value as LogEntry["success"] })}><option value="yes">Επιτυχία</option><option value="no">Όχι</option><option value="uncertain">Αβέβαιο</option></select></label><label>Σημειώσεις<textarea rows={4} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label><button className="primary-action"><Plus size={17} />Καταχώριση</button></form><section className="panel"><h2>Προηγούμενες παρατηρήσεις</h2>{logs.length ? <div className="log-list">{logs.map((entry) => <article key={entry.id}><div><strong>{entry.tleType}</strong><span className={`result-${entry.success}`}>{entry.success === "yes" ? "Επιτυχία" : entry.success === "no" ? "Όχι" : "Αβέβαιο"}</span></div><small>{formatAthens(entry.timestamp)} · {entry.target}</small><p>{entry.lens} · f/{entry.aperture} · ISO {entry.iso} · {entry.shutter}</p>{entry.notes && <blockquote>{entry.notes}</blockquote>}<button aria-label="Διαγραφή" onClick={() => onLogs(logs.filter((item) => item.id !== entry.id))}><Trash2 size={15} /></button></article>)}</div> : <EmptyState title="Το ημερολόγιο είναι κενό" description="Κατέγραψε τις πραγματικές προσπάθειες για μελλοντική αξιολόγηση του δείκτη." />}</section></div></div>;
}

function AlertsView({ candidate, prefs, lastAlert, permission, onPrefs, onRequestPermission }: {
  candidate: StormCandidate | null; prefs: AlertPreferences; lastAlert: { at: string; score: number } | null; permission: NotificationPermission | "unsupported"; onPrefs: (value: AlertPreferences) => void; onRequestPermission: () => void;
}) {
  const minimumScore = prefs.minimumScore;
  const passes = candidate != null && candidate.score.total >= minimumScore;
  const permissionLabel = { granted: "επιτρέπεται", denied: "απορρίφθηκε (άλλαξέ το από τις ρυθμίσεις του browser)", default: "δεν έχει ζητηθεί", unsupported: "δεν υποστηρίζεται σε αυτόν τον browser" }[permission];
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">EVENT-DRIVEN WATCH</span><h1>Ειδοποιήσεις</h1><p>Ειδοποίηση μόνο όταν η ευκαιρία αλλάζει ουσιαστικά — όχι συνεχής θόρυβος.</p></div><Bell size={30} /></div><div className="alerts-grid"><section className="panel alert-settings"><h2>Κανόνες ειδοποίησης</h2><label>Ελάχιστος δείκτης <strong>{minimumScore}/100</strong><input type="range" min="30" max="95" value={minimumScore} onChange={(event) => onPrefs({ ...prefs, minimumScore: Number(event.target.value) })} /></label><p className="data-note">{minimumScore > MAX_FORECAST_SCORE ? `Πάνω από ${MAX_FORECAST_SCORE} ειδοποιείσαι μόνο για καταιγίδες με παρατηρημένους κεραυνούς MTG-LI.` : `Οι προγνωστικοί στόχοι φτάνουν έως ${MAX_FORECAST_SCORE}· πάνω από αυτό απαιτούνται παρατηρημένοι κεραυνοί.`}</p><label>Ελάχιστη εμπιστοσύνη<select value={prefs.confidence} onChange={(event) => onPrefs({ ...prefs, confidence: event.target.value as AlertPreferences["confidence"] })}><option value="low">Χαμηλή</option><option value="medium">Μέτρια — έδαφος ή κεραυνοί</option><option value="high">Υψηλή — κεραυνοί και έδαφος</option></select></label><p className="data-note">Μέτρια: επαληθευμένο έδαφος ή παρατηρημένοι κεραυνοί MTG-LI. Υψηλή: και τα δύο.</p><label>Cooldown (λεπτά)<NumberField min={0} max={1440} value={prefs.cooldown} onCommit={(cooldown) => onPrefs({ ...prefs, cooldown })} /></label><div className="two-fields"><label>Έναρξη ησυχίας<input type="time" value={prefs.quietStart} onChange={(event) => event.target.value && onPrefs({ ...prefs, quietStart: event.target.value })} /></label><label>Λήξη ησυχίας<input type="time" value={prefs.quietEnd} onChange={(event) => event.target.value && onPrefs({ ...prefs, quietEnd: event.target.value })} /></label></div><button className="secondary-action" onClick={onRequestPermission} disabled={permission === "granted" || permission === "unsupported"}><Bell size={17} />{permission === "granted" ? "Οι ειδοποιήσεις είναι ενεργές" : "Άδεια browser notification"}</button><p className="data-note">Κατάσταση άδειας: {permissionLabel}{lastAlert ? ` · τελευταία ειδοποίηση ${formatAthens(lastAlert.at)} (δείκτης ${lastAlert.score})` : ""}</p></section><section className="panel"><span className="eyebrow">CURRENT EVALUATION</span><h2>{passes ? "Περνά το όριο δείκτη" : "Δεν περνά το όριο"}</h2><div className="alert-preview"><Bell size={20} /><div><strong>Παράδειγμα παραγόμενης ειδοποίησης</strong><p>{candidate ? `${alertBody(candidate)} Δείκτης ${candidate.score.total}/100 (${confidenceLabel(candidate.score.confidence).toLowerCase()} εμπιστοσύνη).` : "Δεν υπάρχει κατάλληλος στόχος τώρα."}</p></div></div><div className="warning-box"><AlertTriangle size={17} /><p><strong>Ο browser δεν είναι server.</strong> Όσο η εφαρμογή είναι ανοιχτή, ελέγχει ξανά κάθε 15 λεπτά και ειδοποιεί σύμφωνα με τους κανόνες, εκτός από τις ώρες ησυχίας. Με κλειστή εφαρμογή δεν γίνεται παρακολούθηση· αυτό απαιτεί server push και προγραμματισμένο worker.</p></div></section></div></div>;
}

function SettingsView({ observer, range, data, language, eumetsat, radarStatus, onObserver, onRange, onLanguage, onRefresh }: { observer: SavedLocation; range: { min: number; max: number }; data: OpportunityResponse | null; language: Language; eumetsat: EumetsatMetadata | null; radarStatus: DataStatus; onObserver: (value: SavedLocation) => void; onRange: (value: { min: number; max: number }) => void; onLanguage: (value: Language) => void; onRefresh: () => void }) {
  const providers = (data?.providers ?? []).map((provider) => provider.id === "rainviewer"
    ? { ...provider, status: radarStatus, message: radarStatus === "available" ? "Live metadata διαθέσιμα· κάλυψη best-effort." : "Το live radar metadata δεν απάντησε τώρα." }
    : provider);
  return (
    <div className="view-stack">
      <div className="view-heading"><div><span className="eyebrow">SCIENTIFIC CONFIGURATION</span><h1>Ρυθμίσεις & πηγές</h1><p>Οι επιστημονικές παραδοχές είναι ορατές και δεν παρουσιάζονται ως βεβαιότητες.</p></div><Settings size={30} /></div>
      <div className="settings-columns">
        <section className="panel settings-form"><h2>Παρατήρηση</h2><label>Γλώσσα<select value={language} onChange={(event) => onLanguage(event.target.value as Language)}><option value="el">Ελληνικά</option><option value="en">English</option></select></label><div className="two-fields"><label>Ελάχιστη ακτίνα (km)<NumberField min={100} max={800} isValid={(min) => min < range.max} value={range.min} onCommit={(min) => onRange({ ...range, min })} /></label><label>Μέγιστη ακτίνα (km)<NumberField min={100} max={800} isValid={(max) => max > range.min} value={range.max} onCommit={(max) => onRange({ ...range, max })} /></label></div><label>Σημειώσεις ασφάλειας<textarea rows={3} value={observer.safetyNotes} onChange={(event) => onObserver({ ...observer, safetyNotes: event.target.value })} /></label><button className="primary-action" onClick={onRefresh}><RefreshCw size={17} />Εφαρμογή & νέα σάρωση</button></section>
        <section className="panel assumptions"><h2>Υψομετρικά περιβλήματα</h2>{[["Red Sprites", "50–90 km", "κύριο μοντέλο"], ["Sprite Halos", "70–90 km", "ενημερωτικό"], ["ELVES", "70–100 km", "πειραματικό"], ["Blue Jets", "15–50 km", "πειραματικό"], ["Gigantic Jets", "15–90 km", "πειραματικό"]].map(([name, altitude, status]) => <div key={name}><span><strong>{name}</strong><small>{status}</small></span><b>{altitude}</b></div>)}<p className="data-note">Τα TLE είναι στιγμιαία φαινόμενα πάνω από καταιγίδες και δεν προβλέπονται με βεβαιότητα από κοινά μετεωρολογικά δεδομένα.</p></section>
        <section className="panel data-sources-panel">
          <h2>Πηγές δεδομένων</h2>
          <div className="provider-list detailed"><div><StatusDot status={eumetsat?.status ?? "stale"} /><span><strong>EUMETSAT MTG / MSG</strong><small>{eumetsat?.message ?? "Έλεγχος δημόσιου WMS…"}</small></span></div>{providers.map((provider) => <div key={provider.id}><StatusDot status={provider.status} /><span><strong>{provider.label}</strong><small>{provider.message}</small></span></div>)}</div>
          <div className="source-comparison">
            <article><span>ΕΝΣΩΜΑΤΩΜΕΝΟ · ΕΥΡΩΠΗ</span><strong>EUMETSAT MTG / MSG</strong><p>Live συνολικοί κεραυνοί, IR, ύψος κορυφών και δείκτης K ως οπτικά layers. Δεν δίνουν πολικότητα +/−, CG/IC ή peak current.</p></article>
            <article><span>ΠΡΑΓΜΑΤΙΚΗ ΠΑΡΑΤΗΡΗΣΗ</span><strong>AviationWeather METAR / TAF</strong><p>Δωρεάν παγκόσμιες μετρήσεις νέφωσης, ορατότητας και ανέμου από τον κοντινότερο αεροπορικό σταθμό. Στη βαθμολογία χρησιμοποιούνται μόνο όταν είναι χρονικά και γεωγραφικά σχετικά.</p></article>
            <article><span>ΕΠΙΣΗΜΗ ΠΡΟΕΙΔΟΠΟΙΗΣΗ</span><strong>MeteoAlarm</strong><p>Ενεργές προειδοποιήσεις καταιγίδας και ακραίου καιρού για την Ελλάδα. Βελτιώνει την επίγνωση κινδύνου, όχι την ταυτοποίηση sprites.</p></article>
            <article><span>ΠΡΟΣΑΝΑΤΟΛΙΣΜΟΣ · OFFLINE</span><strong>NOAA WMM2025</strong><p>Μετατρέπει τη μαγνητική ένδειξη της συσκευής σε αληθές αζιμούθιο. Η διόρθωση γίνεται τοπικά χωρίς API key.</p></article>
            <article><span>ΕΞΩΤΕΡΙΚΟΣ LIVE ΧΑΡΤΗΣ</span><strong>LightningMaps / Blitzortung</strong><p>Χρήσιμο για οπτική διασταύρωση. Το δίκτυο δηλώνει ότι δεν ξεχωρίζει αξιόπιστα CG/IC, πολικότητα ή ρεύμα· δεν χρησιμοποιείται ως +CG feed.</p></article>
            <article><span>API KEY · PLAN-DEPENDENT</span><strong>Weatherbit Lightning</strong><p>Επιστρέφει πρόσφατες θέσεις και χρόνους flashes. Δεν αντικαθιστά πάροχο με επαληθευμένη πολικότητα και peak current.</p></article>
            <article><span>ΔΩΡΕΑΝ · ΑΜΕΡΙΚΗ</span><strong>NOAA GOES-GLM</strong><p>Δημόσια total-lightning δεδομένα για Αμερική και γειτονικούς ωκεανούς· δεν καλύπτει την Ελλάδα.</p></article>
          </div>
          <div className="source-links"><a href="https://view.eumetsat.int/productviewer/productDetails/mtg_fd%3Ali_afa" target="_blank" rel="noreferrer">EUMETSAT MTG-LI <ExternalLink size={14} /></a><a href="https://aviationweather.gov/data/api/" target="_blank" rel="noreferrer">AviationWeather API <ExternalLink size={14} /></a><a href="https://meteoalarm.org/" target="_blank" rel="noreferrer">MeteoAlarm <ExternalLink size={14} /></a><a href="https://www.ncei.noaa.gov/products/world-magnetic-model" target="_blank" rel="noreferrer">NOAA WMM2025 <ExternalLink size={14} /></a><a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">Open-Meteo <ExternalLink size={14} /></a><a href="https://www.rainviewer.com/api.html" target="_blank" rel="noreferrer">RainViewer <ExternalLink size={14} /></a><a href="https://www.lightningmaps.org/?lang=el" target="_blank" rel="noreferrer">LightningMaps Live <ExternalLink size={14} /></a><a href="https://www.blitzortung.org/en/compendium.php" target="_blank" rel="noreferrer">Blitzortung <ExternalLink size={14} /></a><a href="https://www.weatherbit.io/api/lightning-current" target="_blank" rel="noreferrer">Weatherbit Lightning API <ExternalLink size={14} /></a><a href="https://goes-r.noaa.gov/spacesegment/glm.html" target="_blank" rel="noreferrer">NOAA GOES-GLM <ExternalLink size={14} /></a><a href="https://science.nasa.gov/citizen-science/spritacular/" target="_blank" rel="noreferrer">NASA Spritacular <ExternalLink size={14} /></a><a href="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast" target="_blank" rel="noreferrer">NOAA Aurora <ExternalLink size={14} /></a><a href="https://www.opentopodata.org/" target="_blank" rel="noreferrer">OpenTopoData <ExternalLink size={14} /></a></div>
          <p className="data-note">Δεν προστέθηκε OpenWeather “Historical Lightning”, επειδή δεν βρέθηκε επίσημα τεκμηριωμένο endpoint κεραυνικών παρατηρήσεων. Για την Ελλάδα η εφαρμογή κρατά το δωρεάν MTG-LI ως κύρια live στρώση.</p>
        </section>
        <section className="panel sprite-evidence"><div className="panel-heading"><div><span className="eyebrow">SPRITE EVIDENCE LADDER</span><h2>Τι προσθέτει πραγματική βεβαιότητα</h2></div><Radio size={20} /></div><div className="signal-guide"><article><span>01 · LIVE</span><strong>MTG Lightning Imager</strong><p>Δωρεάν οπτική ανίχνευση συνολικών κεραυνών ανά 5 λεπτά για Ευρώπη. Δεν ξεχωρίζει CG/IC ούτε πολικότητα.</p></article><article><span>02 · POLARITY</span><strong>+CG και charge moment</strong><p>Η θετική πολικότητα είναι χρήσιμη, αλλά το peak current δεν είναι πιθανότητα sprite. Η μεταβολή ροπής φορτίου είναι ισχυρότερος φυσικός δείκτης.</p></article><article><span>03 · VALIDATION</span><strong>NASA Spritacular</strong><p>Χρησιμοποίησέ το για υποβολή και επιστημονική επιβεβαίωση φωτογραφιών με ακριβή ώρα, θέση και κατεύθυνση.</p></article></div><p className="data-note">Δεν υπάρχει επαληθευμένη δωρεάν δημόσια πηγή για Ελλάδα που να παρέχει ταυτόχρονα +CG, peak current και charge moment. Η εφαρμογή δεν κάνει scraping και δεν παρουσιάζει total-lightning ως +CG.</p></section>
      </div>
    </div>
  );
}
