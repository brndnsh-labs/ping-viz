// A packet as byte cells laid out like a hexdump (16 per row). Headers attach in front as it goes down
// the stack, so every byte already there slides along to make room; on the way up they come off again.
import { C, mixRgb, scaleRgb } from "../config";
import type { Frame, Layer } from "../net/packet";
import type { BoxBatch } from "../render/boxes";
import type { Rgb } from "../render/gfx";
import { smooth } from "../util/ease";
import { lerp3, type Vec3 } from "../util/math";

export const LAYER_RGB: Record<Layer, Rgb> = { link: C.link, ip: C.ip, icmp: C.icmp, data: C.payload };

const LINK = 14;
const IP = 20;
const ICMP = 8;
const COLS = 16;

export interface CardState {
  frame: Frame;
  /** Top-left corner of the card. It faces +z; columns run along +x, rows down. */
  origin: Vec3;
  pitch: number;
  /** 0..1: the data bytes appearing (staggered). */
  data: number;
  /** 0..1 attach progress per header (1: in place). */
  icmp: number;
  ip: number;
  link: number;
  /** Where a header's bytes fly in from (or off to), per layer, relative to the origin. */
  from: Partial<Record<Layer, Vec3>>;
  /** Mix every colour toward this (the reply is mint). */
  tint: Rgb | null;
  /** A field id the reader is hovering. */
  focus: string | null;
  /** Field id → 0..1 flash (the kernel writing it). */
  flash: Record<string, number>;
  opacity: number;
}

const layerOf = (j: number): Layer =>
  j < LINK ? "link" : j < LINK + IP ? "ip" : j < LINK + IP + ICMP ? "icmp" : "data";

/** The byte's offset in the packet when the headers flagged 1 are attached (its own layer counted as attached). */
function offset(j: number, layer: Layer, c: number, i: number, l: number): number {
  if (layer === "link") return j;
  if (layer === "ip") return j - LINK * (1 - l);
  if (layer === "icmp") return j - LINK * (1 - l) - IP * (1 - i);
  return j - LINK * (1 - l) - IP * (1 - i) - ICMP * (1 - c);
}

const slot = (s: CardState, o: number): Vec3 => {
  const col = o % COLS;
  const row = Math.floor(o / COLS);
  return [s.origin[0] + (col + 0.5) * s.pitch, s.origin[1] - (row + 0.5) * s.pitch, s.origin[2]];
};

/** Where byte j sits now, and how present it is (0..1). */
export function bytePos(s: CardState, j: number): { p: Vec3; k: number } {
  const layer = layerOf(j);
  const e = { icmp: smooth(s.icmp), ip: smooth(s.ip), link: smooth(s.link) };
  // Blend the slot over the 8 combinations of attached headers (only one is ever mid-way).
  let p: Vec3 = [0, 0, 0];
  for (let m = 0; m < 8; m++) {
    const c = m & 1;
    const i = (m >> 1) & 1;
    const l = (m >> 2) & 1;
    const w = (c ? e.icmp : 1 - e.icmp) * (i ? e.ip : 1 - e.ip) * (l ? e.link : 1 - e.link);
    if (w <= 0) continue;
    const q = slot(s, offset(j, layer, c, i, l));
    p = [p[0] + q[0] * w, p[1] + q[1] * w, p[2] + q[2] * w];
  }
  if (layer === "data") {
    const k = j - (LINK + IP + ICMP);
    const a = Math.min(1, Math.max(0, (s.data - (k / 56) * 0.6) / 0.4));
    return { p, k: smooth(a) };
  }
  const len = layer === "link" ? LINK : layer === "ip" ? IP : ICMP;
  const start = layer === "link" ? 0 : layer === "ip" ? LINK : LINK + IP;
  const idx = j - start;
  const raw = s[layer];
  const a = smooth(Math.min(1, Math.max(0, (raw - (idx / len) * 0.45) / 0.55)));
  const from = s.from[layer];
  if (!from || a >= 1) return { p, k: a };
  const src: Vec3 = [s.origin[0] + from[0] + (idx % 8) * s.pitch * 0.5, s.origin[1] + from[1], s.origin[2] + from[2]];
  return { p: lerp3(src, p, a), k: a };
}

/** Rows currently occupied (for framing). */
export function cardRows(s: CardState): number {
  const n = 56 + ICMP * smooth(s.icmp) + IP * smooth(s.ip) + LINK * smooth(s.link);
  return Math.ceil(n / COLS);
}

/** Centre of a field's bytes (for labels), or null if it isn't on the card yet. */
export function fieldPos(s: CardState, id: string): Vec3 | null {
  const f = s.frame.fields.find((x) => x.id === id);
  if (!f) return null;
  const a = bytePos(s, f.offset);
  const b = bytePos(s, f.offset + f.length - 1);
  if (a.k < 0.5) return null;
  return lerp3(a.p, b.p, 0.5);
}

export function drawCard(s: CardState, boxes: BoxBatch): void {
  if (s.opacity <= 0.01) return;
  const focus = s.focus ? s.frame.fields.find((x) => x.id === s.focus) : undefined;
  const flashOf = new Float32Array(s.frame.bytes.length);
  for (const [id, v] of Object.entries(s.flash)) {
    const f = s.frame.fields.find((x) => x.id === id);
    if (f) for (let i = 0; i < f.length; i++) flashOf[f.offset + i] = v;
  }
  const size = s.pitch * 0.8;
  for (let j = 0; j < s.frame.bytes.length; j++) {
    const { p, k } = bytePos(s, j);
    if (k <= 0.01) continue;
    const layer = layerOf(j);
    let col = LAYER_RGB[layer];
    if (s.tint) col = mixRgb(col, s.tint, 0.24);
    let gain = 1;
    if (focus) gain = j >= focus.offset && j < focus.offset + focus.length ? 2.6 : 0.3;
    const fl = flashOf[j] as number;
    if (fl > 0) col = mixRgb(col, [1, 1, 1], 0.5 * fl);
    gain *= (1 + 2.2 * fl) * k * s.opacity;
    const sz = size * (0.55 + 0.45 * k);
    boxes.box(p, [sz, sz, 0.012], {
      edge: scaleRgb(col, 1.25),
      edgeIntensity: gain,
      edgePx: 1,
      fill: scaleRgb(col, 0.32),
      fillIntensity: gain,
    });
  }
}
