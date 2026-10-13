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
  weather: string | null;
  flightCategory: string | null;
  rawMetar: string | null;
  rawTaf: string | null;
  tafValidFrom: string | null;
  tafValidTo: string | null;
  message: Localized;
}

export interface WeatherAlert {
  id: string;
  area: string;
  event: string;
  severity: string;
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
