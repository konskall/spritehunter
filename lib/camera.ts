import type { CameraProfile, LensProfile } from "@/lib/domain";
import type { Language } from "@/lib/i18n";

const toDeg = (radians: number) => (radians * 180) / Math.PI;

export const CANON_750D: CameraProfile = {
  id: "canon-750d",
  name: "Canon EOS 750D",
  sensorWidthMm: 22.3,
  sensorHeightMm: 14.9,
  mount: "Canon EF/EF-S",
  cropFactor: 1.6,
};

export const DEFAULT_LENSES: LensProfile[] = [
  { id: "tokina-atxi-11-16", name: "Tokina atx-i 11–16mm F2.8 CF", focalLengthMm: 11, minFocalLengthMm: 11, maxFocalLengthMm: 16, maxAperture: 2.8, mount: "Canon EF/EF-S", owned: true },
  { id: "sigma-17-70-c013", name: "Sigma 17–70mm F2.8–4 DC Macro OS HSM Contemporary (013)", focalLengthMm: 17, minFocalLengthMm: 17, maxFocalLengthMm: 70, maxAperture: 2.8, maxApertureTele: 4, mount: "Canon EF/EF-S", owned: true },
  { id: "canon-efs-18-55-stm", name: "Canon EF-S 18–55mm F3.5–5.6 IS STM", focalLengthMm: 18, minFocalLengthMm: 18, maxFocalLengthMm: 55, maxAperture: 3.5, maxApertureTele: 5.6, mount: "Canon EF-S", owned: true },
  { id: "canon-efs-24-stm", name: "Canon EF-S 24mm F2.8 STM", focalLengthMm: 24, maxAperture: 2.8, mount: "Canon EF-S", owned: true },
  { id: "canon-ef-50-stm", name: "Canon EF 50mm F1.8 STM", focalLengthMm: 50, maxAperture: 1.8, mount: "Canon EF", owned: true },
  { id: "helios-44-2", name: "Helios 44-2 58mm F2", focalLengthMm: 58, maxAperture: 2, mount: "M42 → Canon EF (adapter)", owned: true },
  { id: "jupiter-21m", name: "Jupiter-21M 200mm F4", focalLengthMm: 200, maxAperture: 4, mount: "M42 → Canon EF (adapter)", owned: true },
  { id: "canon-efs-55-250-stm", name: "Canon EF-S 55–250mm F4–5.6 IS STM", focalLengthMm: 55, minFocalLengthMm: 55, maxFocalLengthMm: 250, maxAperture: 4, maxApertureTele: 5.6, mount: "Canon EF-S", owned: true },
];

export function effectiveMaxAperture(lens: LensProfile) {
  if (
    lens.minFocalLengthMm === undefined ||
    lens.maxFocalLengthMm === undefined ||
    lens.maxApertureTele === undefined ||
    lens.maxFocalLengthMm === lens.minFocalLengthMm
  ) return lens.maxAperture;

  const progress = Math.min(1, Math.max(0, (lens.focalLengthMm - lens.minFocalLengthMm) / (lens.maxFocalLengthMm - lens.minFocalLengthMm)));
  return Math.round((lens.maxAperture + (lens.maxApertureTele - lens.maxAperture) * progress) * 10) / 10;
}

export function fieldOfView(camera: CameraProfile, focalLengthMm: number, orientation: "landscape" | "portrait" = "landscape") {
  const width = orientation === "landscape" ? camera.sensorWidthMm : camera.sensorHeightMm;
  const height = orientation === "landscape" ? camera.sensorHeightMm : camera.sensorWidthMm;
  return {
    horizontalDeg: toDeg(2 * Math.atan(width / (2 * focalLengthMm))),
    verticalDeg: toDeg(2 * Math.atan(height / (2 * focalLengthMm))),
  };
}

export function framingAssessment(
  horizontalFovDeg: number,
  verticalFovDeg: number,
  horizontalTargetDeg: number,
  minElevationDeg: number,
  maxElevationDeg: number,
) {
  const verticalTargetDeg = Math.max(0, maxElevationDeg - minElevationDeg);
  return {
    fits: horizontalFovDeg >= horizontalTargetDeg * 1.15 && verticalFovDeg >= verticalTargetDeg * 1.15,
    horizontalMarginDeg: horizontalFovDeg - horizontalTargetDeg,
    verticalMarginDeg: verticalFovDeg - verticalTargetDeg,
  };
}

export function photoRecommendation(lens: LensProfile, moonInterference: boolean, uncertaintyDeg: number, language: Language = "el") {
  const narrow = lens.focalLengthMm >= 85;
  const aperture = effectiveMaxAperture(lens);
  const el = language === "el";
  return {
    preset: narrow
      ? (el ? "Στοχευμένη λήψη μακρινής καταιγίδας" : "Targeted shot of a distant storm")
      : (el ? "Ευρυγώνια αναζήτηση sprites" : "Wide-angle sprite search"),
    aperture: `f/${aperture}`,
    iso: moonInterference ? "ISO 1600–3200" : aperture <= 2 ? "ISO 1600–3200" : "ISO 3200–6400",
    shutter: moonInterference ? "1–2 s" : "2–4 s",
    whiteBalance: el ? "3.500–4.500 K" : "3,500–4,500 K",
    format: "RAW",
    interval: el ? "1 s ανάμεσα στα καρέ" : "1 s between frames",
    warning:
      narrow || uncertaintyDeg > 8
        ? (el ? "Το κάδρο είναι στενό για την αβεβαιότητα του στόχου· ξεκίνησε με μικρότερη εστιακή απόσταση." : "The frame is narrow for the target's uncertainty; start with a shorter focal length.")
        : (el ? "Το κάδρο καλύπτει την αρχική αναζήτηση· έλεγχε συχνά την κίνηση της καταιγίδας." : "The frame covers the initial search; check the storm's movement often."),
  };
}
