import { CREATOR, LANGUAGE_PATHS } from "@/lib/seo-copy";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";

const REPOSITORY = "https://github.com/konskall/spritehunter";

// https://llmstxt.org — a plain summary for language models and AI assistants.
const body = `# SpriteHunter

> SpriteHunter is a free, bilingual (Greek/English) web app and installable PWA that helps photographers find thunderstorms likely to produce Red Sprites and other transient luminous events (TLEs) tonight, and tells them exactly where to point the camera. It is built for observers in Greece and the wider Mediterranean.

What it does:

- Scans for storms 100–600 km from the observer (adjustable from 100 to 800 km): real lightning seen by the EUMETSAT MTG Lightning Imager in the last 15 minutes, plus forecast storm cells from Open-Meteo for the next 48 hours on a grid every 15° and 100 km.
- Ranks up to 10 targets with a 0–100 opportunity index. The index is a heuristic ranking, not a probability of seeing a sprite.
- Gives the true azimuth, the elevation band where sprites appear (50–90 km altitude) widened by the uncertainty in the storm's distance, a separate band for blue and gigantic jets (15–50 km), the field of view of the chosen lens, and a terrain line-of-sight check against a 30 m elevation model.
- Guides the phone camera with the device compass, corrected from magnetic to true north with the World Magnetic Model 2025.
- Shows the NOAA OVATION aurora forecast; aurora counts as possible only where it would rise above the horizon (within ~1,600 km to the north).

How the index is built (maximum points):

- Storm activity 35: for observed storms, MTG-LI lit area, flash rate and persistence (up to 27, with a small share from the nearest model cell); for forecast cells, the model's rain and thunderstorm code first, instability second. With a Vaisala Xweather key, the last 8 points go to positive cloud-to-ground (+CG) strokes, the main trigger of sprites (+50 kA or stronger counts most; below 15 kA does not count), or 4 to a ±100 kA stroke, which drives ELVES and halos.
- Sky 30: cloud at the observer (median of Open-Meteo, WeatherAPI.com and OpenWeatherMap; a fresh nearby METAR replaces only the low cloud it can see) and forecast cloud along the line of sight 40–90 km towards the target, plus visibility.
- Terrain 20: 20 for a clear view, 10 partial, 0 blocked, 5 while unverified.
- Distance 10: full from 100 to 300 km, less farther away, where sprites are lower and dimmer.
- Darkness 5: astronomical darkness scores most; a bright Moon near the target costs points.
- Ceilings: forecast-only targets are scaled into 0–69; a forecast cell where MTG-LI sees no lightning right now stays at or below 49; cloud blocking 70 % of the view lowers the ceiling to 69, 80 % to 49, 90 % to 29; daylight (Sun above −6°), blocked terrain or a storm closer than 80 km cap the index at 29.
- Data confidence is high with observed lightning plus a verified horizon or strong +CG, medium with one of them, low otherwise.
- Checked against reality: npm run verify compares the forecast targets with storms MTG-LI saw, and the listed storms with verified TLE photos from NASA Spritacular.

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
