import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchOpportunities } from "@/lib/providers/open-meteo";

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  elevation: z.coerce.number().min(-500).max(9000).default(210),
  minKm: z.coerce.number().min(100).max(800).default(200),
  maxKm: z.coerce.number().min(100).max(800).default(600),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success || parsed.data.minKm >= parsed.data.maxKm) {
    return NextResponse.json(
      { error: "Invalid location or search-range parameters.", details: parsed.success ? "minKm must be below maxKm" : parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const data = await fetchOpportunities(
      { latitude: parsed.data.lat, longitude: parsed.data.lon, elevationM: parsed.data.elevation },
      parsed.data.minKm,
      parsed.data.maxKm,
    );
    return NextResponse.json(data, { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Forecast provider failed", status: "unavailable", checkedAt: new Date().toISOString() },
      { status: 502 },
    );
  }
}

