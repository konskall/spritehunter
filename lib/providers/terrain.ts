import { z } from "zod";
import { apparentTerrainAngle, destinationPoint } from "@/lib/geodesy";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";
import type { Coordinates, TerrainProfile } from "@/lib/domain";
import { TtlCache } from "@/lib/bounded-cache";
import { terrainBearingKey } from "@/lib/terrain";
import { tx, unavailableText } from "@/lib/i18n";

const elevationSchema = z.object({
  status: z.string(),
  results: z.array(z.object({
    elevation: z.number().nullable(),
    location: z.object({ lat: z.number(), lng: z.number() }),
  })),
});
const PROVIDER = "OpenTopoData / SRTM 30 m";
const DISTANCES_KM = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20, 30, 40, 55, 70, 90, 120];
// The public OpenTopoData API takes up to 100 locations per request and ~1 request/s,
// with 1,000 requests a day for the whole deployment: five bearings share one request.
const MAX_LOCATIONS = 100;
const BEARINGS_PER_REQUEST = Math.floor(MAX_LOCATIONS / DISTANCES_KM.length);
const REQUEST_SPACING_MS = 1_100;
// Each server instance stays under the shared daily limit on its own, so a flood of new
// locations (the API is public) cannot leave every visitor without terrain checks.
const DAILY_REQUEST_BUDGET = 800;
const DAY_MS = 24 * 60 * 60_000;
const budget = { day: -1, used: 0 };
let lastRequestAtMs = 0;
let queue: Promise<void> = Promise.resolve();

class BudgetError extends Error {}

/** Waits for this instance's next DEM slot: one call per second across concurrent requests. */
function nextDemSlot(): Promise<void> {
  const slot = queue.then(async () => {
    const day = Math.floor(Date.now() / DAY_MS);
    if (budget.day !== day) Object.assign(budget, { day, used: 0 });
    if (budget.used >= DAILY_REQUEST_BUDGET) throw new BudgetError("DEM daily budget used");
    const wait = lastRequestAtMs + REQUEST_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAtMs = Date.now();
    budget.used += 1;
  });
  queue = slot.catch(() => undefined);
  return slot;
}
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const cache = new TtlCache<TerrainProfile>(2_000);

const cacheKey = (observer: Coordinates, bearing: number, cameraHeight: number) =>
  `${observer.latitude.toFixed(4)}:${observer.longitude.toFixed(4)}:${bearing.toFixed(1)}:${cameraHeight}`;

function unavailableProfile(bearing: number, retrievedAt: string, error: unknown): TerrainProfile {
  return {
    status: "unavailable",
    provider: PROVIDER,
    bearingDeg: bearing,
    observerElevationM: null,
    horizonAngleDeg: null,
    samples: [],
    retrievedAt,
    message: error instanceof BudgetError
      ? tx("Το ημερήσιο όριο του δημόσιου DEM εξαντλήθηκε· ο ορίζοντας μένει ανεπαλήθευτος ως την επόμενη μέρα.", "The public DEM's daily limit is used up; the horizon stays unverified until the next day.")
      : error instanceof Error && error.name === "AbortError"
        ? tx("Ο πάροχος DEM (OpenTopoData) δεν απάντησε εγκαίρως· ο ορίζοντας παραμένει μη επαληθευμένος.", "The DEM provider (OpenTopoData) did not answer in time; the horizon stays unverified.")
        : unavailableText(error, "Terrain provider unavailable"),
  };
}

async function fetchChunk(observer: Coordinates, bearings: number[], cameraHeight: number): Promise<TerrainProfile[]> {
  await nextDemSlot();
  const points = bearings.flatMap((bearing) => DISTANCES_KM.map((distance) => destinationPoint(observer, distance, bearing)));
  const locations = points.map((point) => `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`).join("|");
  const retrievedAt = new Date().toISOString();
  const raw = await fetchJsonWithRetry<unknown>(
    `https://api.opentopodata.org/v1/srtm30m?locations=${encodeURIComponent(locations)}&interpolation=bilinear`,
    { retries: 1, timeoutMs: 12_000, deadlineMs: 18_000 },
  );
  const payload = elevationSchema.parse(raw);
  if (payload.results.length !== points.length) throw new Error("DEM returned an incomplete profile.");
  return bearings.map((bearing, index) => {
    const results = payload.results.slice(index * DISTANCES_KM.length, (index + 1) * DISTANCES_KM.length);
    const observerGround = results[0]?.elevation;
    if (observerGround == null) return unavailableProfile(bearing, retrievedAt, new Error("Observer elevation is missing from DEM."));
    const observerElevationM = observerGround + cameraHeight;
    const samples = results.map((result, sampleIndex) => ({
      distanceKm: DISTANCES_KM[sampleIndex],
      latitude: result.location.lat,
      longitude: result.location.lng,
      elevationM: result.elevation,
      apparentElevationDeg:
        result.elevation == null || DISTANCES_KM[sampleIndex] === 0
          ? null
          : apparentTerrainAngle(observerElevationM, result.elevation, DISTANCES_KM[sampleIndex]),
    }));
    const angles = samples.map((sample) => sample.apparentElevationDeg).filter((angle): angle is number => angle != null);
    return {
      status: angles.length ? "available" : "unavailable",
      provider: PROVIDER,
      bearingDeg: bearing,
      observerElevationM,
      horizonAngleDeg: angles.length ? Math.max(...angles) : null,
      samples,
      retrievedAt,
      message: tx("Προφίλ τομέα με προσαρμοστική δειγματοληψία έως 120 km· τα δημόσια δεδομένα DEM μπορεί να έχουν κενά και δεν είναι τοπογραφική μέτρηση πεδίου.", "Sector profile sampled adaptively to 120 km; public DEM data can contain voids and is not a field survey."),
    } satisfies TerrainProfile;
  });
}

/**
 * DEM horizon profiles for several bearings, so every listed target is scored with the
 * same terrain check. Bearings are whole degrees and cached for a week; only the missing
 * ones are requested, five per DEM call, one call per second within a daily budget.
 */
export async function fetchTerrainProfiles(observer: Coordinates, bearingsDeg: number[], cameraHeight: number): Promise<TerrainProfile[]> {
  const bearings = Array.from(new Set(bearingsDeg.map(terrainBearingKey)));
  const found = new Map<number, TerrainProfile>();
  const missing: number[] = [];
  for (const bearing of bearings) {
    const cached = cache.get(cacheKey(observer, bearing, cameraHeight));
    if (cached) found.set(bearing, cached);
    else missing.push(bearing);
  }
  for (let start = 0; start < missing.length; start += BEARINGS_PER_REQUEST) {
    const chunk = missing.slice(start, start + BEARINGS_PER_REQUEST);
    try {
      for (const profile of await fetchChunk(observer, chunk, cameraHeight)) {
        found.set(profile.bearingDeg, profile);
        if (profile.status === "available") cache.set(cacheKey(observer, profile.bearingDeg, cameraHeight), profile, CACHE_TTL_MS);
      }
    } catch (error) {
      const retrievedAt = new Date().toISOString();
      for (const bearing of chunk) found.set(bearing, unavailableProfile(bearing, retrievedAt, error));
    }
  }
  return bearings.map((bearing) => found.get(bearing)!);
}
