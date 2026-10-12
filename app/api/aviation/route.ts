import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchNearestAviationWeather, unavailableAviation } from "@/lib/providers/aviation-weather";

const schema = z.object({ lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180), elevation: z.coerce.number().default(0) });

export async function GET(request: Request) {
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json(unavailableAviation("Μη έγκυρες συντεταγμένες."), { status: 400 });
  try {
    return NextResponse.json(await fetchNearestAviationWeather({ latitude: parsed.data.lat, longitude: parsed.data.lon, elevationM: parsed.data.elevation }), {
      headers: { "Cache-Control": "public, max-age=600, stale-while-revalidate=1800" },
    });
  } catch (error) {
    return NextResponse.json(unavailableAviation(error instanceof Error ? error.message : "Aviation Weather unavailable"), { status: 502 });
  }
}
