import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});

const kpSchema = z.array(z.object({
  time_tag: z.string(),
  kp_index: z.number().nullable().optional(),
  estimated_kp: z.number().nullable().optional(),
}));

const ovationSchema = z.object({
  "Observation Time": z.string().nullable().optional(),
  "Forecast Time": z.string().nullable().optional(),
  coordinates: z.array(z.tuple([z.number(), z.number(), z.number()])),
});

function longitudeDifference(a: number, b: number) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

export async function GET(request: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    const [kpRaw, ovationRaw] = await Promise.all([
      fetchJsonWithRetry<unknown>("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json", { retries: 1, timeoutMs: 12_000 }),
      fetchJsonWithRetry<unknown>("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json", { retries: 1, timeoutMs: 18_000 }),
    ]);
    const kpValues = kpSchema.parse(kpRaw);
    const ovation = ovationSchema.parse(ovationRaw);
    const latestKp = [...kpValues].reverse().find((entry) => entry.estimated_kp != null || entry.kp_index != null);
    const kp = latestKp?.estimated_kp ?? latestKp?.kp_index ?? null;
    const localValues = ovation.coordinates
      .filter((value) => Math.abs(value[1] - parsed.data.lat) <= 2 && longitudeDifference(value[0], parsed.data.lon) <= 3)
      .map((value) => value[2]);
    const northernValues = ovation.coordinates
      .filter((value) => value[1] >= parsed.data.lat && value[1] <= Math.min(90, parsed.data.lat + 35) && longitudeDifference(value[0], parsed.data.lon) <= 18)
      .map((value) => value[2]);
    const localProbabilityPercent = localValues.length ? Math.max(...localValues) : null;
    const northernSectorProbabilityPercent = northernValues.length ? Math.max(...northernValues) : null;
    const level = kp == null
      ? "unknown"
      : kp >= 8 || (localProbabilityPercent ?? 0) >= 10
        ? "strong"
        : kp >= 7 || (northernSectorProbabilityPercent ?? 0) >= 20
          ? "possible"
          : kp >= 5
            ? "elevated"
            : "quiet";
    const message = level === "strong"
      ? "Ισχυρή γεωμαγνητική δραστηριότητα. Έλεγξε τον σκοτεινό βόρειο ορίζοντα, χωρίς εγγύηση ορατότητας."
      : level === "possible"
        ? "Υπάρχει ένδειξη αυξημένης δραστηριότητας βόρεια. Η Ελλάδα παραμένει οριακή τοποθεσία."
        : level === "elevated"
          ? "Αυξημένη δραστηριότητα, αλλά συνήθως ανεπαρκής για φωτογραφικό σέλας από την Ελλάδα."
          : "Δεν υπάρχει τώρα αξιόπιστη ένδειξη σέλαος για τη θέση παρατήρησης.";
    return NextResponse.json({
      status: "available",
      retrievedAt: new Date().toISOString(),
      observationTime: ovation["Observation Time"] ?? latestKp?.time_tag ?? null,
      forecastTime: ovation["Forecast Time"] ?? null,
      kp: kp == null ? null : Math.round(kp * 10) / 10,
      localProbabilityPercent,
      northernSectorProbabilityPercent,
      level,
      message,
    }, { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" } });
  } catch (error) {
    return NextResponse.json({
      status: "unavailable",
      retrievedAt: new Date().toISOString(),
      observationTime: null,
      forecastTime: null,
      kp: null,
      localProbabilityPercent: null,
      northernSectorProbabilityPercent: null,
      level: "unknown",
      message: error instanceof Error ? error.message : "NOAA SWPC data unavailable",
    }, { status: 502 });
  }
}
