import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";

const schema = z.object({
  version: z.string(),
  generated: z.number(),
  host: z.string().url(),
  radar: z.object({
    past: z.array(z.object({ time: z.number(), path: z.string() })),
  }),
});

export async function GET() {
  try {
    const raw = await fetchJsonWithRetry<unknown>("https://api.rainviewer.com/public/weather-maps.json", { retries: 1 });
    const data = schema.parse(raw);
    return NextResponse.json(
      { ...data, attribution: "RainViewer", coveragePath: "/v2/coverage/0/256/{z}/{x}/{y}/0/0_0.png" },
      { headers: { "Cache-Control": "public, max-age=240, stale-while-revalidate=600" } },
    );
  } catch (error) {
    return NextResponse.json(
      { status: "unavailable", error: error instanceof Error ? error.message : "Radar metadata unavailable", checkedAt: new Date().toISOString() },
      { status: 502 },
    );
  }
}

