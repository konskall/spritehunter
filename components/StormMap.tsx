"use client";

import { useEffect, useMemo, useRef } from "react";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type RasterTileSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection, LineString, Point, Polygon } from "geojson";
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

function syncRadarLayer(map: MapLibreMap, radar: RadarMetadata | null, visible: boolean) {
  if (!map.isStyleLoaded()) return;
  const existing = map.getSource("radar") as RasterTileSource | undefined;
  const latest = radar?.radar.past.at(-1);
  const tiles = radar && latest ? [`${radar.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`] : null;
  if (!existing && tiles) {
    map.addSource("radar", { type: "raster", tiles, tileSize: 256, maxzoom: 7 });
    map.addLayer({ id: "radar", type: "raster", source: "radar", paint: { "raster-opacity": visible ? 0.52 : 0, "raster-fade-duration": 250 } }, "uncertainty-fill");
  } else if (existing && tiles) {
    existing.setTiles(tiles);
    map.setPaintProperty("radar", "raster-opacity", visible ? 0.52 : 0);
  }
}

function circleLine(center: Coordinates, radiusKm: number): Feature<LineString> {
  const coordinates = Array.from({ length: 73 }, (_, index) => {
    const point = destinationPoint(center, radiusKm, index * 5);
    return [point.longitude, point.latitude];
  });
  return { type: "Feature", properties: { radiusKm }, geometry: { type: "LineString", coordinates } };
}

function uncertaintyPolygon(candidate: StormCandidate): Feature<Polygon> {
  const coordinates = Array.from({ length: 73 }, (_, index) => {
    const point = destinationPoint(candidate.coordinates, candidate.uncertaintyKm, index * 5);
    return [point.longitude, point.latitude];
  });
  return { type: "Feature", properties: { id: candidate.id }, geometry: { type: "Polygon", coordinates: [[...coordinates, coordinates[0]]] } };
}

function sourceData(
  observer: Coordinates,
  candidates: StormCandidate[],
  selectedId: string | null,
  ringsVisible: boolean,
) {
  const points: FeatureCollection<Point> = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { kind: "observer", id: "observer", score: 0 }, geometry: { type: "Point", coordinates: [observer.longitude, observer.latitude] } },
      ...candidates.map((candidate) => ({
        type: "Feature" as const,
        properties: { kind: "candidate", id: candidate.id, score: candidate.score.total, selected: candidate.id === selectedId },
        geometry: { type: "Point" as const, coordinates: [candidate.coordinates.longitude, candidate.coordinates.latitude] },
      })),
    ],
  };
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? null;
  const lines: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: [
      ...(ringsVisible ? [100, 200, 300, 400, 500, 600].map((radius) => circleLine(observer, radius)) : []),
      ...(selected
        ? [{
            type: "Feature" as const,
            properties: { kind: "bearing" },
            geometry: {
              type: "LineString" as const,
              coordinates: [[observer.longitude, observer.latitude], [selected.coordinates.longitude, selected.coordinates.latitude]],
            },
          }]
        : []),
    ],
  };
  const polygons: FeatureCollection<Polygon> = {
    type: "FeatureCollection",
    features: selected ? [uncertaintyPolygon(selected)] : [],
  };
  return { points, lines, polygons };
}

export default function StormMap({ observer, candidates, selectedId, radar, radarVisible, ringsVisible, onSelect }: StormMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onSelectRef = useRef(onSelect);
  const radarRef = useRef(radar);
  const radarVisibleRef = useRef(radarVisible);
  const data = useMemo(() => sourceData(observer, candidates, selectedId, ringsVisible), [observer, candidates, selectedId, ringsVisible]);
  const dataRef = useRef(data);
  const initialObserverRef = useRef(observer);

  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { radarRef.current = radar; }, [radar]);
  useEffect(() => { radarVisibleRef.current = radarVisible; }, [radarVisible]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const initialObserver = initialObserverRef.current;
    const map = new maplibregl.Map({
      container: containerRef.current,
      center: [initialObserver.longitude, initialObserver.latitude],
      zoom: 4.7,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          basemap: {
            type: "raster",
            tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors © CARTO",
          },
        },
        layers: [{ id: "basemap", type: "raster", source: "basemap", paint: { "raster-saturation": -0.55, "raster-brightness-max": 0.72, "raster-contrast": 0.1 } }],
      },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("load", () => {
      map.addSource("uncertainty", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "uncertainty-fill", type: "fill", source: "uncertainty", paint: { "fill-color": "#f04362", "fill-opacity": 0.12 } });
      map.addLayer({ id: "uncertainty-outline", type: "line", source: "uncertainty", paint: { "line-color": "#ff6a80", "line-width": 1.5, "line-dasharray": [2, 2] } });
      map.addSource("guides", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "guides", type: "line", source: "guides", paint: { "line-color": ["case", ["==", ["get", "kind"], "bearing"], "#f2647c", "#6a8399"], "line-width": ["case", ["==", ["get", "kind"], "bearing"], 2, 1], "line-opacity": 0.65, "line-dasharray": [2, 2] } });
      map.addSource("targets", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "target-halo", type: "circle", source: "targets", filter: ["==", ["get", "kind"], "candidate"], paint: { "circle-radius": ["case", ["==", ["get", "selected"], true], 18, 11], "circle-color": "#f04362", "circle-opacity": 0.13, "circle-stroke-width": 1, "circle-stroke-color": "#ff8194" } });
      map.addLayer({ id: "targets", type: "circle", source: "targets", filter: ["==", ["get", "kind"], "candidate"], paint: { "circle-radius": ["interpolate", ["linear"], ["get", "score"], 0, 5, 69, 10], "circle-color": ["interpolate", ["linear"], ["get", "score"], 0, "#6d7f8f", 35, "#e0a84f", 69, "#f04362"], "circle-stroke-width": 2, "circle-stroke-color": "#07111d" } });
      map.addLayer({ id: "observer", type: "circle", source: "targets", filter: ["==", ["get", "kind"], "observer"], paint: { "circle-radius": 7, "circle-color": "#7de4ca", "circle-stroke-width": 3, "circle-stroke-color": "#07111d" } });
      map.on("click", "targets", (event) => {
        const id = event.features?.[0]?.properties?.id;
        if (typeof id === "string") onSelectRef.current(id);
      });
      map.on("mouseenter", "targets", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "targets", () => { map.getCanvas().style.cursor = ""; });
      (map.getSource("targets") as GeoJSONSource).setData(dataRef.current.points);
      (map.getSource("guides") as GeoJSONSource).setData(dataRef.current.lines);
      (map.getSource("uncertainty") as GeoJSONSource).setData(dataRef.current.polygons);
      syncRadarLayer(map, radarRef.current, radarVisibleRef.current);
    });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    dataRef.current = data;
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    (map.getSource("targets") as GeoJSONSource | undefined)?.setData(data.points);
    (map.getSource("guides") as GeoJSONSource | undefined)?.setData(data.lines);
    (map.getSource("uncertainty") as GeoJSONSource | undefined)?.setData(data.polygons);
  }, [data]);

  useEffect(() => {
    const map = mapRef.current;
    if (map) syncRadarLayer(map, radar, radarVisible);
  }, [radar, radarVisible]);

  useEffect(() => {
    mapRef.current?.easeTo({ center: [observer.longitude, observer.latitude], duration: 700 });
  }, [observer.latitude, observer.longitude]);

  return <div ref={containerRef} className="storm-map" aria-label="Διαδραστικός χάρτης υποψήφιων καταιγίδων" />;
}
