// Turns a story position into what to render: one scene, or two crossfading across a chapter
// boundary where the scene changes.
import type { SceneId } from "../scenes/scene";
import { smooth } from "../util/ease";
import { CHAPTERS, type ChapterDef } from "./chapters";
import { beatOf, type SectionBox } from "./layout";

/** Half-width of a scene crossfade, in chapters. */
export const FADE_HALF = 0.14;

export interface SlotPlan {
  scene: SceneId;
  chapter: ChapterDef;
  p: number;
  beat: number;
  cards: number;
  local: number;
  weight: number;
  /** Camera distance multiplier: the outgoing scene pushes in, the incoming one settles from further back. */
  dolly: number;
}

export interface StoryState {
  index: number;
  p: number;
  chapter: ChapterDef;
  slots: SlotPlan[];
}

/** For each chapter, how many earlier chapters share its scene (its index on the scene's timeline). */
const SCENE_ORDINAL: number[] = (() => {
  const seen = new Map<SceneId, number>();
  return CHAPTERS.map((c) => {
    const k = seen.get(c.scene) ?? 0;
    seen.set(c.scene, k + 1);
    return k;
  });
})();

function slot(i: number, s: number, sections: readonly SectionBox[], weight: number, dolly: number): SlotPlan {
  const chapter = CHAPTERS[i] as ChapterDef;
  const p = Math.min(1, Math.max(0, s - i));
  const cards = sections[i]?.cards ?? [];
  return {
    scene: chapter.scene,
    chapter,
    p,
    beat: beatOf(p, cards),
    cards: cards.length,
    local: (SCENE_ORDINAL[i] as number) + p,
    weight,
    dolly,
  };
}

export function plan(s: number, sections: readonly SectionBox[]): StoryState {
  const n = CHAPTERS.length;
  const sc = Math.min(n - 1e-6, Math.max(0, s));
  const i = Math.floor(sc);
  const p = sc - i;
  const cur = CHAPTERS[i] as ChapterDef;
  const next = CHAPTERS[i + 1];
  const prev = CHAPTERS[i - 1];

  let a = -1;
  let t = 0;
  if (p > 1 - FADE_HALF && next && next.scene !== cur.scene) {
    a = i;
    t = (p - (1 - FADE_HALF)) / (2 * FADE_HALF);
  } else if (p < FADE_HALF && prev && prev.scene !== cur.scene) {
    a = i - 1;
    t = 0.5 + p / (2 * FADE_HALF);
  }
  if (a < 0) {
    return { index: i, p, chapter: cur, slots: [slot(i, sc, sections, 1, 1)] };
  }
  const w = smooth(Math.min(1, Math.max(0, t)));
  return {
    index: i,
    p,
    chapter: cur,
    slots: [slot(a, sc, sections, 1 - w, 1 - 0.38 * w), slot(a + 1, sc, sections, w, 1 + 0.9 * (1 - w))],
  };
}
