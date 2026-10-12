import { NextResponse } from "next/server";
import { fetchMeteoAlarm, unavailableMeteoAlarm } from "@/lib/providers/meteoalarm";

export async function GET() {
  try {
    return NextResponse.json(await fetchMeteoAlarm(), { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=900" } });
  } catch (error) {
    return NextResponse.json(unavailableMeteoAlarm(error instanceof Error ? error.message : "MeteoAlarm unavailable"), { status: 502 });
  }
}
