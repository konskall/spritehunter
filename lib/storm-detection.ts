import type { Coordinates } from "@/lib/domain";
import { inverseGeodesic } from "@/lib/geodesy";

export interface LightningEvent extends Coordinates {
  id?: string;
  timestamp: string;
  amplitudeKa?: number | null;
  type?: "cg" | "ic" | "unknown";
}

export function deduplicateLightning(events: LightningEvent[]) {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = event.id ?? `${event.timestamp}:${event.latitude.toFixed(4)}:${event.longitude.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function clusterLightning(events: LightningEvent[], epsilonKm = 35, minimumPoints = 3) {
  const labels = new Array<number>(events.length).fill(-1);
  const visited = new Set<number>();
  let clusterId = 0;
  const neighbors = (index: number) =>
    events
      .map((event, otherIndex) => ({
        otherIndex,
        distanceKm: inverseGeodesic(events[index], event).distanceM / 1000,
      }))
      .filter(({ distanceKm }) => distanceKm <= epsilonKm)
      .map(({ otherIndex }) => otherIndex);

  for (let i = 0; i < events.length; i += 1) {
    if (visited.has(i)) continue;
    visited.add(i);
    const nearby = neighbors(i);
    if (nearby.length < minimumPoints) continue;
    labels[i] = clusterId;
    const queue = [...nearby];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const point = queue[cursor];
      if (!visited.has(point)) {
        visited.add(point);
        const pointNeighbors = neighbors(point);
        if (pointNeighbors.length >= minimumPoints) {
          for (const candidate of pointNeighbors) if (!queue.includes(candidate)) queue.push(candidate);
        }
      }
      if (labels[point] === -1) labels[point] = clusterId;
    }
    clusterId += 1;
  }

  return Array.from({ length: clusterId }, (_, id) => {
    const members = events.filter((_, index) => labels[index] === id);
    return {
      id,
      events: members,
      centroid: {
        latitude: members.reduce((sum, event) => sum + event.latitude, 0) / members.length,
        longitude: members.reduce((sum, event) => sum + event.longitude, 0) / members.length,
      },
    };
  });
}

export function estimateMotion(
  earlier: Coordinates & { timestamp: string },
  later: Coordinates & { timestamp: string },
) {
  const elapsedHours = (new Date(later.timestamp).getTime() - new Date(earlier.timestamp).getTime()) / 3_600_000;
  if (elapsedHours <= 0) return null;
  const inverse = inverseGeodesic(earlier, later);
  return { bearingDeg: inverse.initialBearingDeg, speedKmh: inverse.distanceM / 1000 / elapsedHours };
}

