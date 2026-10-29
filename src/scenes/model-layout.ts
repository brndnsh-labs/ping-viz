// The model scene's set: a stack of layers and the prompt as a row of token columns crossing them.
// Pure data and geometry (no GPU), so the scene file can stay about motion.
//
// x runs along the context (oldest tokens far left, newest right), y up through the layers, z is the
// depth of a layer (the token row sits at z = 0; other conversations' lanes sit behind it, -z).
import { C } from "../config";
import type { Rgb } from "../render/gfx";

/** Visual layers (real models have dozens). */
export const LAYERS = 28;
const DY = 0.2;
export const layerY = (l: number): number => l * DY;
export const Y_TOP = layerY(LAYERS - 1);
/** A column's input vector enters just below the first layer; its output leaves above the last. */
export const Y_IN = -0.3;
export const Y_OUT = Y_TOP + 0.22;

/** Spacing of individual tokens at the right end: your message and everything generated. */
export const S = 0.15;
/** x of the prompt's last token. */
export const X_LAST = 3.0;
/** Layer planes reach this far in front of / behind the token row. */
export const Z_FRONT = 1.35;
export const Z_BACK = -0.75;

/** Your message, as (approximate) tokens. */
export const MESSAGE = [
  "i",
  " have",
  " some",
  " extra",
  " quota",
  " this",
  " week",
  ",",
  " so",
  " i",
  "'m",
  " wondering",
  " if",
  " you",
  " feel",
  " like",
  " getting",
  " creative",
] as const;

/** The first words of the reply. */
export const REPLY = ["Love", " this", " prompt", "."] as const;

/** The next-token distribution shown at the top (illustrative numbers). */
export const CANDIDATES: readonly (readonly [string, number])[] = [
  ["Love", 0.38],
  ["This", 0.21],
  ["Great", 0.14],
  ["Oh", 0.06],
  ["I", 0.05],
];

/** Request order: tools, then the system prompt, then the messages (CLAUDE.md, history, yours). */
export type Section = "tools" | "system" | "memory" | "history" | "prompt";
export const SECTION_COLOR: Record<Section, Rgb> = {
  tools: C.tools,
  system: C.system,
  memory: C.memory,
  history: C.history,
  prompt: C.prompt,
};

export interface Column {
  x: number;
  /** 0: the dense band (the early context, compressed), 1: a sampled prefix column, 2: your message. */
  kind: 0 | 1 | 2;
  section: Section;
  color: Rgb;
  /** Brightness multiplier (the band fades out to the left). */
  fade: number;
}

/** Sampled prefix columns between the band and your message, and how they split into sections. */
const PREFIX: readonly (readonly [Section, number])[] = [
  ["tools", 18],
  ["system", 12],
  ["memory", 9],
  ["history", 25],
];
const PREFIX_N = PREFIX.reduce((s, [, n]) => s + n, 0);
/** Each prefix column steps left by a little less than the one before it (compression). */
const PREFIX_SHRINK = 0.98;
/** The band: many more columns, packed ever tighter, fading out (the rest of the tens of thousands). */
export const BAND = 140;
const BAND_SHRINK = 0.97;

function buildColumns(): Column[] {
  const msgX0 = X_LAST - (MESSAGE.length - 1) * S;
  // Right to left: prefix, then band.
  const xs: number[] = [];
  let x = msgX0;
  let sp = S;
  for (let c = 0; c < PREFIX_N; c++) {
    sp *= PREFIX_SHRINK;
    x -= sp;
    xs.push(x);
  }
  const bandXs: number[] = [];
  for (let b = 0; b < BAND; b++) {
    sp *= BAND_SHRINK;
    x -= sp;
    bandXs.push(x);
  }
  const out: Column[] = [];
  for (let b = BAND - 1; b >= 0; b--) {
    const fade = BAND_SHRINK ** (b * 1.25) * (1 - b / BAND);
    out.push({ x: bandXs[b] as number, kind: 0, section: "tools", color: C.tools, fade });
  }
  let k = PREFIX_N - 1;
  for (const [section, n] of PREFIX) {
    for (let i = 0; i < n; i++) {
      out.push({ x: xs[k] as number, kind: 1, section, color: SECTION_COLOR[section], fade: 1 });
      k--;
    }
  }
  for (let j = 0; j < MESSAGE.length; j++) {
    out.push({ x: msgX0 + j * S, kind: 2, section: "prompt", color: C.prompt, fade: 1 });
  }
  return out;
}

export const COLS: readonly Column[] = buildColumns();
/** Index of the first column of your message: everything before it is the cached prefix. */
export const FIRST_NEW = BAND + PREFIX_N;
export const X_MIN = (COLS[0] as Column).x;
export const colX = (c: number): number => (COLS[c] as Column).x;
/** Where the g-th generated token's column goes. */
export const genX = (g: number): number => X_LAST + (g + 1) * S;

// ---- deterministic randomness -----------------------------------------------------------------

/** Mulberry32: a seeded stream of numbers in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hash of two integers to [0, 1), for per-frame picks that must not change between frames. */
export function hash2(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x632be5ab) | 0, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The last column at or left of x (binary search over the prompt). */
export function colAtX(x: number): number {
  let lo = 0;
  let hi = COLS.length - 1;
  if (x <= X_MIN) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((COLS[mid] as Column).x <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---- attention ---------------------------------------------------------------------------------

/** One drawn attention link: query column `src` looks back at key column `dst` (dst < src). */
export interface Arc {
  src: number;
  dst: number;
  /** Attention weight, 0..1 (pseudo-random, heavy-tailed: a few strong links, many faint ones). */
  w: number;
  /** +1 leans back (away from the viewer), -1 forward. */
  side: number;
  /** Height jitter, so arcs of the same span don't all stack into one smooth dome. */
  lift: number;
}

/**
 * A key column for a query at x: mostly recent tokens, sometimes far back, now and then the very
 * start (models attend to the first tokens a lot). Picked in x so the compressed past isn't
 * over-sampled.
 */
export function pickKey(r: () => number, x: number, before: number): number {
  const u = r();
  let tx: number;
  if (u < 0.36)
    tx = x - S * (1 + Math.floor(r() * r() * 8)); // the last few tokens
  else if (u < 0.93)
    tx = x - (x - X_MIN) * r() ** 1.7; // anywhere, favouring recent
  else tx = X_MIN + r() * 0.25; // the very beginning
  return Math.min(before - 1, colAtX(tx));
}

function weight(r: () => number, near: boolean): number {
  const w = 0.12 + 0.88 * r() ** 2.6;
  return Math.min(1, near ? w * 1.35 : w);
}

/** Prefill arcs for one layer: `all` while the whole prompt computes, `fresh` from your message only. */
export function prefillArcs(layer: number): { all: Arc[]; fresh: Arc[] } {
  const r = rng(9001 + layer * 7919);
  const all: Arc[] = [];
  const fresh: Arc[] = [];
  // Queries spread along the whole row (every token computes), picked in x so the compressed past
  // gets its share too.
  for (let k = 0; k < 180; k++) {
    const src = Math.max(BAND - 12, colAtX(X_MIN + (X_LAST - X_MIN) * r() ** 0.85));
    const x = colX(src);
    const dst = pickKey(r, x, src);
    if (dst >= src) continue;
    all.push({ src, dst, w: weight(r, x - colX(dst) < S * 4), side: r() < 0.7 ? 1 : -1, lift: 0.6 + 0.8 * r() });
  }
  // Queries in your message: they look back at each other and into the whole prefix.
  for (let k = 0; k < 160; k++) {
    const src = FIRST_NEW + Math.floor(r() * MESSAGE.length);
    const x = colX(src);
    const dst = pickKey(r, x, src);
    if (dst >= src) continue;
    const a = { src, dst, w: weight(r, x - colX(dst) < S * 4), side: r() < 0.7 ? 1 : -1, lift: 0.6 + 0.8 * r() };
    if (k % 3 === 0) all.push(a);
    fresh.push(a);
  }
  return { all, fresh };
}

// ---- decode ------------------------------------------------------------------------------------

/**
 * One decode step: token g's column fills as the token drops in (t0 → t1), then one pass rises
 * through every layer (t1 → t2), which produces the next token at the top. Times are beats.
 */
export interface Step {
  g: number;
  t0: number;
  t1: number;
  t2: number;
  /** Where the token comes from: the bar chart (the first one) or the top of the previous column. */
  from: "chart" | "top";
  think: boolean;
  /** Text shown for it, if any. */
  text?: string;
  /** Other conversations step with this one (batching). */
  lockstep: boolean;
}

/** Love, this, prompt, then a few more in lockstep with other conversations. */
export const SEQ_A: readonly Step[] = (() => {
  const out: Step[] = [
    { g: 0, t0: 0.14, t1: 0.44, t2: 0.86, from: "chart", think: false, text: REPLY[0], lockstep: false },
    { g: 1, t0: 0.86, t1: 0.93, t2: 1.1, from: "top", think: false, text: REPLY[1], lockstep: false },
    { g: 2, t0: 1.1, t1: 1.15, t2: 1.28, from: "top", think: false, text: REPLY[2], lockstep: false },
    { g: 3, t0: 1.28, t1: 1.32, t2: 1.42, from: "top", think: false, text: REPLY[3], lockstep: false },
  ];
  // Batching: six steps, every conversation in the batch advancing together.
  for (let k = 0; k < 6; k++) {
    const t0 = 1.6 + k * 0.14;
    out.push({ g: 4 + k, t0, t1: t0 + 0.025, t2: t0 + 0.135, from: "top", think: false, lockstep: true });
  }
  return out;
})();

/** Rewound: the real order, thinking first (no text), then the reply, at a steady rhythm. */
export const THINK_N = 14;
const REPLY_N = 14;
export const REWIND: [number, number] = [2.45, 2.57];
export const SEQ_B: readonly Step[] = (() => {
  const out: Step[] = [];
  const n = THINK_N + REPLY_N;
  const t = 2.6;
  const dt = (3.2 - t) / n;
  for (let g = 0; g < n; g++) {
    const t0 = t + g * dt;
    const think = g < THINK_N;
    const text = think ? undefined : REPLY[g - THINK_N];
    out.push({ g, t0, t1: t0 + dt * 0.22, t2: t0 + dt, from: "top", think, text, lockstep: false });
  }
  return out;
})();

/** Other conversations in the batch: a lane each, behind yours. */
export const LANES = 8;
export const LANE_DZ = 0.62;
/** Columns drawn per lane (the recent end of its context). */
export const LANE_COLS = 36;
export const LANE_HUES: readonly Rgb[] = [
  [0.7, 0.55, 1.0],
  [0.24, 1.0, 0.7],
  [1.0, 0.62, 0.26],
  [0.2, 0.72, 1.0],
  [0.86, 0.32, 1.0],
  [0.95, 0.85, 0.35],
  [0.3, 0.52, 1.0],
  [1.0, 0.46, 0.6],
];
/** Each lane's newest column, relative to yours (conversations have different lengths). */
export const LANE_OFFSET: readonly number[] = [-0.9, 0.45, -2.1, -0.3, 0.9, -1.5, 0.15, -2.6];
