/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAPTERS } from "../src/story/chapters";
import { beatOf, type SectionBox, storyPosition } from "../src/story/layout";

const content = ["intro", "act1", "act2", "outro"].map((f) => readFileSync(`content/${f}.html`, "utf8")).join("\n");
const sections = [...content.matchAll(/<section[^>]*data-chapter="([\w-]+)"[^>]*>([\s\S]*?)<\/section>/g)].map((m) => ({
  id: m[1] as string,
  cards: (m[2]?.match(/class="card[\s"]/g) ?? []).length,
}));

// "### dns (globe) · 4 cards" headers in the storyboard.
const storyboard = readFileSync("docs/storyboard.md", "utf8");
const planned = new Map(
  [...storyboard.matchAll(/^##+ (\w+) \((\w+)\) · (\d+) cards?/gm)].map((m) => [
    (m[1] as string).toLowerCase(),
    { scene: m[2] as string, cards: Number(m[3]) },
  ]),
);

describe("story", () => {
  it("has one section per chapter, in order", () => {
    expect(sections.map((s) => s.id)).toEqual(CHAPTERS.map((c) => c.id));
  });

  it("matches the storyboard's scenes and card counts", () => {
    for (const c of CHAPTERS) {
      const plan = planned.get(c.id);
      expect(plan, `storyboard entry for ${c.id}`).toBeDefined();
      expect(plan?.scene, c.id).toBe(c.scene);
      expect(sections.find((s) => s.id === c.id)?.cards, `cards in ${c.id}`).toBe(plan?.cards);
    }
  });

  it("runs each act's clock forward without gaps", () => {
    for (const act of ["ping", "claude"] as const) {
      const clocks = CHAPTERS.filter((c) => c.act === act && c.clock).map((c) => c.clock as [number, number]);
      for (let i = 0; i < clocks.length; i++) {
        const [a, b] = clocks[i] as [number, number];
        expect(b).toBeGreaterThan(a);
        if (i > 0) expect(a).toBeCloseTo((clocks[i - 1] as [number, number])[1], 9);
      }
    }
  });
});

describe("layout", () => {
  it("maps card centres to whole beats", () => {
    const cards = [0.2, 0.5, 0.8];
    expect(beatOf(0, cards)).toBe(-0.5);
    expect(beatOf(0.2, cards)).toBeCloseTo(0);
    expect(beatOf(0.5, cards)).toBeCloseTo(1);
    expect(beatOf(0.8, cards)).toBeCloseTo(2);
    expect(beatOf(1, cards)).toBe(2.5);
    expect(beatOf(0.35, cards)).toBeCloseTo(0.5);
    expect(beatOf(0.4, [])).toBe(0.4);
  });

  it("measures story position at the reading line", () => {
    const s: SectionBox[] = [
      { id: "a", top: 0, height: 1000, cards: [] },
      { id: "b", top: 1000, height: 2000, cards: [] },
    ];
    // Reading line at half of an 800 px viewport.
    expect(storyPosition(s, 0, 800)).toBeCloseTo(0.4);
    expect(storyPosition(s, 600, 800)).toBeCloseTo(1);
    expect(storyPosition(s, 1600, 800)).toBeCloseTo(1.5);
    expect(storyPosition(s, 99999, 800)).toBe(2);
  });
});
