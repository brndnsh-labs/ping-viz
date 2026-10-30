import { describe, expect, it } from "vitest";
import { CHAPTERS } from "../src/story/chapters";
import { FLIGHTS, flightCurves } from "../src/story/flights";

describe("FLIGHTS", () => {
  it("only names real scene changes", () => {
    for (const key of Object.keys(FLIGHTS)) {
      const [from, to] = key.split(">");
      const i = CHAPTERS.findIndex((c) => c.id === from);
      expect(i, key).toBeGreaterThanOrEqual(0);
      expect(CHAPTERS[i + 1]?.id, key).toBe(to);
      expect(CHAPTERS[i + 1]?.scene, key).not.toBe(CHAPTERS[i]?.scene);
    }
  });
});

describe("flightCurves", () => {
  it("starts and ends on each scene's own pose", () => {
    expect(flightCurves(0)).toEqual({ out: 0, in: 1, weight: 0 });
    expect(flightCurves(1)).toEqual({ out: 1, in: 0, weight: 1 });
  });

  it("cuts when both cameras are fully zoomed in", () => {
    const c = flightCurves(0.5);
    expect(c.out).toBe(1);
    expect(c.in).toBe(1);
    expect(c.weight).toBeCloseTo(0.5);
  });

  it("zooms at the same speed on both sides of the cut", () => {
    const h = 1e-4;
    const outSpeed = (flightCurves(0.5).out - flightCurves(0.5 - h).out) / h;
    const inSpeed = (flightCurves(0.5).in - flightCurves(0.5 + h).in) / h;
    expect(inSpeed).toBeCloseTo(outSpeed, 2);
  });
});
