import { NextResponse } from "next/server";
import { z } from "zod";
import { numberParam, optionalNumberParam } from "@/lib/api-params";
import { fetchTerrainProfiles } from "@/lib/providers/terrain";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { tx } from "@/lib/i18n";

// One request covers every listed target (at most 10 per scan).
const MAX_BEARINGS = 12;
const querySchema = z.object({
  lat: numberParam(-90, 90),
  lon: numberParam(-180, 180),
  bearings: z.string()
    .transform((value) => value.split(",").filter((item) => item.trim() !== "").map(Number))
    .pipe(z.array(z.number().finite().min(0).max(360)).min(1).max(MAX_BEARINGS)),
  cameraHeight: optionalNumberParam(0, 100, 1.6),
});
// OpenTopoData allows ~1 request/s and 1,000/day for the whole deployment.
const allowRequest = createRateLimiter({ limit: 20, windowMs: 60_000 });

export async function GET(request: Request) {
  if (!allowRequest(clientKey(request))) {
    return NextResponse.json({ error: tx("Πάρα πολλά αιτήματα εδάφους. Δοκίμασε ξανά σε ένα λεπτό.", "Too many terrain requests. Try again in a minute.") }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { lat, lon, bearings, cameraHeight } = parsed.data;
  const profiles = await fetchTerrainProfiles({ latitude: lat, longitude: lon }, bearings, cameraHeight);
  // Only a complete answer may be reused by the browser; failed bearings are retried next scan.
  const complete = profiles.every((profile) => profile.status === "available");
  return NextResponse.json({ profiles }, complete ? { headers: { "Cache-Control": "public, max-age=86400" } } : undefined);
}
