"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  BookOpen,
  CalendarClock,
  Camera,
  Check,
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
  type LucideIcon,
} from "lucide-react";
import type {
  LensProfile,
  OpportunityResponse,
  SavedLocation,
  StormCandidate,
  TerrainProfile,
} from "@/lib/domain";
import { CANON_750D, DEFAULT_LENSES, fieldOfView, framingAssessment, photoRecommendation } from "@/lib/camera";
import { angularDifference, inverseGeodesic } from "@/lib/geodesy";
import { skyState } from "@/lib/astronomy";
import { terrainVisibility } from "@/lib/terrain";
import { formatAthens } from "@/lib/time";

const StormMap = dynamic(() => import("@/components/StormMap"), { ssr: false });

type Screen = "dashboard" | "map" | "forecast" | "point" | "sky" | "locations" | "camera" | "logbook" | "alerts" | "settings";
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
    noOpportunity: "No suitable opportunity currently detected",
    insufficient: "Insufficient data",
    possible: "Possible opportunity",
    camera: "Where should I point the camera?",
    map: "View storm on map",
    forecastOnly: "Forecast target",
    score: "Opportunity index",
  },
};

function safeRead<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function usePersistedState<T>(key: string, fallback: T) {
  const [value, setValue] = useState(fallback);
  const fallbackRef = useRef(fallback);
  useEffect(() => setValue(safeRead(key, fallbackRef.current)), [key]);
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be disabled. */ }
  }, [key, value]);
  return [value, setValue] as const;
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

function confidenceLabel(value: StormCandidate["score"]["confidence"]) {
  return { high: "Υψηλή", medium: "Μέτρια", low: "Χαμηλή", insufficient: "Ανεπαρκής" }[value];
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
  const [language, setLanguage] = usePersistedState<Language>("spritehunter.language", "el");
  const [locations, setLocations] = usePersistedState<SavedLocation[]>("spritehunter.locations", [DEFAULT_LOCATION]);
  const [observer, setObserver] = usePersistedState<SavedLocation>("spritehunter.observer", DEFAULT_LOCATION);
  const [lenses, setLenses] = usePersistedState<LensProfile[]>("spritehunter.lenses", DEFAULT_LENSES);
  const [selectedLensId, setSelectedLensId] = usePersistedState("spritehunter.selected-lens", "generic-24");
  const [orientation, setOrientation] = usePersistedState<"landscape" | "portrait">("spritehunter.orientation", "landscape");
  const [logs, setLogs] = usePersistedState<LogEntry[]>("spritehunter.logs", []);
  const [range, setRange] = usePersistedState("spritehunter.range", { min: 200, max: 600 });
  const [data, setData] = useState<OpportunityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [terrain, setTerrain] = useState<TerrainProfile | null>(null);
  const [terrainLoading, setTerrainLoading] = useState(false);
  const [radar, setRadar] = useState<RadarMetadata | null>(null);
  const [radarVisible, setRadarVisible] = useState(true);
  const [ringsVisible, setRingsVisible] = useState(true);
  const t = strings[language];
  const selected = data?.candidates.find((candidate) => candidate.id === selectedId) ?? data?.candidates[0] ?? null;
  const selectedLens = lenses.find((lens) => lens.id === selectedLensId) ?? lenses[0];
  const fov = fieldOfView(CANON_750D, selectedLens.focalLengthMm, orientation);
  const uncertaintyAngle = selected ? (Math.atan2(selected.uncertaintyKm, selected.distanceKm) * 180) / Math.PI * 2 : 0;
  const framing = selected
    ? framingAssessment(fov.horizontalDeg, fov.verticalDeg, uncertaintyAngle, selected.pointing[0].elevationDeg, selected.pointing.at(-1)!.elevationDeg)
    : null;
  const currentSky = selected ? skyState(new Date(selected.forecastValidAt), observer.latitude, observer.longitude, selected.bearingDeg) : null;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        lat: observer.latitude.toString(), lon: observer.longitude.toString(), elevation: String(observer.elevationM ?? 0), minKm: String(range.min), maxKm: String(range.max),
      });
      const response = await fetch(`/api/opportunities?${params}`);
      const payload = (await response.json()) as OpportunityResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Αποτυχία ανάκτησης μετεωρολογικών δεδομένων.");
      setData(payload);
      setSelectedId((current) => payload.candidates.some((candidate) => candidate.id === current) ? current : payload.candidates[0]?.id ?? null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Άγνωστο σφάλμα δεδομένων.");
    } finally {
      setLoading(false);
    }
  }, [observer.latitude, observer.longitude, observer.elevationM, range.min, range.max]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    fetch("/api/radar").then(async (response) => {
      if (response.ok) setRadar((await response.json()) as RadarMetadata);
    }).catch(() => setRadar(null));
  }, []);
  useEffect(() => {
    if (!selected) { setTerrain(null); return; }
    const controller = new AbortController();
    setTerrainLoading(true);
    const params = new URLSearchParams({ lat: observer.latitude.toString(), lon: observer.longitude.toString(), bearing: selected.bearingDeg.toString(), cameraHeight: observer.cameraHeightM.toString() });
    fetch(`/api/terrain?${params}`, { signal: controller.signal })
      .then(async (response) => (await response.json()) as TerrainProfile)
      .then(setTerrain)
      .catch((terrainError) => {
        if ((terrainError as Error).name !== "AbortError") setTerrain(null);
      })
      .finally(() => setTerrainLoading(false));
    return () => controller.abort();
  }, [selected, observer.latitude, observer.longitude, observer.cameraHeightM]);

  const selectCandidate = (id: string) => setSelectedId(id);
  const goPoint = () => setScreen("point");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setScreen("dashboard")} aria-label="SpriteHunter αρχική">
          <span className="brand-mark"><Sparkles size={20} /></span>
          <span><strong>SpriteHunter</strong><small>{t.subtitle}</small></span>
        </button>
        <nav aria-label="Κύρια πλοήγηση">
          {navItems.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={screen === item.id ? "active" : ""} onClick={() => setScreen(item.id)}><Icon size={18} /><span>{language === "el" ? item.label : item.labelEn}</span></button>;
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="source-mini"><StatusDot status={error ? "unavailable" : loading ? "stale" : "available"} /><span>{loading ? "Έλεγχος πηγών…" : error ? "Σφάλμα παρόχου" : "Ζωντανά μοντέλα"}</span></div>
          <p>v0.1 scientific preview</p>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div className="location-control">
            <MapPin size={18} />
            <div><span>Θέση παρατήρησης</span><strong>{observer.name}</strong></div>
            <span className="coordinate">{observer.latitude.toFixed(4)}°, {observer.longitude.toFixed(4)}°</span>
          </div>
          <div className="top-actions">
            <button className="icon-button" title="Αλλαγή γλώσσας" onClick={() => setLanguage(language === "el" ? "en" : "el")}><Languages size={18} /><span>{language.toUpperCase()}</span></button>
            <button className="refresh-button" onClick={refresh} disabled={loading}><RefreshCw size={17} className={loading ? "spin" : ""} /><span>{t.refresh}</span></button>
          </div>
        </header>

        <div className="content">
          {screen === "dashboard" && <DashboardView data={data} selected={selected} loading={loading} error={error} observer={observer} language={language} onPoint={goPoint} onMap={() => setScreen("map")} onSelect={selectCandidate} />}
          {screen === "map" && <MapView data={data} selected={selected} observer={observer} radar={radar} radarVisible={radarVisible} ringsVisible={ringsVisible} onRadar={setRadarVisible} onRings={setRingsVisible} onSelect={selectCandidate} onPoint={goPoint} />}
          {screen === "forecast" && <ForecastView data={data} selected={selected} onSelect={selectCandidate} onPoint={goPoint} />}
          {screen === "point" && <PointView candidate={selected} lens={selectedLens} fov={fov} framing={framing} terrain={terrain} terrainLoading={terrainLoading} sky={currentSky} language={language} />}
          {screen === "sky" && <SkyView candidate={selected} terrain={terrain} fov={fov} lens={selectedLens} orientation={orientation} sky={currentSky} onOrientation={setOrientation} />}
          {screen === "locations" && <LocationsView observer={observer} locations={locations} candidate={selected} onObserver={setObserver} onLocations={setLocations} />}
          {screen === "camera" && <CameraView candidate={selected} lenses={lenses} selectedLens={selectedLens} fov={fov} framing={framing} orientation={orientation} sky={currentSky} onSelect={setSelectedLensId} onLenses={setLenses} onOrientation={setOrientation} />}
          {screen === "logbook" && <LogbookView logs={logs} candidate={selected} lens={selectedLens} onLogs={setLogs} />}
          {screen === "alerts" && <AlertsView candidate={selected} />}
          {screen === "settings" && <SettingsView observer={observer} range={range} data={data} language={language} onObserver={setObserver} onRange={setRange} onLanguage={setLanguage} onRefresh={refresh} />}
        </div>
      </main>

      <nav className="mobile-nav" aria-label="Πλοήγηση κινητού">
        {navItems.map((item) => { const Icon = item.icon; return <button key={item.id} className={screen === item.id ? "active" : ""} onClick={() => setScreen(item.id)}><Icon size={19} /><span>{language === "el" ? item.label : item.labelEn}</span></button>; })}
      </nav>
    </div>
  );
}

function DashboardView({ data, selected, loading, error, observer, language, onPoint, onMap, onSelect }: {
  data: OpportunityResponse | null; selected: StormCandidate | null; loading: boolean; error: string | null; observer: SavedLocation; language: Language; onPoint: () => void; onMap: () => void; onSelect: (id: string) => void;
}) {
  const t = strings[language];
  const referenceTime = data ? new Date(data.fetchedAt).getTime() : 0;
  const nowHour = data?.observerForecast.find((hour) => new Date(hour.time).getTime() >= referenceTime) ?? data?.observerForecast[0];
  return (
    <div className="view-stack">
      <section className="hero-panel">
        <div className="eyebrow"><span className="live-pulse" /> NIGHT WATCH · {formatAthens(new Date(), language)}</div>
        <div className="hero-grid">
          <div className="hero-copy">
            <span className={`opportunity-kicker ${selected ? `category-${selected.score.category}` : ""}`}>{loading ? "Σάρωση Μεσογείου…" : error ? t.insufficient : categoryLabel(selected, language)}</span>
            <h1>{selected ? `Προγνωστική κυψέλη προς ${directionLabel(selected.bearingDeg, language)}` : t.noOpportunity}</h1>
            <p>{selected ? "Μακρινή περιοχή μοντέλου με συνδυασμό αστάθειας και υετού. Απαιτείται επιβεβαίωση κεραυνικής δραστηριότητας πριν θεωρηθεί ενεργή καταιγίδα." : "Η εφαρμογή θα συνεχίσει να ελέγχει πραγματικά προγνωστικά δεδομένα. Δεν δημιουργούνται τεχνητές καταιγίδες όταν δεν υπάρχει σήμα."}</p>
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
          <Metric icon={Cloud} label="Υψηλή νέφωση εδώ" value={nowHour?.cloudCoverHigh != null ? `${nowHour.cloudCoverHigh}%` : "—"} hint="πρόγνωση μοντέλου" />
          <Metric icon={Moon} label="Χρήσιμη ανύψωση" value={selected ? `${selected.pointing[0].elevationDeg.toFixed(1)}°–${selected.pointing.at(-1)!.elevationDeg.toFixed(1)}°` : "—"} hint="50–90 km" />
        </div>
      </section>

      <div className="dashboard-grid">
        <section className="panel candidates-panel">
          <div className="panel-heading"><div><span className="eyebrow">RANKED TARGETS</span><h2>Καλύτεροι προγνωστικοί στόχοι</h2></div><span className="count-badge">{data?.candidates.length ?? 0}</span></div>
          {data?.candidates.length ? <div className="candidate-list">{data.candidates.slice(0, 5).map((candidate, index) => (
            <button key={candidate.id} className={`candidate-row ${selected?.id === candidate.id ? "selected" : ""}`} onClick={() => onSelect(candidate.id)}>
              <span className="rank">0{index + 1}</span><span className="candidate-main"><strong>{directionLabel(candidate.bearingDeg, language)} · {candidate.distanceKm.toFixed(0)} km</strong><small>{formatAthens(candidate.forecastValidAt, language)} · CAPE {candidate.capeJkg?.toFixed(0) ?? "—"} J/kg</small></span><span className="candidate-score">{candidate.score.total}</span><ChevronRight size={17} />
            </button>
          ))}</div> : <EmptyState title={loading ? "Σάρωση σε εξέλιξη" : "Καμία κατάλληλη προγνωστική κυψέλη"} description="Το κενό αποτέλεσμα είναι έγκυρο: υψηλό CAPE μόνο του δεν αρκεί για σύσταση." />}
        </section>

        <section className="panel timeline-panel">
          <div className="panel-heading"><div><span className="eyebrow">OBSERVER SKY</span><h2>Ο ουρανός πάνω από {observer.name.split("—")[0]}</h2></div><Eye size={20} /></div>
          <div className="mini-timeline">
            {(data?.observerForecast ?? []).filter((hour) => new Date(hour.time).getTime() >= referenceTime).slice(0, 10).map((hour) => (
              <div key={hour.time} className="timeline-hour"><span>{new Intl.DateTimeFormat("el-GR", { timeZone: "Europe/Athens", hour: "2-digit" }).format(new Date(hour.time))}</span><div className="cloud-bar"><i style={{ height: `${Math.max(8, hour.cloudCoverHigh ?? 0)}%` }} /></div><strong>{hour.cloudCoverHigh ?? "—"}%</strong></div>
            ))}
          </div>
          <div className="timeline-legend"><span><i className="legend-clear" />χαμηλή υψηλή νέφωση</span><span><i className="legend-cloud" />κλειστός ουρανός</span></div>
        </section>

        <section className="panel provider-panel">
          <div className="panel-heading"><div><span className="eyebrow">PROVENANCE</span><h2>Κατάσταση δεδομένων</h2></div><Database size={20} /></div>
          <div className="provider-list">{(data?.providers ?? []).map((provider) => <div key={provider.id}><StatusDot status={provider.status} /><span><strong>{provider.label}</strong><small>{provider.message}</small></span></div>)}</div>
          <p className="data-note"><ShieldAlert size={15} /> Τα μη διαθέσιμα δεδομένα δεν λογίζονται ως μηδενική δραστηριότητα.</p>
        </section>
      </div>
    </div>
  );
}

function MapView({ data, selected, observer, radar, radarVisible, ringsVisible, onRadar, onRings, onSelect, onPoint }: {
  data: OpportunityResponse | null; selected: StormCandidate | null; observer: SavedLocation; radar: RadarMetadata | null; radarVisible: boolean; ringsVisible: boolean; onRadar: (value: boolean) => void; onRings: (value: boolean) => void; onSelect: (id: string) => void; onPoint: () => void;
}) {
  return (
    <div className="map-layout">
      <section className="map-panel">
        <div className="map-toolbar"><div><span className="eyebrow">MEDITERRANEAN WATCH</span><h1>Ζωντανός χάρτης & πρόγνωση</h1></div><div className="layer-toggles"><label><input type="checkbox" checked={radarVisible} onChange={(event) => onRadar(event.target.checked)} /> Radar</label><label><input type="checkbox" checked={ringsVisible} onChange={(event) => onRings(event.target.checked)} /> Δακτύλιοι</label></div></div>
        <div className="map-wrap"><StormMap observer={observer} candidates={data?.candidates ?? []} selectedId={selected?.id ?? null} radar={radar} radarVisible={radarVisible} ringsVisible={ringsVisible} onSelect={onSelect} /><div className="map-legend"><span><i className="legend-observer" /> Παρατηρητής</span><span><i className="legend-target" /> Πρόγνωση</span><span><i className="legend-uncertainty" /> Αβεβαιότητα στόχου</span></div></div>
        <p className="attribution">© OpenStreetMap contributors · Radar: RainViewer (όπου υπάρχει κάλυψη) · Προγνωστικά: Open-Meteo. Το radar δεν αποδεικνύει κεραυνική δραστηριότητα.</p>
      </section>
      <aside className="target-drawer">
        {selected ? <><span className="eyebrow">SELECTED FORECAST CELL</span><div className="drawer-score"><ScoreDial value={selected.score.total} /><div><h2>{directionLabel(selected.bearingDeg, "el")} · {selected.distanceKm.toFixed(0)} km</h2><span className="confidence-chip">{confidenceLabel(selected.score.confidence)} εμπιστοσύνη</span></div></div><div className="drawer-metrics"><Metric icon={Navigation} label="Αζιμούθιο" value={`${selected.bearingDeg.toFixed(1)}°`} /><Metric icon={Activity} label="CAPE" value={`${selected.capeJkg?.toFixed(0) ?? "—"} J/kg`} /><Metric icon={Cloud} label="Υετός" value={`${selected.precipitationMm?.toFixed(1) ?? "—"} mm`} /><Metric icon={Wind} label="Άνεμος μοντέλου" value={`${selected.windSpeedKmh?.toFixed(0) ?? "—"} km/h`} /></div><div className="warning-box"><AlertTriangle size={17} /><p><strong>Όχι παρατήρηση κεραυνών.</strong> Αυτή είναι περιοχή χονδροειδούς προγνωστικής σάρωσης, όχι ακριβές κέντρο καταιγίδας.</p></div><button className="primary-action full" onClick={onPoint}><Crosshair size={18} />Άνοιγμα στόχευσης</button></> : <EmptyState title="Χωρίς επιλεγμένο στόχο" description="Επίλεξε μια προγνωστική κυψέλη στον χάρτη." />}
      </aside>
    </div>
  );
}

function ForecastView({ data, selected, onSelect, onPoint }: { data: OpportunityResponse | null; selected: StormCandidate | null; onSelect: (id: string) => void; onPoint: () => void }) {
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">NEXT 72 HOURS</span><h1>Προγνωστικές ευκαιρίες</h1><p>Χονδροειδής σάρωση όλων των διευθύνσεων. Οι θέσεις μπορούν να μετακινηθούν σημαντικά.</p></div><CalendarClock size={30} /></div><section className="panel"><div className="forecast-table"><div className="forecast-head"><span>Έγκυρη ώρα</span><span>Κατεύθυνση</span><span>Απόσταση</span><span>CAPE / Υετός</span><span>Δείκτης</span><span /></div>{data?.candidates.length ? data.candidates.map((candidate) => <button key={candidate.id} className={selected?.id === candidate.id ? "selected" : ""} onClick={() => onSelect(candidate.id)}><span>{formatAthens(candidate.forecastValidAt)}</span><span>{directionLabel(candidate.bearingDeg, "el")} · {candidate.bearingDeg.toFixed(0)}°</span><span>{candidate.distanceKm.toFixed(0)} km</span><span>{candidate.capeJkg?.toFixed(0) ?? "—"} J/kg · {candidate.precipitationMm?.toFixed(1) ?? "—"} mm</span><strong>{candidate.score.total}/100</strong><ChevronRight size={17} /></button>) : <EmptyState title="Καμία υποψήφια κυψέλη" description="Δεν βρέθηκε συνδυασμός αστάθειας και υετού που να περνά τα αρχικά φίλτρα." />}</div></section>{selected && <section className="panel explanation-panel"><div><span className="eyebrow">WHY THIS SCORE</span><h2>Επεξήγηση δείκτη {selected.score.total}/100</h2></div><div className="score-breakdown">{[["Δραστηριότητα", selected.score.activity, 35], ["Ατμόσφαιρα", selected.score.atmosphere, 30], ["Έδαφος", selected.score.terrain, 20], ["Απόσταση", selected.score.distance, 10], ["Σκοτάδι", selected.score.darkness, 5]].map(([label, value, max]) => <div key={String(label)}><span>{label}</span><div><i style={{ width: `${Number(value) / Number(max) * 100}%` }} /></div><strong>{value}/{max}</strong></div>)}</div><ul className="reason-list">{[...selected.score.reasons, ...selected.score.limitations].map((reason) => <li key={reason}>{reason}</li>)}</ul><button className="primary-action" onClick={onPoint}>Άνοιγμα στόχευσης</button></section>}</div>;
}

function PointView({ candidate, lens, fov, framing, terrain, terrainLoading, sky, language }: {
  candidate: StormCandidate | null; lens: LensProfile; fov: { horizontalDeg: number; verticalDeg: number }; framing: ReturnType<typeof framingAssessment> | null; terrain: TerrainProfile | null; terrainLoading: boolean; sky: ReturnType<typeof skyState> | null; language: Language;
}) {
  const [heading, setHeading] = useState<number | null>(null);
  const [sensorMessage, setSensorMessage] = useState("Χειροκίνητη λειτουργία — σύρε τη συσκευή/κάμερα προς το αζιμούθιο.");
  const enableCompass = async () => {
    type PermissionDeviceOrientationEvent = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> };
    try {
      const OrientationEvent = DeviceOrientationEvent as PermissionDeviceOrientationEvent;
      if (OrientationEvent.requestPermission) {
        const permission = await OrientationEvent.requestPermission();
        if (permission !== "granted") throw new Error("Δεν δόθηκε άδεια αισθητήρων.");
      }
      const handler = (event: DeviceOrientationEvent) => {
        const iosHeading = (event as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
        const nextHeading = iosHeading ?? (event.alpha == null ? null : (360 - event.alpha) % 360);
        if (nextHeading != null) setHeading(nextHeading);
      };
      window.addEventListener("deviceorientationabsolute", handler as EventListener, { once: false });
      window.addEventListener("deviceorientation", handler, { once: false });
      setSensorMessage("Ένδειξη αισθητήρα ενεργή. Δεν εφαρμόζεται διόρθωση μαγνητικής απόκλισης· βαθμονόμησε με γνωστό σημείο.");
    } catch (error) { setSensorMessage(error instanceof Error ? error.message : "Οι αισθητήρες δεν υποστηρίζονται."); }
  };
  if (!candidate) return <EmptyState title="Δεν υπάρχει στόχος για σκόπευση" description="Επίλεξε πρώτα μια διαθέσιμη προγνωστική κυψέλη." />;
  const elevations = candidate.pointing.map((point) => point.elevationDeg);
  const minElevation = Math.min(...elevations);
  const maxElevation = Math.max(...elevations);
  const targetHalfWidth = (Math.atan2(candidate.uncertaintyKm, candidate.distanceKm) * 180) / Math.PI;
  const targetMin = (candidate.bearingDeg - targetHalfWidth + 360) % 360;
  const targetMax = (candidate.bearingDeg + targetHalfWidth) % 360;
  const visibility = terrainVisibility(terrain, candidate.pointing);
  const alignment = heading == null ? null : angularDifference(heading, candidate.bearingDeg);
  return <div className="point-layout"><section className="point-hero"><span className="eyebrow">TRUE-NORTH CAMERA GUIDANCE</span><h1>Στρέψε την κάμερα προς <em>{directionLabel(candidate.bearingDeg, language)}</em></h1><div className="bearing-number"><strong>{candidate.bearingDeg.toFixed(1)}°</strong><span>αληθές αζιμούθιο</span></div><div className="point-grid"><div><span>Οριζόντιος τομέας</span><strong>{targetMin.toFixed(1)}° → {targetMax.toFixed(1)}°</strong></div><div><span>Χρήσιμη ανύψωση</span><strong>{minElevation.toFixed(1)}° → {maxElevation.toFixed(1)}°</strong></div><div><span>Ορίζοντας εδάφους</span><strong>{terrainLoading ? "υπολογισμός…" : terrain?.horizonAngleDeg != null ? `${terrain.horizonAngleDeg.toFixed(1)}°` : "μη επαληθευμένος"}</strong></div><div><span>Ορατό εύρος TLE</span><strong>{visibility.status === "clear" ? "50–90 km" : visibility.status === "partial" ? `${visibility.visibleAltitudesKm[0]}–${visibility.visibleAltitudesKm.at(-1)} km` : visibility.status === "blocked" ? "Αποκλεισμένο" : "Άγνωστο"}</strong></div></div><div className="compass-stage"><div className="compass-ring" style={{ transform: `rotate(${-1 * (heading ?? 0)}deg)` }}><span className="north">Β</span><span className="east">Α</span><span className="south">Ν</span><span className="west">Δ</span><div className="target-needle" style={{ transform: `rotate(${candidate.bearingDeg}deg)` }}><i /></div></div><div className={`alignment-dot ${alignment != null && alignment < 5 ? "aligned" : ""}`}><Crosshair size={26} /><span>{heading == null ? "—" : `${heading.toFixed(0)}°`}</span></div></div><button className="secondary-action sensor-button" onClick={enableCompass}><Compass size={18} />Ενεργοποίηση πυξίδας συσκευής</button><p className="sensor-note">{sensorMessage}</p></section><aside className="point-sidebar"><section className="panel compact"><span className="eyebrow">FRAME CHECK</span><h2>{lens.name}</h2><div className="fov-visual"><div className="fov-frame"><div className="target-band" style={{ height: `${Math.min(80, ((maxElevation - minElevation) / fov.verticalDeg) * 100)}%` }} /></div></div><div className="fov-values"><span>Οριζόντια <strong>{fov.horizontalDeg.toFixed(1)}°</strong></span><span>Κάθετα <strong>{fov.verticalDeg.toFixed(1)}°</strong></span></div><p className={framing?.fits ? "fit-ok" : "fit-warn"}>{framing?.fits ? "Η εκτιμώμενη περιοχή χωρά με περιθώριο στο κάδρο." : "Η αβεβαιότητα δεν χωρά άνετα. Προτίμησε ευρύτερο φακό."}</p></section><section className="panel compact"><span className="eyebrow">FIELD SETTINGS</span>{Object.entries(photoRecommendation(lens, sky?.moonInterference ?? false, targetHalfWidth * 2)).slice(1, 7).map(([key, value]) => <div className="setting-row" key={key}><span>{key}</span><strong>{value}</strong></div>)}</section><section className="safety-card"><ShieldAlert size={20} /><div><strong>Προτεραιότητα η ασφάλεια</strong><p>Μην παρατηρείς σε εκτεθειμένο σημείο όταν η καταιγίδα πλησιάζει. Ο στόχος εδώ είναι προγνωστικός, όχι επιβεβαιωμένος.</p></div></section></aside></div>;
}

function SkyView({ candidate, terrain, fov, lens, orientation, sky, onOrientation }: { candidate: StormCandidate | null; terrain: TerrainProfile | null; fov: { horizontalDeg: number; verticalDeg: number }; lens: LensProfile; orientation: "landscape" | "portrait"; sky: ReturnType<typeof skyState> | null; onOrientation: (value: "landscape" | "portrait") => void }) {
  if (!candidate) return <EmptyState title="Δεν υπάρχει στόχος" description="Η πανοραμική όψη απαιτεί επιλεγμένη προγνωστική κυψέλη." />;
  const profilePoints = terrain?.samples.filter((sample) => sample.apparentElevationDeg != null) ?? [];
  const maxDistance = Math.max(1, ...profilePoints.map((point) => point.distanceKm));
  const terrainPath = profilePoints.map((point, index) => `${index ? "L" : "M"} ${(point.distanceKm / maxDistance) * 700} ${260 - Math.max(-2, Math.min(25, point.apparentElevationDeg ?? 0)) * 8}`).join(" ");
  const low = candidate.pointing[0].elevationDeg;
  const high = candidate.pointing.at(-1)!.elevationDeg;
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">PANORAMIC COORDINATE VIEW</span><h1>Ορίζοντας & κάδρο</h1><p>Όλες οι επικαλύψεις χρησιμοποιούν αληθές αζιμούθιο και φαινόμενη ανύψωση.</p></div><div className="segmented"><button className={orientation === "landscape" ? "active" : ""} onClick={() => onOrientation("landscape")}>Οριζόντια</button><button className={orientation === "portrait" ? "active" : ""} onClick={() => onOrientation("portrait")}>Κάθετα</button></div></div><section className="panel sky-panel"><div className="sky-labels"><span>90° Ζενίθ</span><span>45°</span><span>0° Ορίζοντας</span></div><svg viewBox="0 0 700 300" role="img" aria-label="Προφίλ ορίζοντα και εκτιμώμενη ζώνη TLE"><defs><linearGradient id="skyGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0a1530" /><stop offset="1" stopColor="#18283b" /></linearGradient><linearGradient id="terrainGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#263b45" /><stop offset="1" stopColor="#101a20" /></linearGradient></defs><rect width="700" height="300" fill="url(#skyGradient)" />{[50, 100, 150, 200, 250].map((y) => <line key={y} x1="0" x2="700" y1={y} y2={y} stroke="#7390aa" strokeOpacity=".12" />)}<rect x={350 - Math.min(320, fov.horizontalDeg * 5) / 2} y={260 - Math.min(210, fov.verticalDeg * 5)} width={Math.min(320, fov.horizontalDeg * 5)} height={Math.min(210, fov.verticalDeg * 5)} rx="8" fill="none" stroke="#7de4ca" strokeWidth="2" strokeDasharray="7 5" /><rect x="300" y={260 - high * 8} width="100" height={Math.max(5, (high - low) * 8)} rx="5" fill="#f04362" fillOpacity=".28" stroke="#ff6d84" /><text x="350" y={250 - high * 8} textAnchor="middle" fill="#ffb1be" fontSize="12">TLE 50–90 km</text>{sky && sky.moonAltitudeDeg > 0 && <g transform={`translate(${350 + Math.sin((sky.moonAzimuthDeg - candidate.bearingDeg) * Math.PI / 180) * 250},${260 - Math.min(30, sky.moonAltitudeDeg) * 8})`}><circle r="9" fill="#f4dfad" /><text x="14" y="4" fill="#dce8f3" fontSize="11">Σελήνη</text></g>}<path d={`${terrainPath} L 700 300 L 0 300 Z`} fill="url(#terrainGradient)" stroke="#91a49c" strokeWidth="2" /></svg><div className="horizon-caption"><span>{directionLabel(candidate.bearingDeg - 30, "el")} {(candidate.bearingDeg - 30 + 360) % 360}°</span><strong>Στόχος {candidate.bearingDeg.toFixed(1)}°</strong><span>{directionLabel(candidate.bearingDeg + 30, "el")} {(candidate.bearingDeg + 30) % 360}°</span></div><div className="sky-key"><span><i className="key-tle" />Θεωρητικό υψομετρικό περίβλημα</span><span><i className="key-fov" />Κάδρο {lens.focalLengthMm} mm</span><span><i className="key-terrain" />DEM στον επιλεγμένο τομέα</span></div></section><div className="warning-box"><Mountain size={18} /><p><strong>Περιορισμός:</strong> το δημόσιο DEM δειγματοληπτεί μόνο τον επιλεγμένο τομέα για εξοικονόμηση ορίου κλήσεων. Το πλήρες προφίλ 360° δεν χαρακτηρίζεται ως επαληθευμένο.</p></div></div>;
}

function LocationsView({ observer, locations, candidate, onObserver, onLocations }: { observer: SavedLocation; locations: SavedLocation[]; candidate: StormCandidate | null; onObserver: (value: SavedLocation) => void; onLocations: (value: SavedLocation[]) => void }) {
  const [name, setName] = useState("");
  const [gpsStatus, setGpsStatus] = useState("");
  const addCurrent = () => {
    const item = { ...observer, id: crypto.randomUUID(), name: name.trim() || `Θέση ${locations.length + 1}`, favorite: false };
    onLocations([...locations, item]); setName("");
  };
  const useGps = () => {
    if (!navigator.geolocation) { setGpsStatus("Το GPS δεν υποστηρίζεται."); return; }
    setGpsStatus("Αναμονή άδειας GPS…");
    navigator.geolocation.getCurrentPosition((position) => { onObserver({ ...observer, name: "Τρέχουσα θέση GPS", latitude: position.coords.latitude, longitude: position.coords.longitude, elevationM: position.coords.altitude ?? observer.elevationM }); setGpsStatus(`Ακρίβεια περίπου ±${position.coords.accuracy.toFixed(0)} m.`); }, (gpsError) => setGpsStatus(gpsError.message), { enableHighAccuracy: true, timeout: 12_000 });
  };
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">OBSERVER NETWORK</span><h1>Θέσεις παρατήρησης</h1><p>Οι συντεταγμένες αποθηκεύονται μόνο σε αυτόν τον browser.</p></div><button className="secondary-action" onClick={useGps}><LocateFixed size={18} />Χρήση GPS</button></div>{gpsStatus && <div className="info-strip">{gpsStatus}</div>}<div className="locations-grid"><section className="panel location-editor"><h2>Ακριβής ενεργή θέση</h2><label>Όνομα<input value={observer.name} onChange={(event) => onObserver({ ...observer, name: event.target.value })} /></label><div className="two-fields"><label>Γεωγραφικό πλάτος<input type="number" step="0.000001" value={observer.latitude} onChange={(event) => onObserver({ ...observer, latitude: Number(event.target.value) })} /></label><label>Γεωγραφικό μήκος<input type="number" step="0.000001" value={observer.longitude} onChange={(event) => onObserver({ ...observer, longitude: Number(event.target.value) })} /></label></div><div className="two-fields"><label>Υψόμετρο εδάφους (m)<input type="number" value={observer.elevationM ?? 0} onChange={(event) => onObserver({ ...observer, elevationM: Number(event.target.value) })} /></label><label>Ύψος κάμερας (m)<input type="number" step="0.1" value={observer.cameraHeightM} onChange={(event) => onObserver({ ...observer, cameraHeightM: Number(event.target.value) })} /></label></div><div className="save-row"><input placeholder="Όνομα νέας αποθηκευμένης θέσης" value={name} onChange={(event) => setName(event.target.value)} /><button className="primary-action" onClick={addCurrent}><Plus size={17} />Αποθήκευση</button></div></section><section className="panel"><h2>Σύγκριση για τον ίδιο στόχο</h2><div className="location-list">{locations.map((location) => { const geometry = candidate ? inverseGeodesic(location, candidate.coordinates) : null; return <div key={location.id} className={location.id === observer.id ? "active" : ""}><button className="location-select" onClick={() => onObserver(location)}><MapPin size={18} /><span><strong>{location.name}</strong><small>{location.latitude.toFixed(4)}°, {location.longitude.toFixed(4)}°{geometry ? ` · ${(geometry.distanceM / 1000).toFixed(0)} km · ${geometry.initialBearingDeg.toFixed(0)}°` : ""}</small></span></button>{location.id !== "sparta-home" && <button className="delete-icon" aria-label="Διαγραφή θέσης" onClick={() => onLocations(locations.filter((item) => item.id !== location.id))}><Trash2 size={16} /></button>}</div>; })}</div><p className="data-note">Η σύγκριση απόστασης/αζιμουθίου είναι διαθέσιμη άμεσα. Η σύγκριση νεφών και DEM απαιτεί ξεχωριστό έλεγχο ανά θέση.</p></section></div></div>;
}

function CameraView({ candidate, lenses, selectedLens, fov, framing, orientation, sky, onSelect, onLenses, onOrientation }: { candidate: StormCandidate | null; lenses: LensProfile[]; selectedLens: LensProfile; fov: { horizontalDeg: number; verticalDeg: number }; framing: ReturnType<typeof framingAssessment> | null; orientation: "landscape" | "portrait"; sky: ReturnType<typeof skyState> | null; onSelect: (id: string) => void; onLenses: (value: LensProfile[]) => void; onOrientation: (value: "landscape" | "portrait") => void }) {
  const [custom, setCustom] = useState({ name: "", focal: 24, aperture: 2.8 });
  const recommendation = photoRecommendation(selectedLens, sky?.moonInterference ?? false, candidate ? (Math.atan2(candidate.uncertaintyKm, candidate.distanceKm) * 360) / Math.PI : 10);
  const addLens = (event: FormEvent) => { event.preventDefault(); if (!custom.name.trim() || custom.focal <= 0 || custom.aperture <= 0) return; const lens: LensProfile = { id: crypto.randomUUID(), name: custom.name, focalLengthMm: custom.focal, maxAperture: custom.aperture, mount: "Canon EF/EF-S", owned: true }; onLenses([...lenses, lens]); onSelect(lens.id); setCustom({ name: "", focal: 24, aperture: 2.8 }); };
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">PHOTOGRAPHY ENGINE</span><h1>Κάμερα & φακοί</h1><p>Canon EOS 750D · APS-C 22,3 × 14,9 mm · crop 1,6×</p></div><Camera size={31} /></div><div className="equipment-grid"><section className="panel lens-library"><div className="panel-heading"><h2>Συλλογή φακών</h2><div className="segmented"><button className={orientation === "landscape" ? "active" : ""} onClick={() => onOrientation("landscape")}>Οριζόντια</button><button className={orientation === "portrait" ? "active" : ""} onClick={() => onOrientation("portrait")}>Κάθετα</button></div></div><div className="lens-list">{lenses.map((lens) => <div key={lens.id} className={lens.id === selectedLens.id ? "selected" : ""}><button onClick={() => onSelect(lens.id)}><span><strong>{lens.name}</strong><small>{lens.mount} · {lens.owned ? "Δηλωμένος ως διαθέσιμος" : "Πρόταση — όχι δηλωμένος ως διαθέσιμος"}</small></span><span>{lens.focalLengthMm} mm<br /><small>f/{lens.maxAperture}</small></span></button><label><input type="checkbox" checked={lens.owned} onChange={(event) => onLenses(lenses.map((item) => item.id === lens.id ? { ...item, owned: event.target.checked } : item))} /> δικός μου</label></div>)}</div><form className="custom-lens" onSubmit={addLens}><h3>Προσθήκη φακού</h3><input placeholder="Όνομα" value={custom.name} onChange={(event) => setCustom({ ...custom, name: event.target.value })} /><input type="number" aria-label="Εστιακή απόσταση" value={custom.focal} onChange={(event) => setCustom({ ...custom, focal: Number(event.target.value) })} /><input type="number" step="0.1" aria-label="Μέγιστο διάφραγμα" value={custom.aperture} onChange={(event) => setCustom({ ...custom, aperture: Number(event.target.value) })} /><button><Plus size={16} />Προσθήκη</button></form></section><aside className="view-stack"><section className="panel fov-card"><span className="eyebrow">CALCULATED FIELD OF VIEW</span><div className="big-fov"><strong>{fov.horizontalDeg.toFixed(1)}° × {fov.verticalDeg.toFixed(1)}°</strong><span>πραγματικό γωνιακό κάδρο</span></div>{candidate && <div className={framing?.fits ? "fit-ok" : "fit-warn"}>{framing?.fits ? <Check size={17} /> : <AlertTriangle size={17} />}{framing?.fits ? "Ο στόχος και η αβεβαιότητά του χωρούν." : "Ο στόχος μπορεί να βγει από το κάδρο."}</div>}<p className="data-note">Ο Jupiter 200 mm είναι πολύ στενός και σχετικά αργός για αρχική αναζήτηση sprites, εκτός αν η περιοχή έχει επιβεβαιωθεί πολύ καλά.</p></section><section className="panel recommendation-card"><span className="eyebrow">EXPERIMENTAL STARTING POINT</span><h2>{recommendation.preset}</h2><div className="settings-grid"><Metric icon={Camera} label="Διάφραγμα" value={recommendation.aperture} /><Metric icon={Gauge} label="Ευαισθησία" value={recommendation.iso} /><Metric icon={Activity} label="Έκθεση" value={recommendation.shutter} /><Metric icon={Moon} label="Ισορροπία λευκού" value={recommendation.whiteBalance} /></div><div className="warning-box"><AlertTriangle size={17} /><p>{recommendation.warning} Οι ρυθμίσεις είναι πειραματική αφετηρία, όχι εγγύηση.</p></div></section></aside></div></div>;
}

function LogbookView({ logs, candidate, lens, onLogs }: { logs: LogEntry[]; candidate: StormCandidate | null; lens: LensProfile; onLogs: (value: LogEntry[]) => void }) {
  const [form, setForm] = useState({ tleType: "Red Sprite", iso: 3200, aperture: lens.maxAperture, shutter: "3 s", success: "uncertain" as LogEntry["success"], notes: "" });
  const add = (event: FormEvent) => { event.preventDefault(); onLogs([{ id: crypto.randomUUID(), timestamp: new Date().toISOString(), target: candidate ? `${candidate.bearingDeg.toFixed(1)}° / ${candidate.distanceKm.toFixed(0)} km` : "Χωρίς στόχο", lens: lens.name, ...form }, ...logs]); setForm({ ...form, notes: "" }); };
  const download = (format: "json" | "csv") => {
    const content = format === "json" ? JSON.stringify(logs, null, 2) : ["timestamp,target,tleType,lens,iso,aperture,shutter,success,notes", ...logs.map((entry) => [entry.timestamp, entry.target, entry.tleType, entry.lens, entry.iso, entry.aperture, entry.shutter, entry.success, entry.notes].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([content], { type: format === "json" ? "application/json" : "text/csv" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `spritehunter-logbook.${format}`; anchor.click(); URL.revokeObjectURL(url);
  };
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">OBSERVATION ARCHIVE</span><h1>Ημερολόγιο παρατήρησης</h1><p>Οι καταχωρίσεις αποθηκεύονται τοπικά και οι ώρες εσωτερικά σε UTC.</p></div><div className="export-actions"><button onClick={() => download("csv")}><Download size={16} />CSV</button><button onClick={() => download("json")}><Download size={16} />JSON</button></div></div><div className="log-grid"><form className="panel log-form" onSubmit={add}><h2>Νέα καταχώριση</h2><label>Τύπος TLE<select value={form.tleType} onChange={(event) => setForm({ ...form, tleType: event.target.value })}><option>Red Sprite</option><option>Sprite Halo</option><option>ELVES</option><option>Blue Jet</option><option>Gigantic Jet</option></select></label><div className="three-fields"><label>ISO<input type="number" value={form.iso} onChange={(event) => setForm({ ...form, iso: Number(event.target.value) })} /></label><label>Διάφραγμα<input type="number" step="0.1" value={form.aperture} onChange={(event) => setForm({ ...form, aperture: Number(event.target.value) })} /></label><label>Έκθεση<input value={form.shutter} onChange={(event) => setForm({ ...form, shutter: event.target.value })} /></label></div><label>Αποτέλεσμα<select value={form.success} onChange={(event) => setForm({ ...form, success: event.target.value as LogEntry["success"] })}><option value="yes">Επιτυχία</option><option value="no">Όχι</option><option value="uncertain">Αβέβαιο</option></select></label><label>Σημειώσεις<textarea rows={4} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label><button className="primary-action"><Plus size={17} />Καταχώριση</button></form><section className="panel"><h2>Προηγούμενες παρατηρήσεις</h2>{logs.length ? <div className="log-list">{logs.map((entry) => <article key={entry.id}><div><strong>{entry.tleType}</strong><span className={`result-${entry.success}`}>{entry.success === "yes" ? "Επιτυχία" : entry.success === "no" ? "Όχι" : "Αβέβαιο"}</span></div><small>{formatAthens(entry.timestamp)} · {entry.target}</small><p>{entry.lens} · f/{entry.aperture} · ISO {entry.iso} · {entry.shutter}</p>{entry.notes && <blockquote>{entry.notes}</blockquote>}<button aria-label="Διαγραφή" onClick={() => onLogs(logs.filter((item) => item.id !== entry.id))}><Trash2 size={15} /></button></article>)}</div> : <EmptyState title="Το ημερολόγιο είναι κενό" description="Κατέγραψε τις πραγματικές προσπάθειες για μελλοντική αξιολόγηση του δείκτη." />}</section></div></div>;
}

function AlertsView({ candidate }: { candidate: StormCandidate | null }) {
  const [prefs, setPrefs] = usePersistedState("spritehunter.alerts", { minimumScore: 60, confidence: "medium", cooldown: 90, quietStart: "01:00", quietEnd: "08:00" });
  const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const request = async () => { if (typeof Notification === "undefined") return; setPermission(await Notification.requestPermission()); };
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">EVENT-DRIVEN WATCH</span><h1>Ειδοποιήσεις</h1><p>Ειδοποίηση μόνο όταν η ευκαιρία αλλάζει ουσιαστικά — όχι συνεχής θόρυβος.</p></div><Bell size={30} /></div><div className="alerts-grid"><section className="panel alert-settings"><h2>Κανόνες ειδοποίησης</h2><label>Ελάχιστος δείκτης <strong>{prefs.minimumScore}/100</strong><input type="range" min="30" max="85" value={prefs.minimumScore} onChange={(event) => setPrefs({ ...prefs, minimumScore: Number(event.target.value) })} /></label><label>Ελάχιστη εμπιστοσύνη<select value={prefs.confidence} onChange={(event) => setPrefs({ ...prefs, confidence: event.target.value })}><option value="low">Χαμηλή</option><option value="medium">Μέτρια</option><option value="high">Υψηλή</option></select></label><label>Cooldown (λεπτά)<input type="number" value={prefs.cooldown} onChange={(event) => setPrefs({ ...prefs, cooldown: Number(event.target.value) })} /></label><div className="two-fields"><label>Έναρξη ησυχίας<input type="time" value={prefs.quietStart} onChange={(event) => setPrefs({ ...prefs, quietStart: event.target.value })} /></label><label>Λήξη ησυχίας<input type="time" value={prefs.quietEnd} onChange={(event) => setPrefs({ ...prefs, quietEnd: event.target.value })} /></label></div><button className="secondary-action" onClick={request}><Bell size={17} />Άδεια browser notification</button><p className="data-note">Κατάσταση άδειας: {permission}</p></section><section className="panel"><span className="eyebrow">CURRENT EVALUATION</span><h2>{candidate && candidate.score.total >= prefs.minimumScore ? "Περνά το όριο δείκτη" : "Δεν περνά το όριο"}</h2><div className="alert-preview"><Bell size={20} /><div><strong>Παράδειγμα παραγόμενης ειδοποίησης</strong><p>{candidate ? `Προγνωστική κυψέλη ${candidate.distanceKm.toFixed(0)} km προς ${directionLabel(candidate.bearingDeg, "el")}, δείκτης ${candidate.score.total}/100. Δεν έχει επιβεβαιωθεί ηλεκτρική δραστηριότητα.` : "Δεν υπάρχει κατάλληλος στόχος τώρα."}</p></div></div><div className="warning-box"><AlertTriangle size={17} /><p><strong>Ο browser δεν είναι server.</strong> Με κλειστή εφαρμογή δεν εκτελείται αξιόπιστη παρακολούθηση. Η παρούσα έκδοση παρέχει in-app/browser notifications· server push απαιτεί αποθήκευση συνδρομών και προγραμματισμένο worker.</p></div></section></div></div>;
}

function SettingsView({ observer, range, data, language, onObserver, onRange, onLanguage, onRefresh }: { observer: SavedLocation; range: { min: number; max: number }; data: OpportunityResponse | null; language: Language; onObserver: (value: SavedLocation) => void; onRange: (value: { min: number; max: number }) => void; onLanguage: (value: Language) => void; onRefresh: () => void }) {
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">SCIENTIFIC CONFIGURATION</span><h1>Ρυθμίσεις & πηγές</h1><p>Οι επιστημονικές παραδοχές είναι ορατές και δεν παρουσιάζονται ως βεβαιότητες.</p></div><Settings size={30} /></div><div className="settings-columns"><section className="panel settings-form"><h2>Παρατήρηση</h2><label>Γλώσσα<select value={language} onChange={(event) => onLanguage(event.target.value as Language)}><option value="el">Ελληνικά</option><option value="en">English</option></select></label><div className="two-fields"><label>Ελάχιστη ακτίνα (km)<input type="number" min="100" max="700" value={range.min} onChange={(event) => onRange({ ...range, min: Number(event.target.value) })} /></label><label>Μέγιστη ακτίνα (km)<input type="number" min="200" max="800" value={range.max} onChange={(event) => onRange({ ...range, max: Number(event.target.value) })} /></label></div><label>Σημειώσεις ασφάλειας<textarea rows={3} value={observer.safetyNotes} onChange={(event) => onObserver({ ...observer, safetyNotes: event.target.value })} /></label><button className="primary-action" onClick={onRefresh}><RefreshCw size={17} />Εφαρμογή & νέα σάρωση</button></section><section className="panel"><h2>Πηγές δεδομένων</h2><div className="provider-list detailed">{(data?.providers ?? []).map((provider) => <div key={provider.id}><StatusDot status={provider.status} /><span><strong>{provider.label}</strong><small>{provider.message}</small></span></div>)}</div><div className="source-links"><a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">Open-Meteo docs <ExternalLink size={14} /></a><a href="https://www.rainviewer.com/api.html" target="_blank" rel="noreferrer">RainViewer API <ExternalLink size={14} /></a><a href="https://www.xweather.com/docs/weather-api/endpoints/lightning" target="_blank" rel="noreferrer">Xweather Lightning <ExternalLink size={14} /></a><a href="https://www.opentopodata.org/" target="_blank" rel="noreferrer">OpenTopoData <ExternalLink size={14} /></a></div></section><section className="panel assumptions"><h2>Υψομετρικά περιβλήματα</h2>{[["Red Sprites", "50–90 km", "κύριο μοντέλο"], ["Sprite Halos", "70–90 km", "ενημερωτικό"], ["ELVES", "70–100 km", "πειραματικό"], ["Blue Jets", "15–50 km", "πειραματικό"], ["Gigantic Jets", "15–90 km", "πειραματικό"]].map(([name, altitude, status]) => <div key={name}><span><strong>{name}</strong><small>{status}</small></span><b>{altitude}</b></div>)}<p className="data-note">Τα TLE είναι στιγμιαία φαινόμενα πάνω από καταιγίδες και δεν προβλέπονται με βεβαιότητα από κοινά μετεωρολογικά δεδομένα.</p></section></div></div>;
}
