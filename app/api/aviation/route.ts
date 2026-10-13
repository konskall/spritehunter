import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchNearestAviationWeather, unavailableAviation } from "@/lib/providers/aviation-weather";
import { numberParam, optionalNumberParam } from "@/lib/api-params";
import { tx, unavailableText } from "@/lib/i18n";

const schema = z.object({ lat: numberParam(-90, 90), lon: numberParam(-180, 180), elevation: optionalNumberParam(-500, 9000, 0) });

export async function GET(request: Request) {
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json(unavailableAviation(tx("Μη έγκυρες συντεταγμένες.", "Invalid coordinates.")), { status: 400 });
  try {
    return NextResponse.json(await fetchNearestAviationWeather({ latitude: parsed.data.lat, longitude: parsed.data.lon, elevationM: parsed.data.elevation }), {
      headers: { "Cache-Control": "public, max-age=600, stale-while-revalidate=1800" },
    });
  } catch (error) {
    return NextResponse.json(unavailableAviation(unavailableText(error, "Aviation Weather unavailable")), { status: 502 });
  }
}
