import * as SunCalc from "suncalc";
import { angularDifference } from "@/lib/geodesy";

// SunCalc adds the horizon refraction (Meeus 16.4 at 0°, ≈0.484°) to every altitude below the
// horizon. Twilight is defined on the Sun's true altitude, so it is taken off again there;
// otherwise each twilight stage started 2.5–4 minutes late.
const HORIZON_REFRACTION_DEG = (0.0002967 / Math.tan(0.00312536 / 0.08901179)) * (180 / Math.PI);
const trueSunAltitude = (apparentDeg: number) => (apparentDeg < HORIZON_REFRACTION_DEG ? apparentDeg - HORIZON_REFRACTION_DEG : apparentDeg);

/** The Sun's altitude for twilight: true below the horizon, apparent above it. */
export function sunAltitudeDeg(date: Date, latitude: number, longitude: number) {
  return trueSunAltitude(SunCalc.getPosition(date, latitude, longitude).altitude);
}

export function skyState(date: Date, latitude: number, longitude: number, targetBearingDeg?: number) {
  const position = SunCalc.getPosition(date, latitude, longitude);
  const sun = { ...position, altitude: trueSunAltitude(position.altitude) };
  const moon = SunCalc.getMoonPosition(date, latitude, longitude);
  const illumination = SunCalc.getMoonIllumination(date);
  const moonSeparationDeg = targetBearingDeg == null ? null : angularDifference(moon.azimuth, targetBearingDeg);
  return {
    sunAltitudeDeg: sun.altitude,
    sunAzimuthDeg: sun.azimuth,
    moonAltitudeDeg: moon.altitude,
    moonAzimuthDeg: moon.azimuth,
    moonIllumination: illumination.fraction,
    moonSeparationDeg,
    astronomicalDarkness: sun.altitude <= -18,
    moonInterference:
      moon.altitude > 0 && illumination.fraction > 0.55 && moonSeparationDeg != null && moonSeparationDeg < 45,
  };
}

export function darknessScore(sunAltitudeDeg: number, moonInterference: boolean) {
  if (sunAltitudeDeg > -6) return 0;
  const twilightScore = sunAltitudeDeg <= -18 ? 5 : sunAltitudeDeg <= -12 ? 3.5 : 2;
  return Math.max(0, twilightScore - (moonInterference ? 1.5 : 0));
}

