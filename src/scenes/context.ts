// The prompt chapter: what Claude Code actually sends, drawn as a wall of tokens.
//
// One glowing tile per token (~22,800 of them), laid out like wrapped text: left to right, bottom to
// top, coloured by section in the order the API renders them (tools, system prompt, CLAUDE.md and
// memory, environment, skills, then your message). The tiles live on the GPU (context-wall.wgsl): this
// file owns the timeline, the camera, the labels and the few guide lines, and hands the shader a
// handful of numbers per frame. Counts are illustrative, so every label says "≈".
//
// Beats (card units, see docs/storyboard.md):
//   b0  What gets sent       a JSON skeleton over an empty footprint; the first rows start to form
//   b1  Before your words    the wall builds, section by section, each labelled as it completes
//   b2  Your message         a thin bright sliver lands on top; the camera pulls back to show its size
//   b3  Marked for reuse     a cache breakpoint under the sliver, steel shimmer below it, then the
//                            wall is read out in order into ~70 packets that stream off to the right
import { C, CSS, mixRgb } from "../config";
import { type CameraPose, type PoseKey, pose, poseAt } from "../render/camera";
import type { Gfx, Rgb } from "../render/gfx";
import { LineBatch } from "../render/lines";
import { PointBatch } from "../render/points";
import { easeOut, ramp, seg, smooth, window as win } from "../util/ease";
import { DEG, type Vec3 } from "../util/math";
import wallSrc from "./context-wall.wgsl?raw";
import type { Label, Scene, SceneFactory, SceneFrame } from "./scene";

// ---- the request ---------------------------------------------------------------------------------

interface Section {
  /** Label on wide screens, and a shorter one for phones. */
  name: string;
  short: string;
  /** A second line on wide screens. */
  note?: string;
  /** Illustrative token count. */
  count: number;
  color: Rgb;
  css: string;
  /** Tile brightness. */
  gain: number;
}

const SKILLS: Rgb = mixRgb(C.system, [0.8, 0.55, 1.0], 0.45);

// In request order (code.claude.com/docs/en/prompt-caching): tool definitions and the system prompt,
// then project context (CLAUDE.md, memory), then the conversation, which opens with the environment
// (directory, platform, git status) and the skills list, ahead of your words.
const SECTIONS: readonly Section[] = [
  {
    name: "tools",
    short: "tools",
    note: "descriptions and JSON Schemas",
    count: 14000,
    color: C.tools,
    css: CSS.tools,
    gain: 0.62,
  },
  {
    name: "system prompt",
    short: "system",
    note: "how Claude Code works",
    count: 4000,
    color: C.system,
    css: CSS.system,
    gain: 0.5,
  },
  { name: "CLAUDE.md and memory", short: "memory", count: 2500, color: C.memory, css: CSS.memory, gain: 0.52 },
  {
    name: "environment",
    short: "env",
    note: "directory, platform, git status",
    count: 600,
    color: C.history,
    css: CSS.history,
    gain: 0.5,
  },
  { name: "skills and plugins", short: "skills", count: 1500, color: SKILLS, css: "#bfaeff", gain: 0.5 },
  { name: "your message", short: "message", count: 200, color: C.prompt, css: CSS.prompt, gain: 2.4 },
];

/** Index of the first token after each section. */
const ENDS: readonly number[] = (() => {
  const ends: number[] = [];
  let sum = 0;
  for (const s of SECTIONS) {
    sum += s.count;
    ends.push(sum);
  }
  return ends;
})();
const N = ENDS[ENDS.length - 1] as number;
const START = (s: number): number => (s === 0 ? 0 : (ENDS[s - 1] as number));
const BODY = SECTIONS.length - 1;

const fmt = (n: number): string => n.toLocaleString("en-US");

// The request leaves as ~100 KB in ~70 TCP segments (the next chapter), so the wall is read out, in
// order, into 70 packets. Times are in the stream's own progress units (0..1 over the last half beat).
const PACKETS = 70;
/** A packet is a block of tiles this many wide (the rest is its height). */
const PCOLS = 18;
const PROWS = Math.ceil(Math.ceil(N / PACKETS) / PCOLS);
/** Delay between one packet starting and the next. */
const STAG = 0.0117;
/** How long a packet takes to gather its tiles. */
const FORM = 0.07;
/** Scene units a packet travels per unit of progress. */
const SPEED = 30;
/** The lane the packets ride heads off to the right and away from the camera by this angle. */
const PHI = 22 * DEG;

// ---- layout --------------------------------------------------------------------------------------

/** Scene units between tile centres. */
const PITCH = 0.04;

interface Layout {
  cols: number;
  /** Wall size in scene units; x runs -w/2..w/2, y runs 0..h. */
  w: number;
  h: number;
  narrow: boolean;
}

/**
 * Wide screens get a tall tower (100 columns, a two-row sliver, room for labels beside it); phones a
 * wide slab (200 columns, a one-row sliver) that fits above the text.
 */
function layoutFor(narrow: boolean): Layout {
  const cols = narrow ? 200 : 100;
  const rows = Math.ceil(N / cols);
  return { cols, w: cols * PITCH, h: rows * PITCH, narrow };
}

/** Where packets are made: just past the wall's right edge, at its foot. */
const nozzleOf = (L: Layout): Vec3 => [L.w / 2 + 0.7, 0.07, 0];

/** How many (fractional) rows of the wall `tokens` tokens fill. */
const rowOf = (L: Layout, tokens: number): number => tokens / L.cols;

/**
 * Where each label sits, in rows from the base: near its band, fanned out where the bands are thin
 * (a leader line joins them). The breakpoint's label sits at the lid itself.
 */
const SLOTS = {
  wide: { sections: [70, 160, 186, 203, 216.5], breakpoint: 226.2, message: 238 },
  narrow: { sections: [35, 80, 93.5, 107, 121], breakpoint: 130.5, message: 147 },
} as const;

// ---- timeline ------------------------------------------------------------------------------------

/** [beat the section starts, beat it completes, tokens built by then]. Each pauses as it lands. */
const BUILD: readonly (readonly [number, number, number])[] = [
  [0.28, 0.86, ENDS[0] as number],
  [0.86, 1.06, ENDS[1] as number],
  [1.06, 1.23, ENDS[2] as number],
  [1.23, 1.3, ENDS[3] as number],
  [1.3, 1.43, ENDS[4] as number],
];

function tokensAt(b: number): number {
  let from = 0;
  for (const [a, z, to] of BUILD) {
    if (b <= a) return from;
    if (b < z) return from + (to - from) * smooth((b - a) / (z - a));
    from = to;
  }
  return from;
}

const SLIVER: [number, number] = [1.62, 1.95];
const FRAME: [number, number] = [2.3, 2.7];
const SHIMMER: [number, number] = [2.5, 2.9];
const STREAM: [number, number] = [3.0, 3.5];

// ---- camera --------------------------------------------------------------------------------------

interface Key {
  at: number;
  /** Look-at point: x in wall widths from the centre, y as a fraction of the wall's height. */
  x: number;
  y: number;
  /** Distance as a multiple of the one that fits the whole wall. */
  zoom: number;
  yaw: number;
  pitch: number;
}

/** Start close and slightly low, follow the build up and back, close on the sliver, pull back, then follow the stream. */
const KEYS_WIDE: readonly Key[] = [
  { at: -0.5, x: 0, y: 0.06, zoom: 0.62, yaw: -14, pitch: -10 },
  { at: 0.3, x: 0, y: 0.1, zoom: 0.55, yaw: -11, pitch: -9 },
  { at: 0.86, x: 0, y: 0.32, zoom: 0.92, yaw: -7, pitch: -4 },
  { at: 1.43, x: 0, y: 0.7, zoom: 0.92, yaw: -3, pitch: 0 },
  { at: 1.62, x: 0, y: 0.84, zoom: 0.55, yaw: -2, pitch: 1 },
  { at: 1.95, x: 0, y: 0.885, zoom: 0.33, yaw: 0, pitch: 2 },
  { at: 2.1, x: 0, y: 0.885, zoom: 0.33, yaw: 0, pitch: 2 },
  { at: 2.6, x: 0, y: 0.5, zoom: 1.0, yaw: 0, pitch: 0 },
  { at: 3.0, x: 0, y: 0.5, zoom: 1.03, yaw: 3, pitch: 0 },
  { at: 3.5, x: 0.9, y: 0.2, zoom: 1.3, yaw: -24, pitch: 3 },
];

const KEYS_NARROW: readonly Key[] = [
  { at: -0.5, x: 0, y: 0.3, zoom: 0.92, yaw: -12, pitch: -9 },
  { at: 0.3, x: 0, y: 0.35, zoom: 0.9, yaw: -10, pitch: -8 },
  { at: 0.86, x: 0, y: 0.5, zoom: 1.0, yaw: -6, pitch: -4 },
  { at: 1.43, x: 0, y: 0.5, zoom: 1.0, yaw: -3, pitch: 0 },
  { at: 1.62, x: 0, y: 0.7, zoom: 0.88, yaw: -2, pitch: 1 },
  { at: 1.95, x: 0, y: 0.88, zoom: 0.7, yaw: 0, pitch: 2 },
  { at: 2.1, x: 0, y: 0.88, zoom: 0.7, yaw: 0, pitch: 2 },
  { at: 2.6, x: 0, y: 0.5, zoom: 1.0, yaw: 0, pitch: 0 },
  { at: 3.0, x: 0, y: 0.5, zoom: 1.03, yaw: 3, pitch: 0 },
  { at: 3.5, x: 0.9, y: 0.2, zoom: 1.3, yaw: -24, pitch: 3 },
];

const TAN_HALF_FOV = Math.tan(20 * DEG);

/** Distance (scene units) at which the whole wall sits comfortably in the subject area. */
function fullDistance(L: Layout, f: SceneFrame): number {
  if (!L.narrow) {
    // The wall fills 70% of the height, less on cramped windows so the labels still fit beside it.
    const fit = Math.min(0.7, Math.max(0.5, (f.aspect - 1.05) / (L.w / L.h)));
    return L.h / (fit * 2 * TAN_HALF_FOV);
  }
  const byW = L.w / (0.62 * f.aspect * 2 * TAN_HALF_FOV);
  const byH = L.h / (0.3 * 2 * TAN_HALF_FOV);
  return Math.max(byW, byH);
}

/**
 * Where the wall's right edge sits relative to the lens centre, in viewport heights (+x right). The
 * labels live to its right, so the edge stays put as the camera zooms: closer shots crop the wall's
 * left side (behind the text) instead of pushing the labels off screen.
 */
function edgeOffset(L: Layout, f: SceneFrame, fullVisH: number): number {
  if (L.narrow) return 0.16 * f.aspect;
  // At full zoom the wall's left edge clears the text card (about 0.68 viewport heights wide).
  return Math.max(-0.005, 0.7 + L.w / fullVisH - 0.65 * f.aspect);
}

/** Vertical placement of the subject relative to the lens centre, in viewport heights (+y up). */
const liftOffset = (f: SceneFrame): number => (!f.narrow ? -0.03 : f.aspect < 0.9 ? 0.11 : 0.06);

// ---- guide lines ---------------------------------------------------------------------------------

/** The first `frac` of a polyline's length, ending exactly at that point. */
function partial(pts: readonly Vec3[], frac: number): Vec3[] {
  const lens: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Vec3;
    const b = pts[i] as Vec3;
    lens.push((lens[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const want = (lens[lens.length - 1] as number) * Math.min(1, Math.max(0, frac));
  const out: Vec3[] = [pts[0] as Vec3];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Vec3;
    const b = pts[i] as Vec3;
    const l0 = lens[i - 1] as number;
    const l1 = lens[i] as number;
    if (want >= l1) {
      out.push(b);
      continue;
    }
    const t = l1 > l0 ? (want - l0) / (l1 - l0) : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    break;
  }
  return out;
}

// ---- the shader ----------------------------------------------------------------------------------

/** The generated constants (from the tables above) in front of the hook, so tiles and labels agree. */
function wallWgsl(): string {
  const f = (n: number): string => n.toFixed(5);
  const v3 = (c: readonly number[]): string =>
    `vec3f(${f(c[0] as number)}, ${f(c[1] as number)}, ${f(c[2] as number)})`;
  const dir: Vec3 = [Math.cos(PHI), 0, -Math.sin(PHI)];
  return [
    `const W_N: u32 = ${N}u;`,
    ...ENDS.slice(0, BODY).map((e, k) => `const W_E${k}: u32 = ${e}u;`),
    ...SECTIONS.map((s, k) => `const W_C${k} = ${v3(s.color)};`),
    ...SECTIONS.map((s, k) => `const W_G${k}: f32 = ${f(s.gain)};`),
    `const W_CACHE = ${v3(C.cache)};`,
    `const W_NP: u32 = ${PACKETS}u;`,
    `const W_PCOLS: u32 = ${PCOLS}u;`,
    `const W_PROWS: u32 = ${PROWS}u;`,
    `const W_STAG: f32 = ${f(STAG)};`,
    `const W_FORM: f32 = ${f(FORM)};`,
    `const W_V: f32 = ${f(SPEED)};`,
    `const W_DIR = ${v3(dir)};`,
    wallSrc,
  ].join("\n");
}

// ---- the scene -----------------------------------------------------------------------------------

/** A non-breaking space, so the JSON keeps its indentation (plain spaces collapse in labels). */
const NBSP = String.fromCharCode(160);
/** The request's skeleton, as it goes over the wire (values elided). */
const JSON_LINES: readonly { text: string; css: string }[] = [
  { text: "{", css: CSS.muted },
  { text: `${NBSP}${NBSP}"model": "claude-…",`, css: CSS.muted },
  { text: `${NBSP}${NBSP}"tools": [ … ],`, css: CSS.tools },
  { text: `${NBSP}${NBSP}"system": [ … ],`, css: CSS.system },
  { text: `${NBSP}${NBSP}"messages": [ … ],`, css: CSS.prompt },
  { text: `${NBSP}${NBSP}"max_tokens": …,`, css: CSS.muted },
  { text: `${NBSP}${NBSP}"stream": true`, css: CSS.muted },
  { text: "}", css: CSS.muted },
];

class ContextScene implements Scene {
  readonly id = "context" as const;
  private readonly wall: PointBatch;
  private readonly lines: LineBatch;
  private readonly flares: PointBatch;
  private out: Label[] = [];

  constructor(gfx: Gfx) {
    this.wall = new PointBatch(gfx, "context-wall", {}, { key: "context-wall", wgsl: wallWgsl() });
    this.wall.procedural = N;
    // Tiles stay tiles when the camera is close (CSS px).
    this.wall.maxPx = 18;
    this.lines = new LineBatch(gfx, "context-lines");
    this.flares = new PointBatch(gfx, "context-flares");
  }

  update(f: SceneFrame): CameraPose {
    const b = f.beat;
    const L = layoutFor(f.narrow);
    this.lines.begin();
    this.flares.begin();
    this.out = [];

    // ---- what the wall looks like at this beat ----
    const tokens = tokensAt(b);
    const front = rowOf(L, tokens) + 3.2 * seg(tokens, 0, 800);
    const landing = easeOut(seg(b, SLIVER[0], SLIVER[1]));
    const frame = ramp(b, FRAME[0], FRAME[1]);
    const sweep = seg(b, SHIMMER[0], SHIMMER[1]);
    const shimmer = ramp(b, SHIMMER[0], SHIMMER[0] + 0.15);
    const tau = seg(b, STREAM[0], STREAM[1]);
    const bpRows = rowOf(L, ENDS[BODY - 1] as number);

    // The shader's uniforms, four floats a slot (see the header of context-wall.wgsl). Slot 0's first
    // float is PointBatch's size cap.
    const u = this.wall.user;
    u.set([L.cols, PITCH, 0.055 * ramp(b, -0.5, -0.25) * (1 - ramp(b, 2.6, 3.0))], 1);
    u.set([front, landing, frame, sweep], 4);
    u.set([shimmer, 0.4 * win(b, 1.7, 1.95, 2.15, 2.55)], 8);
    // A dark window behind the cache caption (centred on the tools band, nine rows either way).
    u.set(
      [(SLOTS[L.narrow ? "narrow" : "wide"].sections[0] as number) + 0.5, 0.85 * win(b, 2.6, 2.78, 2.94, 3.02)],
      10,
    );
    u.set([tau, nozzleOf(L)[0], nozzleOf(L)[1], 9], 12);
    this.wall.time = f.reducedMotion ? 0 : f.time;

    const cam = this.camera(b, L, f);
    const visH = 2 * cam.distance * TAN_HALF_FOV;
    const zoom = visH / (2 * fullDistance(L, f) * TAN_HALF_FOV);
    this.guides(b, L, f, front, frame, bpRows);
    this.packets(L, tau);
    this.captions(b, L, bpRows, visH, zoom, f.narrow || f.aspect < 1.5);
    return cam;
  }

  /** The footprint, the build guides, the breakpoint and the frame around the cached prefix. */
  private guides(b: number, L: Layout, f: SceneFrame, front: number, frame: number, bpRows: number): void {
    const hw = L.w / 2 + 0.12;
    const intro = ramp(b, -0.45, -0.05) * (1 - ramp(b, 1.4, 1.9));
    if (intro > 0.01) {
      // Footprint: a dim outline, and two bright guides riding up the sides with the build front.
      const y = Math.min(L.h, front * PITCH);
      const at = y / L.h;
      for (const sx of [-1, 1]) {
        this.lines.polyline(
          [
            [sx * hw, 0, 0],
            [sx * hw, L.h, 0],
          ],
          {
            color: C.cache,
            width: 1,
            glow: 3,
            level: 0.16 * intro,
            pulse: at > 0 && at < 1 ? { at, trail: 0.06, intensity: 5 * intro, flare: 2 } : undefined,
          },
        );
      }
      this.lines.polyline(
        [
          [-hw, 0, 0],
          [hw, 0, 0],
        ],
        { color: C.cache, width: 1.2, glow: 4, level: 0.4 * intro },
      );
      this.lines.polyline(
        [
          [-hw, L.h, 0],
          [hw, L.h, 0],
        ],
        { color: C.cache, width: 1, glow: 3, level: 0.12 * intro },
      );
    }

    if (frame > 0.001) {
      // The cached prefix: a steel box whose lid is the breakpoint.
      const hw2 = L.w / 2 + 0.08;
      const yb = -0.05;
      const yt = bpRows * PITCH + 0.9 * PITCH;
      const ring: Vec3[] = [
        [hw2, yt, 0],
        [hw2, yb, 0],
        [-hw2, yb, 0],
        [-hw2, yt, 0],
        [hw2, yt, 0],
      ];
      const fade = 1 - ramp(b, 2.94, 3.08);
      const run = f.reducedMotion ? 0.5 : (f.time * 0.12) % 1;
      this.lines.polyline(partial(ring, frame), {
        color: C.cache,
        width: 1.3,
        glow: 5,
        level: 0.55 * fade,
        pulse: frame > 0.98 ? { at: run, trail: 0.12, intensity: 4 * fade, flare: 2 } : undefined,
      });
      // The breakpoint itself is the brightest edge.
      const lid = ramp(frame, 0, 0.35);
      this.lines.polyline(
        [
          [-hw2 - 0.18 * lid, yt, 0],
          [hw2 + 0.18 * lid, yt, 0],
        ],
        { color: C.cache, width: 1.8, glow: 7, level: 1.6 * fade * lid },
      );
    }

    // The way out: a faint lane along the foot of the wall that the packets ride, with light running down it.
    const lane = ramp(b, STREAM[0], STREAM[0] + 0.2);
    if (lane > 0.01) {
      const [x0, y0] = nozzleOf(L);
      this.lines.polyline(
        [
          [x0 - 0.5, y0, 0],
          [x0 + Math.cos(PHI) * 90, y0, -Math.sin(PHI) * 90],
        ],
        {
          color: C.cache,
          width: 1,
          glow: 3,
          level: 0.1 * lane,
          flow: { period: 1.6, speed: f.reducedMotion ? 0 : 5, duty: 0.1, intensity: 1.3 },
        },
      );
    }
    this.lines.time = f.reducedMotion ? 0 : f.time;
  }

  /** An outline round each packet once it has formed, and a glow at the nozzle while they're being made. */
  private packets(L: Layout, tau: number): void {
    if (tau <= 0) return;
    const nozzle = nozzleOf(L);
    const dir: Vec3 = [Math.cos(PHI), 0, -Math.sin(PHI)];
    const pp = PITCH * 0.35;
    const half = (PCOLS * pp) / 2;
    const rise = (PROWS * pp) / 2;
    for (let k = 0; k < PACKETS; k++) {
      const u = tau - k * STAG;
      const formed = ramp(u, FORM * 1.1, FORM * 1.9);
      if (formed <= 0.01) continue;
      const c: Vec3 = [nozzle[0] + dir[0] * SPEED * u, nozzle[1], nozzle[2] + dir[2] * SPEED * u];
      const a: Vec3 = [c[0] - dir[0] * half, c[1] - rise, c[2] - dir[2] * half];
      const b: Vec3 = [c[0] + dir[0] * half, c[1] - rise, c[2] + dir[2] * half];
      const d: Vec3 = [c[0] + dir[0] * half, c[1] + rise, c[2] + dir[2] * half];
      const e: Vec3 = [c[0] - dir[0] * half, c[1] + rise, c[2] - dir[2] * half];
      const section = ENDS.findIndex((end) => Math.ceil((k * N) / PACKETS) + 100 < end);
      const color = (SECTIONS[section < 0 ? BODY : section] as Section).color;
      this.lines.polyline([a, b, d, e, a], { color, width: 1, glow: 2, level: 0.5 * formed });
    }
    const making = tau * (1 - ramp(tau, 0.75, 0.95));
    if (making > 0.01) {
      this.flares.point(nozzle, { color: C.cache, size: 0.22, glow: 1.6, intensity: 1.0 * Math.min(1, making * 6) });
    }
  }

  /** A line from a band out to its label, drawn in `grow` (0..1) of the way, with a dot where it starts. */
  private leader(pts: Vec3[], color: Rgb, grow: number, opacity: number, level: number): void {
    this.lines.polyline(partial(pts, grow), { color, width: 1, glow: 2, level, opacity });
    this.flares.point(pts[0] as Vec3, { color, px: 4.5, glow: 1.5, intensity: 1.5 * opacity });
  }

  /** Every label: the JSON skeleton, the sections, your message, the cache. */
  /** `compact`: short label text, for phones and cramped windows. */
  private captions(b: number, L: Layout, bpRows: number, visH: number, zoom: number, compact: boolean): void {
    const slots = SLOTS[L.narrow ? "narrow" : "wide"];
    const y = (rows: number): number => rows * PITCH;
    // A label's offset from its band is kept constant on screen, so closer shots don't fling labels away.
    const fan = (mid: number, slot: number): number => y(mid + (slot - mid) * Math.min(1, zoom));
    // Labels sit a fixed fraction of the view height from the wall's edge, whatever the zoom.
    const gap = visH * (L.narrow ? 0.022 : 0.05);
    const edge = L.w / 2 + 0.06;
    const anchor = edge + gap;

    // b0: the request's skeleton, over the empty footprint.
    const json = win(b, -0.35, -0.05, 0.32, 0.55);
    if (json > 0.01) {
      const line = L.narrow ? 17 : 27;
      for (const [k, l] of JSON_LINES.entries()) {
        this.out.push({
          id: `json${k}`,
          pos: [L.w / 2 - (L.narrow ? 3 : 1.4), y(rowOf(L, L.narrow ? 10000 : 4200)), 0],
          text: l.text,
          kind: L.narrow ? "name" : "big",
          align: "left",
          dx: -(L.narrow ? 72 : 100),
          dy: (k - (JSON_LINES.length - 1) / 2) * line,
          opacity: json * (k === 0 || k === JSON_LINES.length - 1 ? 0.7 : 1),
          color: l.css,
        });
      }
    }

    // b1: each section is named as it completes.
    const leave = 1 - ramp(b, 2.94, 3.08);
    for (const [s, sec] of SECTIONS.entries()) {
      if (s === BODY) continue;
      const done = (BUILD[s] as readonly [number, number, number])[1];
      const op = ramp(b, done - 0.03, done + 0.1) * leave;
      if (op < 0.02) continue;
      const mid = rowOf(L, (START(s) + (ENDS[s] as number)) / 2);
      const slot = slots.sections[s] as number;
      this.leader(
        [
          [edge, y(mid), 0],
          [edge + gap * 0.3, y(mid), 0],
          [anchor - gap * 0.08, fan(mid, slot), 0],
        ],
        sec.color,
        ramp(b, done - 0.03, done + 0.08),
        op,
        0.55,
      );
      this.out.push({
        id: `sec${s}`,
        pos: [anchor, fan(mid, slot), 0],
        text: `${compact ? sec.short : sec.name} ≈ ${fmt(sec.count)}`,
        kind: "name",
        align: "left",
        opacity: op,
        color: sec.css,
      });
      if (sec.note && !compact) {
        this.out.push({
          id: `note${s}`,
          pos: [anchor, fan(mid, slot), 0],
          text: sec.note,
          kind: "note",
          align: "left",
          dy: 15,
          opacity: op * 0.9,
        });
      }
    }

    // b2: your message, and the size of everything before it.
    const msg = SECTIONS[BODY] as Section;
    const msgOp = ramp(b, 1.68, 1.95) * leave;
    if (msgOp > 0.02) {
      const mid = rowOf(L, (START(BODY) + N) / 2);
      this.leader(
        [
          [edge, y(mid), 0],
          [edge + gap * 0.3, y(mid), 0],
          [anchor - gap * 0.08, fan(mid, slots.message), 0],
        ],
        msg.color,
        ramp(b, 1.68, 1.88),
        msgOp,
        0.9,
      );
      this.out.push({
        id: "msg",
        pos: [anchor, fan(mid, slots.message), 0],
        text: L.narrow
          ? `${msg.short} ≈ ${msg.count}`
          : compact
            ? `${msg.short} ≈ ${msg.count} (under 1%)`
            : "your message ≈ 200 tokens (under 1%)",
        kind: "name",
        align: "left",
        opacity: msgOp,
        color: msg.css,
      });
      if (L.narrow) {
        this.out.push({
          id: "msg-note",
          pos: [anchor, fan(mid, slots.message), 0],
          text: "under 1%",
          kind: "note",
          align: "left",
          dy: 14,
          opacity: msgOp * 0.9,
        });
      }
    }
    const total = ramp(b, 2.0, 2.3) * leave;
    if (total > 0.02) {
      this.out.push({
        id: "total",
        pos: [0, -0.3, 0],
        text: `≈ ${fmt(N)} tokens (illustrative)`,
        kind: "mono",
        align: "center",
        opacity: total,
      });
    }

    // b3: the cache.
    const cap = win(b, 2.6, 2.78, 2.94, 3.02);
    if (cap > 0.02) {
      const lines = L.narrow ? ["cached for 5 minutes (or an hour)"] : ["cached for 5 minutes", "(or an hour)"];
      for (const [k, text] of lines.entries()) {
        this.out.push({
          id: `cache${k}`,
          pos: [0, y(slots.sections[0]), 0],
          text,
          kind: L.narrow ? "name" : "big",
          align: "center",
          dy: (k - (lines.length - 1) / 2) * 21,
          opacity: cap,
          color: "#d3dcea",
        });
      }
    }
    const bp = ramp(b, FRAME[0] + 0.15, FRAME[1]) * leave;
    if (bp > 0.02) {
      const lid = y(bpRows) + 0.9 * PITCH;
      this.out.push({
        id: "bp",
        // Beside the lid's end on wide screens; above its left end on phones, where the right is crowded.
        pos: L.narrow ? [-L.w / 2, lid, 0] : [anchor, lid, 0],
        text: "cache breakpoint",
        kind: "mono",
        align: "left",
        dy: L.narrow ? -11 : 0,
        opacity: bp,
        color: CSS.cache,
      });
    }
  }

  private camera(b: number, L: Layout, f: SceneFrame): CameraPose {
    const dFull = fullDistance(L, f);
    const keys: PoseKey[] = (L.narrow ? KEYS_NARROW : KEYS_WIDE).map((k) => ({
      at: k.at,
      pose: pose([k.x * L.w, k.y * L.h, 0], dFull * k.zoom, k.yaw, k.pitch, 40),
    }));
    const p = poseAt(keys, b);
    // Park the subject where the layout wants it, whatever the zoom: the wall's right edge at a fixed
    // spot (until the stream takes over), and phones' wall above the text.
    const visH = 2 * p.distance * TAN_HALF_FOV;
    const right: Vec3 = [Math.cos(p.yaw), 0, -Math.sin(p.yaw)];
    const up: Vec3 = [-Math.sin(p.yaw) * Math.sin(p.pitch), Math.cos(p.pitch), -Math.cos(p.yaw) * Math.sin(p.pitch)];
    const pin = 1 - ramp(b, STREAM[0], STREAM[0] + 0.45);
    const here = (right[0] * (L.w / 2 - p.target[0]) - right[2] * p.target[2]) / visH;
    const ox = (edgeOffset(L, f, 2 * dFull * TAN_HALF_FOV) - here) * pin;
    const oy = liftOffset(f);
    const target: Vec3 = [
      p.target[0] - (right[0] * ox + up[0] * oy) * visH,
      p.target[1] - (right[1] * ox + up[1] * oy) * visH,
      p.target[2] - (right[2] * ox + up[2] * oy) * visH,
    ];
    // A breath of idle drift, so the picture isn't dead when the reader pauses.
    const drift = f.reducedMotion ? 0 : 1;
    return {
      ...p,
      target,
      yaw: p.yaw + drift * 0.009 * Math.sin(f.time * 0.37),
      pitch: p.pitch + drift * 0.005 * Math.sin(f.time * 0.29 + 1),
    };
  }

  draw(pass: GPURenderPassEncoder): void {
    this.lines.draw(pass);
    this.wall.draw(pass);
    this.flares.draw(pass);
  }

  labels(out: Label[]): void {
    out.push(...this.out);
  }
}

const contextScene: SceneFactory = (gfx) => new ContextScene(gfx);
export default contextScene;
