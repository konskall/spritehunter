import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchOpportunities } from "@/lib/providers/open-meteo";
import { numberParam, optionalNumberParam } from "@/lib/api-params";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";

const querySchema = z.object({
  lat: numberParam(-90, 90),
  lon: numberParam(-180, 180),
  elevation: optionalNumberParam(-500, 9000, 210),
  minKm: optionalNumberParam(100, 800, 200),
  maxKm: optionalNumberParam(100, 800, 600),
});
// Each uncached scan costs several upstream forecast requests.
const allowRequest = createRateLimiter({ limit: 30, windowMs: 60_000 });

export async function GET(request: Request) {
  if (!allowRequest(clientKey(request))) {
    return NextResponse.json({ error: "Πάρα πολλές σαρώσεις σε σύντομο χρόνο. Δοκίμασε ξανά σε ένα λεπτό." }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success || parsed.data.minKm >= parsed.data.maxKm) {
    return NextResponse.json(
      { error: "Μη έγκυρη θέση ή ακτίνα σάρωσης.", details: parsed.success ? "minKm must be below maxKm" : parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const data = await fetchOpportunities(
      { latitude: parsed.data.lat, longitude: parsed.data.lon, elevationM: parsed.data.elevation },
      parsed.data.minKm,
      parsed.data.maxKm,
    );
    // The server already caches forecasts (15 min) and lightning (4 min). A browser cache on top
    // served "Refresh data" from disk for up to 15 minutes and hid new lightning frames.
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Forecast provider failed", status: "unavailable", checkedAt: new Date().toISOString() },
      { status: 502 },
    );
  }
}
