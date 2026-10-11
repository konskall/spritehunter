import { NextResponse } from "next/server";
import { z } from "zod";
import { apparentTerrainAngle, destinationPoint } from "@/lib/geodesy";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";
import type { TerrainProfile } from "@/lib/domain";

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  bearing: z.coerce.number().min(0).max(360),
  cameraHeight: z.coerce.number().min(0).max(100).default(1.6),
});
const elevationSchema = z.object({
  status: z.string(),
  results: z.array(z.object({
    elevation: z.number().nullable(),
    location: z.object({ lat: z.number(), lng: z.number() }),
  })),
});
const cache = new Map<string, { expires: number; value: TerrainProfile }>();
const DISTANCES_KM = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20, 30, 40, 55, 70, 90, 120];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { lat, lon, bearing, cameraHeight } = parsed.data;
  const key = `${lat.toFixed(4)}:${lon.toFixed(4)}:${bearing.toFixed(1)}:${cameraHeight}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return NextResponse.json(cached.value);

  const observer = { latitude: lat, longitude: lon };
  const points = DISTANCES_KM.map((distance) => destinationPoint(observer, distance, bearing));
  const locations = points.map((point) => `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`).join("|");
  const retrievedAt = new Date().toISOString();
  try {
    const raw = await fetchJsonWithRetry<unknown>(
      `https://api.opentopodata.org/v1/srtm30m?locations=${encodeURIComponent(locations)}&interpolation=bilinear`,
      { retries: 1, timeoutMs: 15_000 },
    );
    const payload = elevationSchema.parse(raw);
    const observerGround = payload.results[0]?.elevation;
    if (observerGround == null) throw new Error("Observer elevation is missing from DEM.");
    const observerElevationM = observerGround + cameraHeight;
    const samples = payload.results.map((result, index) => ({
      distanceKm: DISTANCES_KM[index],
      latitude: result.location.lat,
      longitude: result.location.lng,
      elevationM: result.elevation,
      apparentElevationDeg:
        result.elevation == null || DISTANCES_KM[index] === 0
          ? null
          : apparentTerrainAngle(observerElevationM, result.elevation, DISTANCES_KM[index]),
    }));
    const angles = samples.map((sample) => sample.apparentElevationDeg).filter((angle): angle is number => angle != null);
    const value: TerrainProfile = {
      status: angles.length ? "available" : "unavailable",
      provider: "OpenTopoData / SRTM 30 m",
      bearingDeg: bearing,
      observerElevationM,
      horizonAngleDeg: angles.length ? Math.max(...angles) : null,
      samples,
      retrievedAt,
      message: "Sector profile sampled adaptively to 120 km; public DEM data can contain voids and is not a field survey.",
    };
    cache.set(key, { expires: Date.now() + 7 * 24 * 60 * 60_000, value });
    return NextResponse.json(value, { headers: { "Cache-Control": "public, max-age=86400" } });
  } catch (error) {
    return NextResponse.json(
      {
        status: "unavailable",
        provider: "OpenTopoData / SRTM 30 m",
        bearingDeg: bearing,
        observerElevationM: null,
        horizonAngleDeg: null,
        samples: [],
        retrievedAt,
        message: error instanceof Error ? error.message : "Terrain provider unavailable",
      } satisfies TerrainProfile,
      { status: 502 },
    );
  }
}
