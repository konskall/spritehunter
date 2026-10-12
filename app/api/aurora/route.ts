import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";
import { numberParam } from "@/lib/api-params";
import { TtlCache } from "@/lib/bounded-cache";
import { assessAurora, parseOvationCoordinates, type OvationPoint } from "@/lib/providers/aurora";

const querySchema = z.object({
  lat: numberParam(-90, 90),
  lon: numberParam(-180, 180),
});

const kpSchema = z.array(z.object({
  time_tag: z.string(),
  kp_index: z.number().nullable().optional(),
  estimated_kp: z.number().nullable().optional(),
}));

interface SpaceWeather {
  kp: number | null;
  kpTime: string | null;
  observationTime: string | null;
  forecastTime: string | null;
  coordinates: OvationPoint[];
}

// The ~900 KB OVATION grid is identical for every observer and updates about every 5 minutes.
const spaceWeatherCache = new TtlCache<SpaceWeather>(1);
let pending: Promise<SpaceWeather> | null = null;

async function loadSpaceWeather() {
  const cached = spaceWeatherCache.get("noaa");
  if (cached) return cached;
  pending ??= (async () => {
    try {
      const [kpRaw, ovationRaw] = await Promise.all([
        fetchJsonWithRetry<unknown>("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json", { retries: 1, timeoutMs: 12_000, deadlineMs: 18_000 }),
        fetchJsonWithRetry<unknown>("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json", { retries: 1, timeoutMs: 18_000, deadlineMs: 25_000 }),
      ]);
      const latestKp = [...kpSchema.parse(kpRaw)].reverse().find((entry) => entry.estimated_kp != null || entry.kp_index != null);
      const ovation = ovationRaw as Record<string, unknown>;
      const value: SpaceWeather = {
        kp: latestKp?.estimated_kp ?? latestKp?.kp_index ?? null,
        kpTime: latestKp?.time_tag ?? null,
        observationTime: typeof ovation["Observation Time"] === "string" ? ovation["Observation Time"] : null,
        forecastTime: typeof ovation["Forecast Time"] === "string" ? ovation["Forecast Time"] : null,
        coordinates: parseOvationCoordinates(ovationRaw),
      };
      spaceWeatherCache.set("noaa", value, 5 * 60_000);
      return value;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

export async function GET(request: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    const spaceWeather = await loadSpaceWeather();
    const assessment = assessAurora(spaceWeather.kp, spaceWeather.coordinates, parsed.data.lat, parsed.data.lon);
    return NextResponse.json({
      status: "available",
      retrievedAt: new Date().toISOString(),
      observationTime: spaceWeather.observationTime ?? spaceWeather.kpTime,
      forecastTime: spaceWeather.forecastTime,
      kp: spaceWeather.kp == null ? null : Math.round(spaceWeather.kp * 10) / 10,
      ...assessment,
    }, { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" } });
  } catch (error) {
    return NextResponse.json({
      status: "unavailable",
      retrievedAt: new Date().toISOString(),
      observationTime: null,
      forecastTime: null,
      kp: null,
      localProbabilityPercent: null,
      northernSectorProbabilityPercent: null,
      level: "unknown",
      message: error instanceof Error ? error.message : "NOAA SWPC data unavailable",
    }, { status: 502 });
  }
}
