import { describe, expect, it } from "vitest";
import { niceAxis } from "@/lib/chart-axis";

describe("chart axes", () => {
  it("rounds an axis to steps people read at a glance", () => {
    // Values seen on the weather screen, with hand-picked results (min, middle and max ticks).
    expect(niceAxis([6.2, 27.4], { minSpan: 6 })).toEqual({ min: 0, max: 30, step: 15 });
    expect(niceAxis([1014.3, 1021.7], { minSpan: 6 })).toEqual({ min: 1014, max: 1026, step: 6 });
    expect(niceAxis([0, 970], { min: 0, minSpan: 500 })).toEqual({ min: 0, max: 1000, step: 500 });
    expect(niceAxis([0.2, 49], { min: 0, minSpan: 10 })).toEqual({ min: 0, max: 50, step: 25 });
  });

  it("keeps a minimum span for flat or empty data", () => {
    expect(niceAxis([0, 0.4], { min: 0, minSpan: 1 })).toEqual({ min: 0, max: 1, step: 0.5 });
    expect(niceAxis([24, 32], { min: 0, minSpan: 60 })).toEqual({ min: 0, max: 60, step: 30 });
    expect(niceAxis([], { min: 0, minSpan: 1 })).toEqual({ min: 0, max: 1, step: 0.5 });
  });
});
