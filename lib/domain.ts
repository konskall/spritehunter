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
  weatherCode: number | null;
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
  reasons: string[];
  limitations: string[];
}

export interface StormCandidate {
  id: string;
  coordinates: Coordinates;
  forecastValidAt: string;
  distanceKm: number;
  bearingDeg: number;
  uncertaintyKm: number;
  capeJkg: number | null;
  precipitationMm: number | null;
  weatherCode: number | null;
  highCloudPercent: number | null;
  windSpeedKmh: number | null;
  windDirectionDeg: number | null;
  pointing: PointingAltitude[];
  score: ScoreBreakdown;
  source: "forecast" | "observed";
  provenance: Provenance;
}

export interface ProviderHealth {
  id: "open_meteo" | "air_quality" | "rainviewer" | "xweather" | "terrain";
  label: string;
  status: DataStatus;
  checkedAt: string;
  message: string;
}

export interface OpportunityResponse {
  observer: Coordinates;
  fetchedAt: string;
  observerForecast: WeatherHour[];
  airQuality: AirQualityHour[];
  candidates: StormCandidate[];
  providers: ProviderHealth[];
  warnings: string[];
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
  message: string;
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
  maxAperture: number;
  mount: string;
  owned: boolean;
}

