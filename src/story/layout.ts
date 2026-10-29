// Where each chapter sits on the page, and how the scroll position maps onto the story.

export interface SectionBox {
  id: string;
  /** Document px. */
  top: number;
  height: number;
  /** Centres of the section's text cards, as fractions of its height (sorted). */
  cards: number[];
}

/** Read section and card geometry from the DOM (call on load and resize). */
export function measure(root: HTMLElement): SectionBox[] {
  const out: SectionBox[] = [];
  const scrollY = window.scrollY;
  for (const el of root.querySelectorAll<HTMLElement>("section[data-chapter]")) {
    const r = el.getBoundingClientRect();
    const top = r.top + scrollY;
    const height = Math.max(1, r.height);
    const cards: number[] = [];
    for (const c of el.querySelectorAll<HTMLElement>(":scope > .card")) {
      const cr = c.getBoundingClientRect();
      cards.push((cr.top + scrollY + cr.height / 2 - top) / height);
    }
    cards.sort((a, b) => a - b);
    out.push({ id: el.dataset.chapter as string, top, height, cards });
  }
  return out;
}

/**
 * The reading line: a point this far down the viewport is "now". Halfway on desktop, where the text
 * sits beside the picture; lower on phones, so the card being read sits under the picture, not on it.
 */
export const READING_LINE = 0.5;
export const READING_LINE_NARROW = 0.72;

/** The wide layout (text beside the picture) needs room on both sides; everything else stacks. */
export const isWide = (w: number, h: number): boolean => w >= 900 && w / Math.max(1, h) > 1.05;

/** Where the reading line sits for a viewport of this size. */
export const readingLineFor = (w: number, h: number): number => (isWide(w, h) ? READING_LINE : READING_LINE_NARROW);

/**
 * Story position for a scroll offset: section index + progress through it (0..1), measured where the
 * reading line crosses the page. Clamped to [0, sections].
 */
export function storyPosition(
  sections: readonly SectionBox[],
  scrollY: number,
  viewportH: number,
  line = READING_LINE,
): number {
  if (sections.length === 0) return 0;
  const y = scrollY + viewportH * line;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i] as SectionBox;
    if (y < s.top + s.height || i === sections.length - 1) {
      const p = (y - s.top) / s.height;
      return i + Math.min(1, Math.max(0, p));
    }
  }
  return sections.length;
}

/** The scroll offset that puts the reading line at progress p of section i. */
export function scrollFor(
  sections: readonly SectionBox[],
  i: number,
  p: number,
  viewportH: number,
  line = READING_LINE,
): number {
  const s = sections[Math.max(0, Math.min(sections.length - 1, i))];
  if (!s) return 0;
  return s.top + s.height * p - viewportH * line;
}

/**
 * Progress in card units: card k's centre maps to k, the section's top edge to -0.5 and its bottom
 * edge to (cards - 0.5). Without cards it's just p.
 */
export function beatOf(p: number, cards: readonly number[]): number {
  const n = cards.length;
  if (n === 0) return p;
  const xs = [0, ...cards, 1];
  const ys = [-0.5, ...cards.map((_, k) => k), n - 0.5];
  if (p <= 0) return -0.5;
  if (p >= 1) return n - 0.5;
  for (let i = 1; i < xs.length; i++) {
    const x1 = xs[i] as number;
    if (p <= x1) {
      const x0 = xs[i - 1] as number;
      const y0 = ys[i - 1] as number;
      const y1 = ys[i] as number;
      return x1 > x0 ? y0 + ((p - x0) / (x1 - x0)) * (y1 - y0) : y1;
    }
  }
  return n - 0.5;
}
