import type { Coordinates, PointingAltitude } from "@/lib/domain";

const WGS84_A = 6_378_137;
const WGS84_F = 1 / 298.257_223_563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const MEAN_EARTH_RADIUS_M = 6_371_008.8;

const toRad = (degrees: number) => (degrees * Math.PI) / 180;
const toDeg = (radians: number) => (radians * 180) / Math.PI;
export const normalizeDegrees = (value: number) => ((value % 360) + 360) % 360;

export interface EcefPoint {
  x: number;
  y: number;
  z: number;
}

export interface EnuPoint {
  east: number;
  north: number;
  up: number;
}

export function geodeticToEcef(point: Coordinates): EcefPoint {
  const lat = toRad(point.latitude);
  const lon = toRad(point.longitude);
  const altitude = point.elevationM ?? 0;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

  return {
    x: (n + altitude) * cosLat * Math.cos(lon),
    y: (n + altitude) * cosLat * Math.sin(lon),
    z: (n * (1 - WGS84_E2) + altitude) * sinLat,
  };
}

export function ecefDeltaToEnu(delta: EcefPoint, observer: Coordinates): EnuPoint {
  const lat = toRad(observer.latitude);
  const lon = toRad(observer.longitude);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  return {
    east: -sinLon * delta.x + cosLon * delta.y,
    north:
      -sinLat * cosLon * delta.x - sinLat * sinLon * delta.y + cosLat * delta.z,
    up: cosLat * cosLon * delta.x + cosLat * sinLon * delta.y + sinLat * delta.z,
  };
}

export function inverseGeodesic(a: Coordinates, b: Coordinates) {
  const phi1 = toRad(a.latitude);
  const phi2 = toRad(b.latitude);
  const l = toRad(b.longitude - a.longitude);
  const u1 = Math.atan((1 - WGS84_F) * Math.tan(phi1));
  const u2 = Math.atan((1 - WGS84_F) * Math.tan(phi2));
  const [sinU1, cosU1, sinU2, cosU2] = [Math.sin(u1), Math.cos(u1), Math.sin(u2), Math.cos(u2)];
  let lambda = l;
  let previous = Number.POSITIVE_INFINITY;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let sinAlpha = 0;
  let cosSqAlpha = 0;
  let cos2SigmaM = 0;

  for (let i = 0; i < 100 && Math.abs(lambda - previous) > 1e-12; i += 1) {
    previous = lambda;
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 +
        (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2,
    );
    if (sinSigma === 0) return { distanceM: 0, initialBearingDeg: 0 };
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const c = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    lambda =
      l +
      (1 - c) *
        WGS84_F *
        sinAlpha *
        (sigma +
          c *
            sinSigma *
            (cos2SigmaM + c * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  }

  if (!Number.isFinite(lambda) || Math.abs(lambda - previous) > 1e-9) {
    return sphericalInverse(a, b);
  }

  const uSq = (cosSqAlpha * (WGS84_A ** 2 - WGS84_B ** 2)) / WGS84_B ** 2;
  const bigA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const bigB = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    bigB *
    sinSigma *
    (cos2SigmaM +
      (bigB / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
          (bigB / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma ** 2) *
            (-3 + 4 * cos2SigmaM ** 2)));
  const distanceM = WGS84_B * bigA * (sigma - deltaSigma);
  const bearing = Math.atan2(
    cosU2 * Math.sin(lambda),
    cosU1 * sinU2 - sinU1 * cosU2 * Math.cos(lambda),
  );

  return { distanceM, initialBearingDeg: normalizeDegrees(toDeg(bearing)) };
}

function sphericalInverse(a: Coordinates, b: Coordinates) {
  const phi1 = toRad(a.latitude);
  const phi2 = toRad(b.latitude);
  const dPhi = phi2 - phi1;
  const dLambda = toRad(b.longitude - a.longitude);
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const distanceM = 2 * MEAN_EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  const bearing = Math.atan2(
    Math.sin(dLambda) * Math.cos(phi2),
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda),
  );
  return { distanceM, initialBearingDeg: normalizeDegrees(toDeg(bearing)) };
}

export function destinationPoint(origin: Coordinates, distanceKm: number, bearingDeg: number): Coordinates {
  const distanceM = distanceKm * 1000;
  const alpha1 = toRad(bearingDeg);
  const phi1 = toRad(origin.latitude);
  const lambda1 = toRad(origin.longitude);
  const tanU1 = (1 - WGS84_F) * Math.tan(phi1);
  const cosU1 = 1 / Math.sqrt(1 + tanU1 ** 2);
  const sinU1 = tanU1 * cosU1;
  const sigma1 = Math.atan2(tanU1, Math.cos(alpha1));
  const sinAlpha = cosU1 * Math.sin(alpha1);
  const cosSqAlpha = 1 - sinAlpha ** 2;
  const uSq = (cosSqAlpha * (WGS84_A ** 2 - WGS84_B ** 2)) / WGS84_B ** 2;
  const bigA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const bigB = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  let sigma = distanceM / (WGS84_B * bigA);
  let previous = Number.POSITIVE_INFINITY;
  let cos2SigmaM = 0;
  let sinSigma = 0;
  let cosSigma = 0;

  for (let i = 0; i < 100 && Math.abs(sigma - previous) > 1e-12; i += 1) {
    previous = sigma;
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    const deltaSigma =
      bigB *
      sinSigma *
      (cos2SigmaM +
        (bigB / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
            (bigB / 6) *
              cos2SigmaM *
              (-3 + 4 * sinSigma ** 2) *
              (-3 + 4 * cos2SigmaM ** 2)));
    sigma = distanceM / (WGS84_B * bigA) + deltaSigma;
  }

  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * Math.cos(alpha1);
  const phi2 = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * Math.cos(alpha1),
    (1 - WGS84_F) * Math.sqrt(sinAlpha ** 2 + tmp ** 2),
  );
  const lambda = Math.atan2(
    sinSigma * Math.sin(alpha1),
    cosU1 * cosSigma - sinU1 * sinSigma * Math.cos(alpha1),
  );
  const c = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
  const l =
    lambda -
    (1 - c) *
      WGS84_F *
      sinAlpha *
      (sigma +
        c *
          sinSigma *
          (cos2SigmaM + c * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  const lambda2 = lambda1 + l;

  return { latitude: toDeg(phi2), longitude: ((toDeg(lambda2) + 540) % 360) - 180 };
}

export function lookAngles(observer: Coordinates, target: Coordinates) {
  const observerEcef = geodeticToEcef(observer);
  const targetEcef = geodeticToEcef(target);
  const enu = ecefDeltaToEnu(
    {
      x: targetEcef.x - observerEcef.x,
      y: targetEcef.y - observerEcef.y,
      z: targetEcef.z - observerEcef.z,
    },
    observer,
  );
  const horizontal = Math.hypot(enu.east, enu.north);
  return {
    azimuthDeg: normalizeDegrees(toDeg(Math.atan2(enu.east, enu.north))),
    elevationDeg: toDeg(Math.atan2(enu.up, horizontal)),
    slantRangeKm: Math.hypot(horizontal, enu.up) / 1000,
  };
}

export function altitudeEnvelope(
  observer: Coordinates,
  target: Coordinates,
  altitudesKm = [50, 60, 70, 80, 90],
): PointingAltitude[] {
  return altitudesKm.map((altitudeKm) => {
    const angles = lookAngles(observer, { ...target, elevationM: altitudeKm * 1000 });
    return { altitudeKm, elevationDeg: angles.elevationDeg, slantRangeKm: angles.slantRangeKm };
  });
}

export function apparentTerrainAngle(
  observerElevationM: number,
  terrainElevationM: number,
  distanceKm: number,
) {
  if (distanceKm <= 0) return -90;
  const curvatureDrop = ((distanceKm * 1000) ** 2) / (2 * MEAN_EARTH_RADIUS_M);
  return toDeg(
    Math.atan2(terrainElevationM - observerElevationM - curvatureDrop, distanceKm * 1000),
  );
}

export function angularDifference(a: number, b: number) {
  return Math.abs(((a - b + 540) % 360) - 180);
}
