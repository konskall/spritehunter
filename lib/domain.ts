import type { Localized } from "@/lib/i18n";

export type DataStatus =
  | "available"
  | "stale"
  | "unavailable"
  | "unsupported"
  | "not_configured";

export type DataKind = "observation" | "forecast" | "derived";

export interface Coordinates {
  latitude: number;
  longitude: number;
  elevationM?: number;
}

export interface Provenance {
  provider: string;
  kind: DataKind;
  observedAt: string | null;
  validAt: string | null;
  retrievedAt: string;
  resolution: string | null;
  status: DataStatus;
  freshnessMinutes: number | null;
  quality: "high" | "medium" | "low" | "unknown";
  message?: string;
}

export interface WeatherHour {
  time: string;
  temperatureC: number | null;
  relativeHumidity: number | null;
  precipitationMm: number | null;
  precipitationProbability: number | null;
  cloudCover: number | null;
  cloudCoverLow: number | null;
  cloudCoverMid: number | null;
  cloudCoverHigh: number | null;
  visibilityM: number | null;
  windSpeedKmh: number | null;
  windDirectionDeg: number | null;
  capeJkg: number | null;
  convectiveInhibitionJkg: number | null;
  liftedIndex: number | null;
  precipitableWaterKgM2: number | null;
  weatherCode: number | null;
  /** Total cloud for this hour from each forecast source, when its key is configured. */
  cloudSources?: CloudSources;
  /** Median total cloud of the available sources (equals `cloudCover` with Open-Meteo alone). */
  cloudConsensus?: number | null;
}

export interface CloudSources {
  openMeteo: number | null;
  weatherApi: number | null;
  openWeather: number | null;
}

export interface AirQualityHour {
  time: string;
  pm10: number | null;
  pm2_5: number | null;
  dust: number | null;
  aerosolOpticalDepth: number | null;
}

/** Model conditions at the observer for one instant (the weather station screen). */
export interface StationConditions {
  time: string;
  temperatureC: number | null;
  apparentTemperatureC: number | null;
  relativeHumidity: number | null;
  dewPointC: number | null;
  /** Sea-level pressure, hPa. */
  pressureHpa: number | null;
  windSpeedKmh: number | null;
  windGustsKmh: number | null;
  windDirectionDeg: number | null;
  cloudCover: number | null;
  precipitationMm: number | null;
  visibilityM: number | null;
  uvIndex: number | null;
  weatherCode: number | null;
  isDay: boolean | null;
}

export interface StationHour extends StationConditions {
  precipitationProbability: number | null;
  cloudCoverLow: number | null;
  cloudCoverMid: number | null;
  cloudCoverHigh: number | null;
  capeJkg: number | null;
  liftedIndex: number | null;
  convectiveInhibitionJkg: number | null;
  freezingLevelM: number | null;
}

export interface StationDay {
  /**
   * Start of the day at the response's UTC offset (the one at request time): after a clock change
   * that is 23:00 or 01:00 Athens time. Twelve hours later always falls on the day itself.
   */
  date: string;
  weatherCode: number | null;
  temperatureMaxC: number | null;
  temperatureMinC: number | null;
  precipitationMm: number | null;
  precipitationProbability: number | null;
  precipitationHours: number | null;
  windSpeedMaxKmh: number | null;
  windGustsMaxKmh: number | null;
  windDirectionDeg: number | null;
  uvIndexMax: number | null;
  sunshineHours: number | null;
}

/** CAMS air quality. The `aqi*` values are European AQI sub-indices (0–100+, higher is worse). */
export interface AirQualityConditions {
  time: string;
  europeanAqi: number | null;
  aqiPm2_5: number | null;
  aqiPm10: number | null;
  aqiNitrogenDioxide: number | null;
  aqiOzone: number | null;
  aqiSulphurDioxide: number | null;
  pm2_5: number | null;
  pm10: number | null;
  carbonMonoxide: number | null;
  nitrogenDioxide: number | null;
  sulphurDioxide: number | null;
  ozone: number | null;
  dust: number | null;
  aerosolOpticalDepth: number | null;
  /** Pollen in grains/m³; CAMS forecasts it for Europe in season. */
  pollen: Record<PollenType, number | null>;
}

export type PollenType = "alder" | "birch" | "grass" | "mugwort" | "olive" | "ragweed";

export interface WeatherStationResponse {
  status: DataStatus;
  retrievedAt: string;
  observer: Coordinates;
  /** Elevation of the model point, which its temperatures refer to. */
  modelElevationM: number | null;
  current: StationConditions | null;
  /** From a few hours before now (for the pressure tendency) to 48 hours ahead. */
  hours: StationHour[];
  days: StationDay[];
  airQuality: {
    status: DataStatus;
    current: AirQualityConditions | null;
    hours: AirQualityConditions[];
    message: Localized;
  };
  message: Localized;
}

export interface PointingAltitude {
  altitudeKm: number;
  elevationDeg: number;
  slantRangeKm: number;
}

export interface ScoreBreakdown {
  activity: number;
  atmosphere: number;
  terrain: number;
  distance: number;
  darkness: number;
  total: number;
  confidence: "high" | "medium" | "low" | "insufficient";
  category: "poor" | "low" | "possible" | "promising" | "very_promising";
  reasons: Localized[];
  limitations: Localized[];
}

/** Lightning that EUMETSAT MTG-LI observed at (or near) a target. */
export interface ObservedLightning {
  /** Id of the MTG-LI storm this lightning belongs to. */
  stormId?: string;
  /** Start of the newest 5-minute MTG-LI frame that contains this storm. */
  observedAt: string;
  ageMinutes: number;
  /** Area of the lit MTG-LI pixels across the sampled frames. */
  areaKm2: number;
  /** Highest per-pixel accumulated flash count in one 5-minute frame (legend saturates at 20). */
  maxFlashesPer5Min: number;
  /** Number of sampled 5-minute frames in which the storm was lit. */
  frames: number;
  windowMinutes: number;
  /** Cloud-to-ground strokes and their polarity from Vaisala Xweather, when configured. */
  cg?: CgLightning | null;
}

/**
 * Cloud-to-ground lightning in an observed storm over the last minutes. Sprites are
 * triggered mostly by large positive CG strokes, which MTG-LI cannot tell apart.
 */
export interface CgLightning {
  windowMinutes: number;
  cgCount: number;
  positiveCount: number;
  negativeCount: number;
  /** Peak current of the strongest positive stroke in kA, when reported. */
  maxPositiveKa: number | null;
  /** Peak current of the strongest negative stroke in kA (as a positive number), when reported. */
  maxNegativeKa?: number | null;
  retrievedAt: string;
}

export interface LightningCluster extends ObservedLightning {
  id: string;
  centroid: Coordinates;
  radiusKm: number;
}

export interface LightningObservation {
  status: DataStatus;
  retrievedAt: string;
  latestFrameAt: string | null;
  windowMinutes: number;
  clusters: LightningCluster[];
  /** Observed storms inside the scan range (set per scan; clusters cover a wider box). */
  inRangeCount?: number;
  message: Localized;
}

/** Everything the opportunity score needs except terrain, which is verified later per target. */
export interface CandidateScoreInput {
  capeJkg: number | null;
  convectiveInhibitionJkg?: number | null;
  liftedIndex?: number | null;
  precipitableWaterKgM2?: number | null;
  precipitationMm: number | null;
  thunderCode: boolean;
  lightningPotentialJkg?: number | null;
  observerCloudPercent: number | null;
  observerHighCloudPercent: number | null;
  visibilityM: number | null;
  atmosphereSource?: "observation" | "forecast";
  /** How many independent forecasts gave the observer's total cloud, and how far apart they were. */
  observerCloudSources?: number;
  observerCloudSpread?: number | null;
  /** Forecast cloud in the layer the line of sight crosses 40–90 km towards the target. */
  pathCloudPercent?: number | null;
  distanceKm: number;
  sunAltitudeDeg: number;
  moonInterference: boolean;
  /** "not_detected": MTG-LI was checked for the valid time and saw no lightning near the target. */
  lightning: "observed" | "not_detected" | "unavailable" | "not_configured";
  observedLightning?: ObservedLightning | null;
}

export type TerrainStatus = "clear" | "partial" | "blocked" | "unknown";

export interface StormCandidate {
  id: string;
  coordinates: Coordinates;
  forecastValidAt: string;
  distanceKm: number;
  bearingDeg: number;
  uncertaintyKm: number;
  capeJkg: number | null;
  convectiveInhibitionJkg: number | null;
  liftedIndex: number | null;
  precipitableWaterKgM2: number | null;
  precipitationMm: number | null;
  weatherCode: number | null;
  lightningPotentialJkg: number | null;
  highCloudPercent: number | null;
  windSpeedKmh: number | null;
  windDirectionDeg: number | null;
  pointing: PointingAltitude[];
  score: ScoreBreakdown;
  scoreInput: CandidateScoreInput;
  source: "forecast" | "observed";
  observedLightning?: ObservedLightning | null;
  provenance: Provenance;
}

export interface ProviderHealth {
  id: "open_meteo" | "open_meteo_lpi" | "mtg_li" | "air_quality" | "aviation_weather" | "meteoalarm" | "rainviewer" | "xweather" | "weatherapi" | "openweather" | "terrain";
  label: Localized;
  status: DataStatus;
  checkedAt: string;
  message: Localized;
}

export interface AuroraResponse {
  status: DataStatus;
  retrievedAt: string;
  observationTime: string | null;
  forecastTime: string | null;
  kp: number | null;
  localProbabilityPercent: number | null;
  northernSectorProbabilityPercent: number | null;
  level: "quiet" | "elevated" | "possible" | "strong" | "unknown";
  message: Localized;
}

export interface EumetsatMetadata {
  status: DataStatus;
  retrievedAt: string;
  lightningTime: string | null;
  infraredTime: string | null;
  cloudTopTime: string | null;
  kIndexTime: string | null;
  liftedIndexTime: string | null;
  message: Localized;
}

export interface AviationObservation {
  status: DataStatus;
  stationId: string | null;
  stationName: string | null;
  distanceKm: number | null;
  observedAt: string | null;
  retrievedAt: string;
  visibilityM: number | null;
  /** The report gives only a minimum (9999, CAVOK, "6+" miles): visibility is this or more. */
  visibilityAtLeast: boolean;
  cloudCoverPercent: number | null;
  cloudSummary: Localized | null;
  windDirectionDeg: number | null;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  temperatureC: number | null;
  dewPointC: number | null;
  /** Sea-level pressure (QNH), hPa. */
  pressureHpa: number | null;
  weather: string | null;
  flightCategory: string | null;
  rawMetar: string | null;
  rawTaf: string | null;
  tafValidFrom: string | null;
  tafValidTo: string | null;
  message: Localized;
}

export type AlertLevel = "green" | "yellow" | "orange" | "red";

export interface WeatherAlert {
  id: string;
  area: string;
  event: string;
  severity: string;
  /** The hazard as MeteoAlarm names it ("Thunderstorm", "Rain", …), when given. */
  hazard: string | null;
  /** The MeteoAlarm colour, from the warning text or else its severity. */
  level: AlertLevel | null;
  onset: string | null;
  expires: string | null;
  distanceKm: number | null;
  link: string;
}

export interface WeatherAlertResponse {
  status: DataStatus;
  retrievedAt: string;
  updatedAt: string | null;
  totalCount: number;
  nearbyCount: number;
  alerts: WeatherAlert[];
  message: Localized;
}

export interface OpportunityResponse {
  observer: Coordinates;
  fetchedAt: string;
  observerForecast: WeatherHour[];
  airQuality: AirQualityHour[];
  aviation: AviationObservation;
  weatherAlerts: WeatherAlertResponse;
  lightning?: LightningObservation;
  candidates: StormCandidate[];
  providers: ProviderHealth[];
  warnings: Localized[];
}

export interface TerrainSample {
  distanceKm: number;
  latitude: number;
  longitude: number;
  elevationM: number | null;
  apparentElevationDeg: number | null;
}

export interface TerrainProfile {
  status: DataStatus;
  provider: string;
  bearingDeg: number;
  observerElevationM: number | null;
  horizonAngleDeg: number | null;
  samples: TerrainSample[];
  retrievedAt: string;
  message: Localized;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  target: string;
  tleType: string;
  lens: string;
  iso: number;
  aperture: number;
  shutter: string;
  success: "yes" | "no" | "uncertain";
  notes: string;
}

export interface SavedLocation extends Coordinates {
  id: string;
  name: string;
  cameraHeightM: number;
  favorite: boolean;
  lightPollution: "low" | "medium" | "high" | "unknown";
  notes: string;
  safetyNotes: string;
}

export interface CameraProfile {
  id: string;
  name: string;
  sensorWidthMm: number;
  sensorHeightMm: number;
  mount: string;
  cropFactor: number;
}

export interface LensProfile {
  id: string;
  name: string;
  focalLengthMm: number;
  minFocalLengthMm?: number;
  maxFocalLengthMm?: number;
  maxAperture: number;
  maxApertureTele?: number;
  mount: string;
  owned: boolean;
}
