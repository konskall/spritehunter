import { CREATOR, LANGUAGE_PATHS } from "@/lib/seo-copy";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";

const REPOSITORY = "https://github.com/konskall/spritehunter";

// https://llmstxt.org — a plain summary for language models and AI assistants.
const body = `# SpriteHunter

> SpriteHunter is a free, bilingual (Greek/English) web app and installable PWA that helps photographers find thunderstorms likely to produce Red Sprites and other transient luminous events (TLEs) tonight, and tells them exactly where to point the camera. It is built for observers in Greece and the wider Mediterranean.

What it does:

- Scans for storms 200–600 km from the observer (adjustable from 100 to 800 km): real lightning seen by the EUMETSAT MTG Lightning Imager in the last 15 minutes, plus forecast storm cells from Open-Meteo for the next 48 hours.
- Ranks up to 10 targets with a 0–100 opportunity index. The index is a heuristic ranking, not a probability of seeing a sprite.
- Gives the true azimuth, the elevation band where sprites appear (50–90 km altitude), the field of view of the chosen lens, and a terrain line-of-sight check against a 30 m elevation model.
- Guides the phone camera with the device compass, corrected from magnetic to true north with the World Magnetic Model 2025.

How the index is built (maximum points):

- Storm activity 35: MTG-LI lit area and persistence, model instability (CAPE, Lifted Index, CIN, precipitation). With a Vaisala Xweather key, the last 8 points go to positive cloud-to-ground (+CG) strokes, the main trigger of sprites; +50 kA or stronger counts most.
- Sky at the observer 30: cloud (median of Open-Meteo, WeatherAPI.com and OpenWeatherMap, or a fresh nearby METAR) and visibility. High cloud always comes from the model.
- Terrain 20: 20 for a clear view, 10 partial, 0 blocked, 5 while unverified.
- Distance 10: best between 250 and 550 km.
- Darkness 5: astronomical darkness scores most; a bright Moon near the target costs points.
- Caps: forecast-only targets stay at or below 69; daylight (Sun above −6°), blocked terrain or a storm closer than 80 km cap the index at 29.
- Data confidence is high with observed lightning plus a verified horizon or strong +CG, medium with one of them, low otherwise.

Data sources: EUMETSAT MTG-LI and EUMETView WMS (lightning, infrared, cloud-top height, K-index), Open-Meteo forecast and CAMS air quality, Vaisala Xweather lightning summary, WeatherAPI.com, OpenWeatherMap, AviationWeather.gov METAR/TAF, MeteoAlarm warnings for Greece, OpenTopoData SRTM 30 m, RainViewer radar, NOAA SWPC (Kp and OVATION aurora) and NOAA WMM2025.

Limits: TLEs are brief and cannot be forecast with certainty. MTG-LI sees total lightning and cannot tell cloud-to-ground strokes or polarity; the strongest physical indicator, the charge moment change, is not available. Saved sites, lenses and the observation logbook stay in the visitor's browser, and the camera preview is never uploaded.

## App

- [SpriteHunter in Greek](${SITE_URL}${LANGUAGE_PATHS.el}): the app, Greek interface
- [SpriteHunter in English](${SITE_URL}${LANGUAGE_PATHS.en}): the same app with an English interface

## Documentation

- [Scientific method](${REPOSITORY}/blob/main/docs/SCIENTIFIC.md): scoring, geometry, terrain and their limits (Greek)
- [Data providers](${REPOSITORY}/blob/main/docs/PROVIDERS.md): every source, its limits and how the app uses it (Greek)
- [README](${REPOSITORY}/blob/main/README.md): features and setup (Greek)

## Optional

- [Source code](${REPOSITORY}): Next.js app on GitHub
- [Creator: ${CREATOR.name}](${CREATOR.url})
`;

export function GET() {
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
