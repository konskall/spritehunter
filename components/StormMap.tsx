"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { LocateFixed, Minus, Plus } from "lucide-react";
import type { Coordinates, StormCandidate } from "@/lib/domain";
import { destinationPoint } from "@/lib/geodesy";

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
  ringsVisible: boolean;
  onSelect: (id: string) => void;
}

const TILE_SIZE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 7;

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

function radarLabel(radar: RadarMetadata | null) {
  const timestamp = radar?.radar.past.at(-1)?.time;
  if (!timestamp) return "Radar μη διαθέσιμο";
  return `Radar ${new Intl.DateTimeFormat("el-GR", { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp * 1000))}`;
}

export default function StormMap({ observer, candidates, selectedId, radar, radarVisible, ringsVisible, onSelect }: StormMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerX: number; pointerY: number; centerX: number; centerY: number } | null>(null);
  const [size, setSize] = useState({ width: 900, height: 560 });
  const [center, setCenter] = useState<Coordinates>(observer);
  const [zoom, setZoom] = useState(4);

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
        tiles.push({ key: `${x}-${y}`, x: wrappedX, y, left: x * TILE_SIZE - left, top: y * TILE_SIZE - top });
      }
    }
    const project = (point: Coordinates) => {
      const world = worldPoint(point, zoom);
      let x = world.x - left;
      if (x < -scale / 2) x += scale;
      if (x > scale / 2 + size.width) x -= scale;
      return { x, y: world.y - top };
    };
    return { centerWorld, left, top, tiles, project };
  }, [center, size, zoom]);

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
  const changeZoom = (next: number) => setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next)));
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const point = worldPoint(center, zoom);
    dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, centerX: point.x, centerY: point.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = worldCoordinates(drag.centerX - (event.clientX - drag.pointerX), drag.centerY - (event.clientY - drag.pointerY), zoom);
    setCenter({ latitude: Math.max(-80, Math.min(80, next.latitude)), longitude: next.longitude });
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      ref={containerRef}
      className="storm-map tile-map"
      aria-label="Διαδραστικός χάρτης υποψήφιων καταιγίδων"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
    >
      <div className="map-tiles" aria-hidden="true">
        {scene.tiles.map((tile) => (
          <div key={tile.key}>
            <img className="map-tile" draggable={false} alt="" src={`https://tile.openstreetmap.org/${zoom}/${tile.x}/${tile.y}.png`} style={{ left: tile.left, top: tile.top }} />
            {radarVisible && radar && radarFrame && <img className="map-tile radar-tile" draggable={false} alt="" src={`${radar.host}${radarFrame.path}/256/${zoom}/${tile.x}/${tile.y}/2/1_1.png`} style={{ left: tile.left, top: tile.top }} />}
          </div>
        ))}
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
          return <g key={candidate.id} className={`candidate-marker ${selectedCandidate ? "selected" : ""}`} transform={`translate(${point.x} ${point.y})`} role="button" tabIndex={0} aria-label={`Στόχος ${candidate.bearingDeg.toFixed(0)} μοιρών, δείκτης ${candidate.score.total}`} onClick={(event) => { event.stopPropagation(); onSelect(candidate.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(candidate.id); }}><circle className="candidate-halo" r={selectedCandidate ? 19 : 13} /><circle className="candidate-core" r={Math.max(6, candidate.score.total / 9)} /><text y="-19" textAnchor="middle">{candidate.score.total}</text></g>;
        })}
      </svg>
      <div className="map-controls">
        <button type="button" onClick={() => changeZoom(zoom + 1)} disabled={zoom === MAX_ZOOM} aria-label="Μεγέθυνση"><Plus size={17} /></button>
        <button type="button" onClick={() => changeZoom(zoom - 1)} disabled={zoom === MIN_ZOOM} aria-label="Σμίκρυνση"><Minus size={17} /></button>
        <button type="button" onClick={recenter} aria-label="Κεντράρισμα στη θέση παρατήρησης"><LocateFixed size={17} /></button>
      </div>
      <div className="map-status"><span>HTML tiles · χωρίς WebGL</span><span>{radarVisible ? radarLabel(radar) : "Radar κρυφό"}</span></div>
    </div>
  );
}
