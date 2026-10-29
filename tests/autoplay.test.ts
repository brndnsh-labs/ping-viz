import { describe, expect, it } from "vitest";
import {
  countWords,
  dwellSeconds,
  glideSeconds,
  nextStop,
  SETTLE_S,
  type Stop,
  stopFor,
  type Viewport,
  WORDS_PER_MINUTE,
} from "../src/ui/autoplay";

describe("autoplay pacing", () => {
  it("counts words, not punctuation or symbols", () => {
    expect(countWords("  The kernel's tty layer — sits\nbetween 2 ends. ")).toBe(8);
    expect(countWords("")).toBe(0);
    expect(countWords("— · ×")).toBe(0);
  });

  it("holds a card for its reading time plus the settle", () => {
    const words = WORDS_PER_MINUTE; // one minute at 1×
    expect(dwellSeconds({ words, bonus: 0, factor: 1 }, 1)).toBeCloseTo(60 + SETTLE_S);
    expect(dwellSeconds({ words, bonus: 0, factor: 1 }, 2)).toBeCloseTo(30 + SETTLE_S);
    expect(dwellSeconds({ words, bonus: 0, factor: 1 }, 0.75)).toBeCloseTo(80 + SETTLE_S);
  });

  it("adds slow-part bonuses and scales by data-dwell, but never the settle", () => {
    expect(dwellSeconds({ words: 0, bonus: 10, factor: 1 }, 1)).toBeCloseTo(10 + SETTLE_S);
    expect(dwellSeconds({ words: 90, bonus: 10, factor: 1.5 }, 1)).toBeCloseTo((30 + 10) * 1.5 + SETTLE_S);
    expect(dwellSeconds({ words: 90, bonus: 10, factor: 1.5 }, 2)).toBeCloseTo(((30 + 10) * 1.5) / 2 + SETTLE_S);
  });

  it("glides for longer over longer distances, within limits", () => {
    expect(glideSeconds(0, 800)).toBeCloseTo(1.2);
    expect(glideSeconds(800, 800)).toBeGreaterThan(glideSeconds(400, 800));
    expect(glideSeconds(-800, 800)).toBeCloseTo(glideSeconds(800, 800));
    expect(glideSeconds(100_000, 800)).toBeCloseTo(2.5);
  });
});

describe("autoplay stops", () => {
  const v: Viewport = { height: 800, line: 0.5, maxScroll: 10_000, insetTop: 80, insetBottom: 16 };

  it("puts a short card's centre on the reading line", () => {
    const s = stopFor(2000, 2200, v);
    expect(s.from).toBe(2100 - 400);
    expect(s.to).toBe(s.from);
  });

  it("nudges a card up when the reading line would cut off its bottom", () => {
    const s = stopFor(2000, 2600, { ...v, line: 0.72 }); // centred, its bottom (2600) would sit below the screen (1724 + 800)
    expect(s.from).toBe(2600 - (800 - 16));
    expect(2000 - s.from).toBeGreaterThanOrEqual(80); // top still clear of the HUD
  });

  it("pans a card taller than the screen from its top to its bottom", () => {
    const s = stopFor(2000, 3200, v);
    expect(s.from).toBe(2000 - 80);
    expect(s.to).toBe(3200 - (800 - 16));
  });

  it("stays within the page", () => {
    expect(stopFor(100, 200, v).from).toBe(0);
    expect(stopFor(9900, 10_400, { ...v, maxScroll: 9500 }).to).toBe(9500);
  });

  it("finds the next card at or after the reader", () => {
    const stops: Stop[] = [
      { from: 0, to: 0 },
      { from: 1000, to: 1000 },
      { from: 2000, to: 2600 },
      { from: 3500, to: 3500 },
    ];
    expect(nextStop(stops, 0, 50)).toBe(0);
    expect(nextStop(stops, 500, 50)).toBe(1);
    expect(nextStop(stops, 1030, 50)).toBe(1); // just past a card's centre: still on it
    expect(nextStop(stops, 1100, 50)).toBe(2);
    expect(nextStop(stops, 2300, 50)).toBe(2); // part way through a tall card
    expect(nextStop(stops, 3600, 50)).toBe(-1);
  });
});
