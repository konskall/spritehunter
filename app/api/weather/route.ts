import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchWeatherStation } from "@/lib/providers/weather-station";
import { numberParam } from "@/lib/api-params";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { tx, unavailableText } from "@/lib/i18n";

const querySchema = z.object({
  lat: numberParam(-90, 90),
  lon: numberParam(-180, 180),
});
// Each uncached request costs two Open-Meteo calls; the provider caches 15 minutes per site.
const allowRequest = createRateLimiter({ limit: 30, windowMs: 60_000 });

export async function GET(request: Request) {
  if (!allowRequest(clientKey(request))) {
    return NextResponse.json({ error: tx("Πάρα πολλά αιτήματα σε σύντομο χρόνο. Δοκίμασε ξανά σε ένα λεπτό.", "Too many requests in a short time. Try again in a minute.") }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: tx("Μη έγκυρη θέση.", "Invalid location."), details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const data = await fetchWeatherStation({ latitude: parsed.data.lat, longitude: parsed.data.lon });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: unavailableText(error, "Weather forecast failed") }, { status: 502 });
  }
}
