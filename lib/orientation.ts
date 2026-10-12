const toRad = (degrees: number) => (degrees * Math.PI) / 180;
const toDeg = (radians: number) => (radians * 180) / Math.PI;

/**
 * Direction of the rear camera (device −Z axis) in the East-North-Up frame,
 * using the W3C DeviceOrientation Z-X'-Y'' Tait-Bryan angles. Valid in any
 * screen orientation; heading is clockwise from the alpha reference (north
 * for absolute events).
 */
export function cameraPointing(alphaDeg: number, betaDeg: number, gammaDeg: number) {
  const [a, b, g] = [toRad(alphaDeg), toRad(betaDeg), toRad(gammaDeg)];
  const east = -(Math.cos(a) * Math.sin(g) + Math.cos(g) * Math.sin(a) * Math.sin(b));
  const north = -(Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.cos(g) * Math.sin(b));
  const up = -Math.cos(b) * Math.cos(g);
  return {
    headingDeg: ((toDeg(Math.atan2(east, north)) % 360) + 360) % 360,
    elevationDeg: toDeg(Math.asin(Math.max(-1, Math.min(1, up)))),
  };
}
