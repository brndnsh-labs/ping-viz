import { describe, expect, it } from "vitest";
import { ll } from "../src/geo/geo";
import { eyeOf, flyPose, pose } from "../src/render/camera";
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

describe("flyPose", () => {
  it("never puts the eye inside the globe when diving from a whole-planet view to a city", () => {
    const world = pose([0, 0, 0], 2.75, 100, 22, 40);
    const home = pose(ll(35.6, -82.55, 1), 0.024, -82.55, 15.6, 40);
    for (let i = 0; i <= 100; i++) {
      const r = Math.hypot(...eyeOf(flyPose(world, home, i / 100)));
      expect(r, `s=${i / 100}`).toBeGreaterThan(1);
    }
  });

  it("starts on the scene's pose and ends on the close-up", () => {
    const a = pose([1, 2, 3], 10, 0, 20, 40);
    const b = pose([4, 5, 6], 0.5, 30, 10, 40);
    for (const [i, v] of flyPose(a, b, 0).target.entries()) expect(v).toBeCloseTo(a.target[i] as number);
    for (const [i, v] of flyPose(a, b, 1).target.entries()) expect(v).toBeCloseTo(b.target[i] as number);
    expect(flyPose(a, b, 1).distance).toBeCloseTo(0.5);
  });
});
