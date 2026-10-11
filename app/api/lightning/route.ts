import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().min(1).max(100).default(100),
});
const providerSchema = z.object({
  success: z.boolean(),
  error: z.unknown().nullable().optional(),
  response: z.array(z.object({
    id: z.string(),
    loc: z.object({ long: z.number(), lat: z.number() }),
    ob: z.object({
      timestamp: z.number(),
      dateTimeISO: z.string(),
      age: z.number(),
      pulse: z.object({
        type: z.string(),
        peakamp: z.number().nullable(),
        numSensors: z.number().nullable().optional(),
        chiSquare: z.number().nullable().optional(),
      }),
    }),
  })),
});

export async function GET(request: Request) {
  const clientId = process.env.XWEATHER_CLIENT_ID;
  const clientSecret = process.env.XWEATHER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { status: "not_configured", events: [], message: "Xweather credentials are not configured; no lightning observations were invented." },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const providerUrl = new URL(`https://data.api.xweather.com/lightning/${parsed.data.lat},${parsed.data.lon}`);
  providerUrl.searchParams.set("client_id", clientId);
  providerUrl.searchParams.set("client_secret", clientSecret);
  providerUrl.searchParams.set("radius", `${parsed.data.radiusKm}km`);
  providerUrl.searchParams.set("limit", "1000");
  try {
    const raw = await fetchJsonWithRetry<unknown>(providerUrl.toString(), { retries: 1, timeoutMs: 10_000 });
    const data = providerSchema.parse(raw);
    if (!data.success) throw new Error("Xweather returned an unsuccessful response.");
    const retrievedAt = new Date().toISOString();
    const events = data.response.map((event) => ({
      id: event.id,
      latitude: event.loc.lat,
      longitude: event.loc.long,
      timestamp: event.ob.dateTimeISO,
      ageSeconds: event.ob.age,
      type: event.ob.pulse.type.toLowerCase() === "cg" ? "cg" : event.ob.pulse.type.toLowerCase() === "ic" ? "ic" : "unknown",
      peakAmplitudeA: event.ob.pulse.peakamp,
      polarity: event.ob.pulse.peakamp == null ? null : event.ob.pulse.peakamp > 0 ? "positive" : "negative",
      sensors: event.ob.pulse.numSensors ?? null,
      chiSquare: event.ob.pulse.chiSquare ?? null,
    }));
    return NextResponse.json({
      status: "available",
      retrievedAt,
      events,
      provenance: {
        provider: "Vaisala Xweather",
        kind: "observation",
        observedAt: events[0]?.timestamp ?? null,
        validAt: null,
        retrievedAt,
        resolution: "Event location; provider-dependent network accuracy",
        freshnessMinutes: events[0] ? Math.round(events[0].ageSeconds / 60) : null,
        quality: "provider-reported",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { status: "unavailable", events: [], message: error instanceof Error ? error.message : "Lightning provider unavailable" },
      { status: 502 },
    );
  }
}
