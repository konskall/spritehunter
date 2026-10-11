import type { CameraProfile, LensProfile } from "@/lib/domain";

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
  { id: "jupiter-21m", name: "Jupiter-21M 200mm f/4", focalLengthMm: 200, maxAperture: 4, mount: "M42 adapter", owned: true },
  { id: "generic-16", name: "Generic 16mm f/2", focalLengthMm: 16, maxAperture: 2, mount: "Canon EF/EF-S", owned: false },
  { id: "generic-24", name: "Generic 24mm f/1.4", focalLengthMm: 24, maxAperture: 1.4, mount: "Canon EF/EF-S", owned: false },
  { id: "sigma-18-35", name: "Sigma 18–35mm f/1.8 DC HSM", focalLengthMm: 24, maxAperture: 1.8, mount: "Canon EF", owned: false },
  { id: "generic-35", name: "Generic 35mm f/1.8", focalLengthMm: 35, maxAperture: 1.8, mount: "Canon EF/EF-S", owned: false },
  { id: "generic-50", name: "Generic 50mm f/1.8", focalLengthMm: 50, maxAperture: 1.8, mount: "Canon EF/EF-S", owned: false },
  { id: "generic-11-20", name: "Generic 11–20mm f/2.8", focalLengthMm: 16, maxAperture: 2.8, mount: "Canon EF-S", owned: false },
];

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

export function photoRecommendation(lens: LensProfile, moonInterference: boolean, uncertaintyDeg: number) {
  const narrow = lens.focalLengthMm >= 85;
  return {
    preset: narrow ? "Στοχευμένη λήψη μακρινής καταιγίδας" : "Ευρυγώνια αναζήτηση sprites",
    aperture: `f/${lens.maxAperture}`,
    iso: moonInterference ? "ISO 1600–3200" : lens.maxAperture <= 2 ? "ISO 1600–3200" : "ISO 3200–6400",
    shutter: moonInterference ? "1–2 s" : "2–4 s",
    whiteBalance: "3.500–4.500 K",
    format: "RAW",
    interval: "1 s ανάμεσα στα καρέ",
    warning:
      narrow || uncertaintyDeg > 8
        ? "Το κάδρο είναι στενό για την αβεβαιότητα του στόχου· ξεκίνησε με μικρότερη εστιακή απόσταση."
        : "Το κάδρο καλύπτει την αρχική αναζήτηση· έλεγχε συχνά την κίνηση της καταιγίδας.",
  };
}

