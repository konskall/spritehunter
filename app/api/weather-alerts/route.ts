import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchMeteoAlarm, unavailableMeteoAlarm } from "@/lib/providers/meteoalarm";
import { numberParam } from "@/lib/api-params";

const querySchema = z.object({ lat: numberParam(-90, 90), lon: numberParam(-180, 180) });

export async function GET(request: Request) {
  // Coordinates are optional and only order alerts by proximity.
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  const observer = parsed.success ? { latitude: parsed.data.lat, longitude: parsed.data.lon } : undefined;
  try {
    return NextResponse.json(await fetchMeteoAlarm(observer), { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=900" } });
  } catch (error) {
    return NextResponse.json(unavailableMeteoAlarm(error instanceof Error ? error.message : "MeteoAlarm unavailable"), { status: 502 });
  }
}
