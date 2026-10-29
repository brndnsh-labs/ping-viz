// Processes as cells: a glass sphere with a few hundred particles orbiting inside. exec re-forms them
// into horizontal bands (the new memory image's segments); fork buds a copy off through a neck that
// stretches and snaps.
import { mixRgb, scaleRgb } from "../config";
import type { Rgb } from "../render/gfx";
import type { LineBatch } from "../render/lines";
import type { PointBatch } from "../render/points";
import type { SphereBatch } from "../render/spheres";
import { ramp, seg, smooth } from "../util/ease";
import { add, cross, length, lerp3, normalize, scale, sub, type Vec3 } from "../util/math";

/** Deterministic pseudo-random numbers (mulberry32). */
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

/** Memory segments, bottom (low addresses) to top: where exec's bands sit, and their share of particles. */
export const SEGMENTS = [
  { name: "text", h: -0.6, share: 0.26 },
  { name: "data", h: -0.32, share: 0.14 },
  { name: "heap", h: -0.05, share: 0.16 },
  { name: "libraries", h: 0.24, share: 0.28 },
  { name: "stack", h: 0.56, share: 0.16 },
] as const;

const N = 480;
const F = 12;

/** Orbit and band parameters for N particles. Cells that share a seed share a pattern (a fork's copy). */
class Swarm {
  readonly p = new Float32Array(N * F);
  constructor(seed: number) {
    const r = rng(seed);
    for (let i = 0; i < N; i++) {
      // Bands drawn at random by share, so any leading subset (a smaller or fading cell) has them all.
      let pick = r();
      let band = 0;
      for (const [k, sg] of SEGMENTS.entries()) {
        band = k;
        pick -= sg.share;
        if (pick < 0) break;
      }
      // Uniform direction for the orbit's normal.
      const zc = r() * 2 - 1;
      const a = r() * Math.PI * 2;
      const s = Math.sqrt(1 - zc * zc);
      const n: Vec3 = [s * Math.cos(a), zc, s * Math.sin(a)];
      const u = normalize(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
      const w = cross(n, u);
      const o = i * F;
      this.p[o] = 0.25 + 0.68 * Math.sqrt(r()); // orbit radius fraction
      this.p[o + 1] = r() * Math.PI * 2; // phase
      this.p[o + 2] = (0.25 + r() * 0.6) * (r() < 0.5 ? -1 : 1); // angular speed
      this.p.set(u, o + 3);
      this.p.set(w, o + 6);
      this.p[o + 9] = band;
      this.p[o + 10] = 0.22 + 0.72 * Math.sqrt(r()); // radius in the band's disc
      this.p[o + 11] = r() * 2 - 1; // vertical jitter
    }
  }
}

export interface CellDraw {
  id: string;
  c: Vec3;
  r: number;
  color: Rgb;
  /** 0..1 activity: brighter rim and particles. */
  glow: number;
  opacity: number;
  seed: number;
  /** 0..1: particles swirl, then settle into bands (exec). */
  bands: number;
  /** Particles shown, 0..1 of the swarm. */
  fill?: number;
  /** Label text (defaults by id). */
  name?: string;
}

export class Cells {
  private readonly swarms = new Map<number, Swarm>();

  private swarm(seed: number): Swarm {
    let s = this.swarms.get(seed);
    if (!s) {
      s = new Swarm(seed);
      this.swarms.set(seed, s);
    }
    return s;
  }

  /** Where particle i of a cell is (relative to the centre). */
  particle(cell: CellDraw, i: number, t: number): Vec3 {
    const p = this.swarm(cell.seed).p;
    const o = i * F;
    const R = cell.r * 0.9;
    const th = (p[o + 1] as number) + (p[o + 2] as number) * t;
    const rho = (p[o] as number) * R;
    const c = Math.cos(th) * rho;
    const s = Math.sin(th) * rho;
    let x = (p[o + 3] as number) * c + (p[o + 6] as number) * s;
    let y = (p[o + 4] as number) * c + (p[o + 7] as number) * s;
    let z = (p[o + 5] as number) * c + (p[o + 8] as number) * s;
    const m = cell.bands;
    if (m <= 0) return [x, y, z];
    // Swirl: spin about the vertical axis and pull in, then settle into the band's disc.
    const spin = 7 * smooth(Math.min(1, m * 1.4));
    const pull = 1 - 0.55 * Math.sin(Math.PI * Math.min(1, m));
    const cs = Math.cos(spin);
    const sn = Math.sin(spin);
    const sx = (x * cs - z * sn) * pull;
    const sz = (x * sn + z * cs) * pull;
    const sy = y * pull;
    const seg0 = SEGMENTS[p[o + 9] as number] ?? SEGMENTS[0];
    const h = seg0.h * R;
    const disc = Math.sqrt(Math.max(0, R * R - h * h)) * (p[o + 10] as number);
    const bt = (p[o + 1] as number) + (p[o + 2] as number) * 0.3 * t;
    const bx = Math.cos(bt) * disc;
    const bz = Math.sin(bt) * disc;
    const by = h + (p[o + 11] as number) * 0.035 * R;
    const k = smooth(seg(m, 0.35, 1));
    x = sx + (bx - sx) * k;
    y = sy + (by - sy) * k;
    z = sz + (bz - sz) * k;
    return [x, y, z];
  }

  draw(cells: readonly CellDraw[], glass: SphereBatch, dust: PointBatch, t: number): void {
    for (const cell of cells) {
      if (cell.opacity <= 0.01 || cell.r <= 0.01) continue;
      const g = cell.glow;
      const op = cell.opacity;
      glass.sphere(cell.c, cell.r, {
        fill: scaleRgb(cell.color, (0.035 + 0.08 * g) * op),
        rim: scaleRgb(cell.color, (0.55 + 1.3 * g) * op),
        rimPower: 2.6,
        halo: scaleRgb(cell.color, (0.06 + 0.22 * g) * op),
        haloWidth: 0.3,
      });
      // Roughly constant density: fewer particles in smaller cells.
      const n = Math.round(N * (cell.fill ?? 1) * Math.min(1, Math.max(0.25, (cell.r / 0.66) ** 1.5)));
      const col = mixRgb(cell.color, [1, 1, 1], 0.25);
      for (let i = 0; i < n; i++) {
        const q = this.particle(cell, i, t);
        dust.point(add(cell.c, q), {
          color: col,
          px: 1.9,
          minPx: 1.1,
          glow: 1.2,
          intensity: (0.45 + 0.75 * g) * op * (0.6 + (0.4 * ((i * 7919) % 13)) / 12),
        });
      }
    }
  }
}

/**
 * The neck between a cell and the bud leaving it: two curves on the silhouette (perpendicular to the
 * axis as seen from the eye) that pinch as the cells separate. `k` 0..1: 1 has snapped.
 */
export function neck(
  lines: LineBatch,
  dust: PointBatch,
  a: Vec3,
  ra: number,
  b: Vec3,
  rb: number,
  eye: Vec3,
  k: number,
  color: Rgb,
  t: number,
): void {
  if (k >= 1) return;
  const ab = sub(b, a);
  const d = length(ab);
  if (d < 1e-4) return;
  const axis = scale(ab, 1 / d);
  const mid = lerp3(a, b, 0.5);
  let side = cross(axis, normalize(sub(mid, eye)));
  if (length(side) < 1e-4) side = [0, 1, 0];
  side = normalize(side);
  const al = 0.85;
  const p0 = add(a, scale(axis, ra * Math.cos(al)));
  const p1 = sub(b, scale(axis, rb * Math.cos(al)));
  const h0 = ra * Math.sin(al);
  const h1 = rb * Math.sin(al);
  const waist = 1 - smooth(k);
  for (const sgn of [-1, 1]) {
    const pts: Vec3[] = [];
    for (let i = 0; i <= 16; i++) {
      const u = i / 16;
      const base = h0 + (h1 - h0) * u;
      const pinch = 1 - (1 - waist * 0.75) * Math.sin(Math.PI * u) ** 0.8;
      pts.push(add(lerp3(p0, p1, u), scale(side, sgn * base * pinch)));
    }
    lines.polyline(pts, { color, width: 1.3, glow: 4, level: 0.9 * (1 - ramp(k, 0.75, 1)) });
  }
  // Particles streaming across.
  for (let i = 0; i < 10; i++) {
    const u = (t * 0.35 + i / 10) % 1;
    const wob = Math.sin(i * 2.3 + t) * 0.35 * waist;
    const h = (h0 + (h1 - h0) * u) * (1 - (1 - waist * 0.75) * Math.sin(Math.PI * u) ** 0.8);
    dust.point(add(lerp3(p0, p1, u), scale(side, wob * h)), {
      color: mixRgb(color, [1, 1, 1], 0.3),
      px: 2,
      glow: 1.2,
      intensity: 0.9 * (1 - k),
    });
  }
}
