import { NextResponse } from "next/server";
import { fetchEumetsatMetadata } from "@/lib/providers/eumetsat";

export async function GET() {
  try {
    return NextResponse.json(await fetchEumetsatMetadata(), {
      headers: { "Cache-Control": "public, max-age=240, stale-while-revalidate=600" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "unavailable",
        retrievedAt: new Date().toISOString(),
        lightningTime: null,
        infraredTime: null,
        cloudTopTime: null,
        kIndexTime: null,
        liftedIndexTime: null,
        message: error instanceof Error ? error.message : "EUMETSAT metadata unavailable",
      },
      { status: 502 },
    );
  }
}
