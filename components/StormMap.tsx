"use client";
/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- map tiles and WMS images are positioned manually, not page images */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { LocateFixed, Minus, Plus } from "lucide-react";
import type { Coordinates, EumetsatMetadata, StormCandidate } from "@/lib/domain";
import { destinationPoint } from "@/lib/geodesy";
import { eumetsatImageUrl, worldPixelToMercator, type EumetsatProduct } from "@/lib/providers/eumetsat";

interface RadarMetadata {
  host: string;
  radar: { past: Array<{ time: number; path: string }> };
}

interface StormMapProps {
  observer: Coordinates;
  candidates: StormCandidate[];
  selectedId: string | null;
  radar: RadarMetadata | null;
  radarVisible: boolean;
  lightningVisible: boolean;
  infraredVisible: boolean;
  cloudTopVisible: boolean;
  instabilityVisible: boolean;
  ringsVisible: boolean;
  eumetsat: EumetsatMetadata | null;
  onSelect: (id: string) => void;
}

interface OverlayView {
  zoom: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

const TILE_SIZE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 9;
const OVERLAY_PADDING = 0.25;
const OVERLAY_MAX_PX = 2048;
// EUMETView answers 500/504 for large renders under load; ≤1024 px requests are reliable.
const OVERLAY_MAX_REQUEST_PX = 1024;
const OVERLAY_MAX_RETRIES = 2;

export function clampMapZoom(zoom: number) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

function worldPoint(coordinates: Coordinates, zoom: number) {
  const scale = TILE_SIZE * 2 ** zoom;
  const latitude = Math.max(-85.0511, Math.min(85.0511, coordinates.latitude));
  const sin = Math.sin(latitude * Math.PI / 180);
  return {
    x: (coordinates.longitude + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

function worldCoordinates(x: number, y: number, zoom: number): Coordinates {
  const scale = TILE_SIZE * 2 ** zoom;
  const longitude = x / scale * 360 - 180;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale))) * 180 / Math.PI;
  return { latitude, longitude };
}

const athensTime = (date: Date) => new Intl.DateTimeFormat("el-GR", { timeZone: "Europe/Athens", hour: "2-digit", minute: "2-digit" }).format(date);

function radarLabel(radar: RadarMetadata | null) {
  const timestamp = radar?.radar.past.at(-1)?.time;
  if (!timestamp) return "Radar μη διαθέσιμο";
  return `Radar ${athensTime(new Date(timestamp * 1000))}`;
}

function satelliteLabel(eumetsat: EumetsatMetadata | null) {
  if (!eumetsat?.lightningTime) return "MTG-LI μη διαθέσιμο";
  return `MTG-LI ${athensTime(new Date(eumetsat.lightningTime))}`;
}

export default function StormMap({ observer, candidates, selectedId, radar, radarVisible, lightningVisible, infraredVisible, cloudTopVisible, instabilityVisible, ringsVisible, eumetsat, onSelect }: StormMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerX: number; pointerY: number; centerX: number; centerY: number } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const lastWheelRef = useRef(0);
  const [size, setSize] = useState({ width: 900, height: 560 });
  const [center, setCenter] = useState<Coordinates>(observer);
  const [zoom, setZoom] = useState(4);
  const [overlayView, setOverlayView] = useState<OverlayView | null>(null);
  const [loadedOverlays, setLoadedOverlays] = useState<Set<string>>(() => new Set());
  const [overlayAttempts, setOverlayAttempts] = useState<Record<string, number>>({});

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const resize = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, []);

  // React registers wheel listeners as passive, so preventDefault() there cannot stop the
  // page from scrolling while zooming. A native non-passive listener can.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const now = Date.now();
      if (now - lastWheelRef.current < 140) return;
      lastWheelRef.current = now;
      setZoom((current) => clampMapZoom(current + (event.deltaY < 0 ? 1 : -1)));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => setCenter(observer), [observer]);

  const scene = useMemo(() => {
    const scale = TILE_SIZE * 2 ** zoom;
    const centerWorld = worldPoint(center, zoom);
    const left = centerWorld.x - size.width / 2;
    const top = centerWorld.y - size.height / 2;
    const firstX = Math.floor(left / TILE_SIZE);
    const lastX = Math.floor((left + size.width) / TILE_SIZE);
    const firstY = Math.max(0, Math.floor(top / TILE_SIZE));
    const lastY = Math.min(2 ** zoom - 1, Math.floor((top + size.height) / TILE_SIZE));
    const tiles = [];
    for (let y = firstY; y <= lastY; y += 1) {
      for (let x = firstX; x <= lastX; x += 1) {
        const wrappedX = ((x % 2 ** zoom) + 2 ** zoom) % 2 ** zoom;
        tiles.push({ key: `${zoom}-${x}-${y}`, x: wrappedX, y, left: x * TILE_SIZE - left, top: y * TILE_SIZE - top });
      }
    }
    const project = (point: Coordinates) => {
      const world = worldPoint(point, zoom);
      let x = world.x - left;
      if (x < -scale / 2) x += scale;
      if (x > scale / 2 + size.width) x -= scale;
      return { x, y: world.y - top };
    };
    return { scale, left, top, tiles, project };
  }, [center, size, zoom]);

  const satelliteLayers: Array<{ kind: EumetsatProduct; className: string; time: string | null | undefined }> = [
    ...(infraredVisible ? [{ kind: "infrared" as const, className: "satellite-tile", time: eumetsat?.infraredTime }] : []),
    ...(cloudTopVisible ? [{ kind: "cloudTop" as const, className: "cloud-top-tile", time: eumetsat?.cloudTopTime }] : []),
    ...(instabilityVisible ? [{ kind: "kIndex" as const, className: "instability-tile", time: eumetsat?.kIndexTime }] : []),
    ...(lightningVisible ? [{ kind: "lightning" as const, className: "lightning-tile", time: eumetsat?.lightningTime }] : []),
  ];
  const anySatelliteLayer = satelliteLayers.length > 0;

  // One WMS image per layer covers the viewport plus a margin; it is only re-requested
  // after the view leaves that margin or the zoom changes.
  useEffect(() => {
    if (!anySatelliteLayer) return;
    const covered = overlayView
      && overlayView.zoom === zoom
      && scene.left >= overlayView.left
      && scene.top >= Math.max(0, overlayView.top) - 1
      && scene.left + size.width <= overlayView.left + overlayView.width
      && scene.top + size.height <= Math.min(scene.scale, overlayView.top + overlayView.height) + 1;
    if (covered) return;
    const timer = setTimeout(() => {
      const width = Math.min(OVERLAY_MAX_PX, Math.round(size.width * (1 + 2 * OVERLAY_PADDING)));
      const height = Math.min(OVERLAY_MAX_PX, Math.round(size.height * (1 + 2 * OVERLAY_PADDING)), Math.round(scene.scale));
      const top = Math.max(0, Math.min(scene.scale - height, scene.top - (height - size.height) / 2));
      setOverlayView({ zoom, left: scene.left - (width - size.width) / 2, top, width, height });
    }, overlayView ? 350 : 0);
    return () => clearTimeout(timer);
  }, [anySatelliteLayer, overlayView, scene.left, scene.top, scene.scale, size.width, size.height, zoom]);

  const overlayImages = overlayView && overlayView.zoom === zoom
    ? satelliteLayers.map((layer) => {
      const topLeft = worldPixelToMercator(overlayView.left, overlayView.top, overlayView.zoom);
      const bottomRight = worldPixelToMercator(overlayView.left + overlayView.width, overlayView.top + overlayView.height, overlayView.zoom);
      const requestScale = Math.min(1, OVERLAY_MAX_REQUEST_PX / Math.max(overlayView.width, overlayView.height));
      const baseSrc = eumetsatImageUrl(layer.kind, { minX: topLeft.x, minY: bottomRight.y, maxX: bottomRight.x, maxY: topLeft.y }, overlayView.width * requestScale, overlayView.height * requestScale, layer.time);
      const attempt = overlayAttempts[baseSrc] ?? 0;
      // WMS ignores unknown parameters; the counter only makes a retry a distinct request.
      return { ...layer, baseSrc, attempt, src: attempt ? `${baseSrc}&retry=${attempt}` : baseSrc };
    })
    : [];
  const lightningOverlay = overlayImages.find((image) => image.kind === "lightning");

  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? null;
  const radarFrame = radar?.radar.past.at(-1);
  const observerPoint = scene.project(observer);
  const ringPaths = ringsVisible ? [100, 200, 300, 400, 500, 600].map((radiusKm) => ({
    radiusKm,
    points: Array.from({ length: 73 }, (_, index) => scene.project(destinationPoint(observer, radiusKm, index * 5))).map((point) => `${point.x},${point.y}`).join(" "),
  })) : [];
  const uncertaintyPoints = selected
    ? Array.from({ length: 73 }, (_, index) => scene.project(destinationPoint(selected.coordinates, selected.uncertaintyKm, index * 5))).map((point) => `${point.x},${point.y}`).join(" ")
    : "";

  const recenter = () => setCenter(observer);
  const changeZoom = (delta: number) => setZoom((current) => clampMapZoom(current + delta));
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("[data-map-interactive]")) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointersRef.current.size >= 2) {
      const [first, second] = Array.from(pointersRef.current.values());
      pinchRef.current = { distance: Math.hypot(first.x - second.x, first.y - second.y), zoom };
      dragRef.current = null;
      return;
    }
    const point = worldPoint(center, zoom);
    dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, centerX: point.x, centerY: point.y };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const [first, second] = Array.from(pointersRef.current.values());
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      if (pinchRef.current.distance > 0) {
        setZoom(clampMapZoom(Math.round(pinchRef.current.zoom + Math.log2(distance / pinchRef.current.distance))));
      }
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const next = worldCoordinates(drag.centerX - (event.clientX - drag.pointerX), drag.centerY - (event.clientY - drag.pointerY), zoom);
    setCenter({ latitude: Math.max(-80, Math.min(80, next.latitude)), longitude: next.longitude });
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    dragRef.current = null;
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyboardZoom = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); changeZoom(1); }
    if (event.key === "-") { event.preventDefault(); changeZoom(-1); }
  };
  const markLoaded = (src: string) => setLoadedOverlays((current) => (current.has(src) ? current : new Set(current).add(src)));
  const retryOverlay = (baseSrc: string, attempt: number) => {
    if (attempt >= OVERLAY_MAX_RETRIES) {
      setOverlayAttempts((current) => ({ ...current, [baseSrc]: OVERLAY_MAX_RETRIES + 1 }));
      return;
    }
    setTimeout(() => setOverlayAttempts((current) => ({ ...current, [baseSrc]: attempt + 1 })), 2_000 * (attempt + 1));
  };
  const overlayFailed = (image: { baseSrc: string }) => (overlayAttempts[image.baseSrc] ?? 0) > OVERLAY_MAX_RETRIES;

  return (
    <div
      ref={containerRef}
      className="storm-map tile-map"
      aria-label="Διαδραστικός χάρτης υποψήφιων καταιγίδων"
      aria-description="Μεγέθυνση με τα κουμπιά, τη ροδέλα, διπλό πάτημα ή χειρονομία δύο δαχτύλων."
      tabIndex={0}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      onKeyDown={keyboardZoom}
      onDoubleClick={(event) => { if (!(event.target instanceof Element && event.target.closest("[data-map-interactive]"))) changeZoom(1); }}
    >
      <div className="map-tiles" aria-hidden="true">
        {scene.tiles.map((tile) => (
          <img key={tile.key} className="map-tile" draggable={false} alt="" src={`https://tile.openstreetmap.org/${zoom}/${tile.x}/${tile.y}.png`} style={{ left: tile.left, top: tile.top }} />
        ))}
        {overlayView && overlayImages.filter((image) => image.kind !== "lightning" && !overlayFailed(image)).map((image) => (
          <img key={image.src} className={`wms-image ${image.className}`} draggable={false} alt="" src={image.src} onLoad={() => markLoaded(image.src)} onError={() => retryOverlay(image.baseSrc, image.attempt)} style={{ left: overlayView.left - scene.left, top: overlayView.top - scene.top, width: overlayView.width, height: overlayView.height }} />
        ))}
        {radarVisible && radar && radarFrame && scene.tiles.map((tile) => (
          <img key={`radar-${tile.key}`} className="map-tile radar-tile" draggable={false} alt="" src={`${radar.host}${radarFrame.path}/256/${zoom}/${tile.x}/${tile.y}/2/1_1.png`} style={{ left: tile.left, top: tile.top }} />
        ))}
        {overlayView && lightningOverlay && !overlayFailed(lightningOverlay) && (
          <img key={lightningOverlay.src} className={`wms-image ${lightningOverlay.className}`} draggable={false} alt="" src={lightningOverlay.src} onLoad={() => markLoaded(lightningOverlay.src)} onError={() => retryOverlay(lightningOverlay.baseSrc, lightningOverlay.attempt)} style={{ left: overlayView.left - scene.left, top: overlayView.top - scene.top, width: overlayView.width, height: overlayView.height }} />
        )}
      </div>
      <svg className="map-overlay" width={size.width} height={size.height} viewBox={`0 0 ${size.width} ${size.height}`}>
        {ringPaths.map((ring) => <polyline key={ring.radiusKm} points={ring.points} className="range-ring" />)}
        {selected && <>
          <polygon points={uncertaintyPoints} className="uncertainty-area" />
          <line x1={observerPoint.x} y1={observerPoint.y} x2={scene.project(selected.coordinates).x} y2={scene.project(selected.coordinates).y} className="bearing-line" />
        </>}
        <g className="observer-marker" transform={`translate(${observerPoint.x} ${observerPoint.y})`}><circle r="11" /><circle r="4" /></g>
        {candidates.map((candidate) => {
          const point = scene.project(candidate.coordinates);
          const selectedCandidate = candidate.id === selectedId;
          return <g key={candidate.id} data-map-interactive className={`candidate-marker ${selectedCandidate ? "selected" : ""}`} transform={`translate(${point.x} ${point.y})`} role="button" tabIndex={0} aria-label={`Στόχος ${candidate.bearingDeg.toFixed(0)} μοιρών, δείκτης ${candidate.score.total}`} onClick={(event) => { event.stopPropagation(); onSelect(candidate.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(candidate.id); }}><circle className="candidate-halo" r={selectedCandidate ? 19 : 13} /><circle className="candidate-core" r={Math.max(6, candidate.score.total / 9)} /><text y="-19" textAnchor="middle">{candidate.score.total}</text></g>;
        })}
      </svg>
      <div className="map-controls" data-map-interactive onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => changeZoom(1)} disabled={zoom === MAX_ZOOM} aria-label="Μεγέθυνση"><Plus size={17} /></button>
        <span className="map-zoom-level" aria-live="polite">z{zoom}</span>
        <button type="button" onClick={() => changeZoom(-1)} disabled={zoom === MIN_ZOOM} aria-label="Σμίκρυνση"><Minus size={17} /></button>
        <button type="button" onClick={recenter} aria-label="Κεντράρισμα στη θέση παρατήρησης"><LocateFixed size={17} /></button>
      </div>
      <div className="map-status">
        <span>Zoom: κουμπιά · ροδέλα · pinch</span>
        {lightningVisible && <span>{lightningOverlay && overlayFailed(lightningOverlay) ? "MTG-LI προσωρινά μη διαθέσιμο (EUMETView)" : lightningOverlay && !loadedOverlays.has(lightningOverlay.src) ? "MTG-LI φορτώνει…" : satelliteLabel(eumetsat)}</span>}
        <span>{radarVisible ? radarLabel(radar) : "Radar κρυφό"}</span>
      </div>
    </div>
  );
}
