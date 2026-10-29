// The laptop's display: a terminal window rasterised once (2D canvas) into lit "pixels", drawn as
// points on the panel, plus a faint grid of unlit pixels and a scanline that sweeps top to bottom.
// The panel lies flat in the hardware plane; "up" on the screen is -z.
//
// Two layouts: an 88-column terminal (desktop; the reply line is 85 characters), and 32 columns for
// phones, where the long lines wrap the way a narrow terminal would wrap them.
import type { Gfx, Rgb } from "../render/gfx";
import { PointBatch } from "../render/points";
import type { Vec3 } from "../util/math";
import { DISPLAY, Y } from "./machine-layout";

/** What the terminal shows. Lines 0-2 are Act I; line 3 replaces them in Act II. */
export const SCREEN_TEXT = [
  "$ ping google.com",
  "PING google.com (172.253.124.113) 56(84) bytes of data.",
  "64 bytes from ys-in-f113.1e100.net (172.253.124.113): icmp_seq=1 ttl=117 time=11.8 ms",
  "$ claude",
] as const;

const CW = 6; // px per character cell
const LH = 12; // px per text row
const PAD = 4;
/** World units per pixel. */
export const PITCH = 0.0055;
const FONT = '10px ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
const TEXT_RGB: Rgb = [0.86, 0.9, 1.0];

export interface Block {
  /** Pixel columns and rows. */
  cols: number;
  rows: number;
  /** World position of pixel (0, 0)'s centre (top-left). */
  origin: Vec3;
  w: number;
  d: number;
  /** Centre of the block, and of each logical line (world). */
  center: Vec3;
  lines: Vec3[];
}

/** The panel: x/z extents in world units. */
export const PANEL = {
  x0: DISPLAY.x - DISPLAY.w / 2,
  x1: DISPLAY.x + DISPLAY.w / 2,
  z0: DISPLAY.z - DISPLAY.d / 2,
  z1: DISPLAY.z + DISPLAY.d / 2,
  y: Y.hw + 0.05,
};

// Uniform slots (user[0].x is PointBatch.maxPx):
//  user[1] = (panel top z, panel depth, scan 0..1 or -1, scan flare)
//  user[2] = visibility of lines 0..3
//  user[3] = (cols, pitch, rows, reveal line 2 by the scan)
//  user[4] = (origin xyz, 0)
//  user[5] = grid rgb, intensity
const SCAN = `
fn scanFlare(z: f32, k: f32) -> f32 {
  let scan = batch.user[1].z;
  if (scan < 0.0) {
    return 0.0;
  }
  let d = scan - (z - batch.user[1].x) / batch.user[1].y;
  return select(0.0, exp(-d * k), d >= 0.0) * batch.user[1].w;
}
`;

const LIT_HOOK = `${SCAN}
fn getPoint(i: u32) -> PointInst {
  var p = pts[i];
  let line = min(u32(p.px + 0.5), 3u);
  p.px = 0.0;
  var vis = batch.user[2][line];
  if (line == 2u && batch.user[3].w > 0.5) {
    let v = (p.pos.z - batch.user[1].x) / batch.user[1].y;
    vis *= step(v, batch.user[1].z);
  }
  p.color.a *= vis * (1.0 + 2.5 * scanFlare(p.pos.z, 70.0));
  return p;
}`;

const GRID_HOOK = `${SCAN}
fn getPoint(i: u32) -> PointInst {
  var p: PointInst;
  let cols = u32(batch.user[3].x);
  let q = batch.user[3].y;
  let c = i % cols;
  let r = i / cols;
  p.pos = batch.user[4].xyz + vec3f(f32(c) * q, 0.0, f32(r) * q);
  p.size = q * 0.42;
  p.px = 0.0;
  p.minPx = 0.5;
  p.glow = 0.0;
  p.shape = 1.0;
  p.color = vec4f(batch.user[5].rgb, batch.user[5].a * (1.0 + 7.0 * scanFlare(p.pos.z, 35.0)));
  return p;
}`;

interface Chunk {
  text: string;
  row: number;
  line: number;
}

function chunks(wrap: number): { list: Chunk[]; rows: number; lineRows: number[][] } {
  const list: Chunk[] = [];
  const lineRows: number[][] = [[], [], [], [0]];
  let row = 0;
  for (let line = 0; line < 3; line++) {
    const s = SCREEN_TEXT[line] as string;
    for (let i = 0; i < s.length; i += wrap) {
      list.push({ text: s.slice(i, i + wrap), row, line });
      lineRows[line]?.push(row);
      row++;
    }
  }
  list.push({ text: SCREEN_TEXT[3], row: 0, line: 3 });
  return { list, rows: row, lineRows };
}

/** One layout: lit pixels in a PointBatch, the unlit grid as a procedural batch. */
class Layout {
  readonly lit: PointBatch;
  readonly grid: PointBatch;
  readonly block: Block;

  constructor(gfx: Gfx, wrap: number, key: string) {
    const { list, rows, lineRows } = chunks(wrap);
    const cols = wrap * CW + PAD * 2;
    const prow = rows * LH + PAD * 2;
    const w = cols * PITCH;
    const d = prow * PITCH;
    // Centred left-right on the panel, a little above the middle (a terminal window on a desktop).
    const x0 = DISPLAY.x - w / 2;
    const z0 = PANEL.z0 + (DISPLAY.d - d) * 0.36;
    const origin: Vec3 = [x0 + PITCH / 2, PANEL.y + 0.004, z0 + PITCH / 2];
    const lines = lineRows.map((rs): Vec3 => {
      const r0 = rs[0] ?? 0;
      const r1 = rs[rs.length - 1] ?? 0;
      return [x0 + w / 2, PANEL.y, z0 + (PAD + ((r0 + r1 + 1) / 2) * LH) * PITCH];
    });
    this.block = { cols, rows: prow, origin, w, d, center: [x0 + w / 2, PANEL.y, z0 + d / 2], lines };

    this.lit = new PointBatch(gfx, `machine-screen-${key}`, {}, { key: "machine-screen", wgsl: LIT_HOOK });
    this.lit.procedural = 0;
    const canvas = document.createElement("canvas");
    canvas.width = wrap * CW + 4;
    canvas.height = LH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      for (const ch of list) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = FONT;
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = "#fff";
        for (let i = 0; i < ch.text.length; i++) ctx.fillText(ch.text[i] as string, i * CW, 9);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let y = 0; y < LH; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const a = (img[(y * canvas.width + x) * 4 + 3] as number) / 255;
            if (a < 0.3) continue;
            const c = PAD + x;
            const r = PAD + ch.row * LH + y;
            this.lit.point([origin[0] + c * PITCH, origin[1] + 0.001, origin[2] + r * PITCH], {
              color: TEXT_RGB,
              intensity: 0.35 + 0.65 * a,
              size: PITCH * 0.78,
              // The hook reads the logical line from px (unused when size is set).
              px: ch.line,
              minPx: 0.7,
              glow: 0.5,
              shape: "disc",
            });
          }
        }
      }
    }
    this.lit.procedural = this.lit.count;

    this.grid = new PointBatch(gfx, `machine-grid-${key}`, {}, { key: "machine-grid", wgsl: GRID_HOOK });
    this.grid.procedural = cols * prow;
    for (const b of [this.lit, this.grid]) {
      b.user.set([PANEL.z0, DISPLAY.d, -1, 0], 4);
      b.user.set([cols, PITCH, prow, 0], 12);
      b.user.set([origin[0], origin[1], origin[2], 0], 16);
    }
    this.grid.user.set([0.55, 0.62, 0.9, 0.05], 20);
  }
}

export interface ScreenState {
  narrow: boolean;
  /** Visibility of lines 0..3 (line 2 is also gated by the scan when `reveal`). */
  vis: [number, number, number, number];
  /** Scanline position 0..1 down the panel, or -1. */
  scan: number;
  reveal: boolean;
  /** Unlit pixel grid brightness (0: hidden). */
  grid: number;
  opacity: number;
}

export class Screen {
  private readonly layouts: [Layout, Layout];
  private current: Layout;
  private gridOn = 0;

  constructor(gfx: Gfx) {
    this.layouts = [new Layout(gfx, 88, "wide"), new Layout(gfx, 32, "narrow")];
    this.current = this.layouts[0];
  }

  block(narrow: boolean): Block {
    return this.layouts[narrow ? 1 : 0].block;
  }

  set(s: ScreenState): void {
    const l = this.layouts[s.narrow ? 1 : 0];
    this.current = l;
    const flare = s.scan >= 0 ? 1 : 0;
    for (const b of [l.lit, l.grid]) {
      b.user[6] = s.scan;
      b.user[7] = flare;
      b.user.set(s.vis, 8);
      b.user[15] = s.reveal ? 1 : 0;
      b.opacity = s.opacity;
    }
    l.lit.maxPx = 0;
    this.gridOn = s.grid * s.opacity;
    l.grid.opacity = this.gridOn;
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.gridOn > 0.01) this.current.grid.draw(pass);
    if (this.current.lit.opacity > 0.01) this.current.lit.draw(pass);
  }
}
