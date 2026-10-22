// Axis bounds for the small hourly charts: three ticks (bottom, middle, top) on round values,
// so a reader sees 0 / 15 / 30 rather than 4 / 17 / 30.

const MULTIPLES = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** The smallest round step (1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten) of at least `raw`. */
function roundStep(raw: number) {
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  return MULTIPLES.find((multiple) => multiple * power >= raw * (1 - 1e-9))! * power;
}

/**
 * Bounds that hold `values` with two equal round steps between them. `min`/`max` pin an end (0 for
 * rain or CAPE); `minSpan` keeps flat data from filling the chart with noise.
 */
export function niceAxis(values: number[], { min: fixedMin, max: fixedMax, minSpan = 1 }: { min?: number; max?: number; minSpan?: number } = {}) {
  let low = fixedMin ?? (values.length ? Math.min(...values) : 0);
  let high = fixedMax ?? (values.length ? Math.max(...values) : low + minSpan);
  if (high - low < minSpan) {
    if (fixedMin != null) high = low + minSpan;
    else if (fixedMax != null) low = high - minSpan;
    else {
      const middle = (low + high) / 2;
      low = middle - minSpan / 2;
      high = middle + minSpan / 2;
    }
  }
  if (fixedMin != null && fixedMax != null) return { min: fixedMin, max: fixedMax, step: (fixedMax - fixedMin) / 2 };
  let step = roundStep((high - low) / 2);
  for (;;) {
    const min = fixedMin ?? Math.floor(low / step) * step;
    const max = min + 2 * step;
    if (max >= high - 1e-9) return { min, max, step };
    step = roundStep(step * 1.0001);
  }
}
