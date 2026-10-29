import { describe, expect, it } from "vitest";
import { CHAPTERS, chapterIndex } from "../src/story/chapters";
import { clockAt, formatClock } from "../src/story/clock";
import { FADE_HALF, plan } from "../src/story/director";

describe("director", () => {
  it("shows one scene mid-chapter", () => {
    const i = chapterIndex("dns");
    const s = plan(i + 0.5, []);
    expect(s.slots).toHaveLength(1);
    expect(s.slots[0]?.scene).toBe("globe");
    expect(s.slots[0]?.weight).toBe(1);
  });

  it("crossfades where the scene changes, weights summing to 1", () => {
    const i = chapterIndex("dns"); // globe, followed by packet on the machine
    for (const d of [-FADE_HALF * 0.9, -0.05, 0, 0.05, FADE_HALF * 0.9]) {
      const s = plan(i + 1 + d, []);
      expect(s.slots.map((x) => x.scene)).toEqual(["globe", "machine"]);
      const [a, b] = s.slots;
      expect((a?.weight ?? 0) + (b?.weight ?? 0)).toBeCloseTo(1);
    }
    expect(plan(i + 1 - FADE_HALF * 0.5, [])?.slots[0]?.weight).toBeGreaterThan(0.5);
    expect(plan(i + 1 + FADE_HALF * 0.5, [])?.slots[1]?.weight).toBeGreaterThan(0.5);
  });

  it("doesn't crossfade between consecutive chapters on the same scene", () => {
    const i = chapterIndex("enter"); // enter → shell, both on the machine
    expect(CHAPTERS[i + 1]?.scene).toBe(CHAPTERS[i]?.scene);
    const s = plan(i + 1 - 0.01, []);
    expect(s.slots).toHaveLength(1);
    // ...and the scene's own timeline is continuous across the boundary.
    const before = plan(i + 1 - 1e-4, []).slots[0]?.local ?? 0;
    const after = plan(i + 1 + 1e-4, []).slots[0]?.local ?? 0;
    expect(after - before).toBeLessThan(0.01);
  });
});

describe("clock", () => {
  it("runs linearly by default and slow-then-fast with an ease", () => {
    expect(clockAt([0, 10], 0.5)).toBeCloseTo(5);
    expect(clockAt([14, 600], 0.5, 3)).toBeCloseTo(14 + 586 / 8);
    expect(clockAt([0, 1], 2)).toBe(1);
  });

  it("formats Act I in milliseconds and Act II from ms to minutes", () => {
    expect(formatClock(0.0381, "ping")).toBe("38.100 ms");
    expect(formatClock(0.07, "claude")).toBe("70.0 ms");
    expect(formatClock(12.4, "claude")).toBe("12.40 s");
    expect(formatClock(441, "claude")).toBe("7 min 21 s");
  });
});
