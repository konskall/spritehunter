import * as SunCalc from "suncalc";
import { angularDifference } from "@/lib/geodesy";

export function skyState(date: Date, latitude: number, longitude: number, targetBearingDeg?: number) {
  const sun = SunCalc.getPosition(date, latitude, longitude);
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

