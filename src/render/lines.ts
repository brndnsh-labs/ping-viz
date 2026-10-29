import type { Vec3 } from "../util/math";
import { type DrawOptions, type Gfx, InstanceBatch, type Rgb } from "./gfx";
import linesWgsl from "./lines.wgsl?raw";

const STRIDE = 20;

export interface LineStyle {
  color: Rgb;
  /** Per-vertex colours (same length as the points) for gradients; overrides `color`. */
  colors?: Rgb[];
  /** Base brightness; 0 leaves only the pulse and flow visible. Default 1. */
  level?: number;
  /** Core width in px. Default 1.5. */
  width?: number;
  /** Halo radius in px. Default 5. */
  glow?: number;
  opacity?: number;
  /** A travelling bright spot: head and trail as fractions of the polyline's length. */
  pulse?: { at: number; trail?: number; intensity?: number; flare?: number };
  /** Moving dashes, in scene units: period, speed (units per batch clock second), duty 0..1. */
  flow?: { period: number; speed: number; duty?: number; intensity?: number };
}

export class LineBatch extends InstanceBatch {
  private readonly opts: DrawOptions;

  constructor(gfx: Gfx, label = "lines", opts: DrawOptions = {}) {
    super(gfx, label, STRIDE, 256);
    this.opts = { blend: "add", depthWrite: false, ...opts };
  }

  /** Adds a polyline; returns its length in scene units. */
  polyline(points: readonly Vec3[], style: LineStyle): number {
    const n = points.length;
    if (n < 2) return 0;
    let total = 0;
    for (let i = 1; i < n; i++) {
      const a = points[i - 1] as Vec3;
      const b = points[i] as Vec3;
      total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    const level = style.level ?? 1;
    const width = style.width ?? 1.5;
    const glow = style.glow ?? 5;
    const opacity = style.opacity ?? 1;
    const pu = style.pulse;
    const fl = style.flow;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const p = points[i] as Vec3;
      if (i > 0) {
        const q = points[i - 1] as Vec3;
        s += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      }
      const o = this.alloc();
      const d = this.data;
      const c = style.colors?.[i] ?? style.color;
      d[o] = p[0];
      d[o + 1] = p[1];
      d[o + 2] = p[2];
      d[o + 3] = s;
      d[o + 4] = c[0];
      d[o + 5] = c[1];
      d[o + 6] = c[2];
      d[o + 7] = level;
      d[o + 8] = width;
      d[o + 9] = glow;
      d[o + 10] = i === n - 1 ? 1 : 0;
      d[o + 11] = opacity;
      if (pu) {
        d[o + 12] = pu.at * total;
        d[o + 13] = (pu.trail ?? 0.2) * total;
        d[o + 14] = pu.intensity ?? 4;
        d[o + 15] = pu.flare ?? 2;
      } else {
        d[o + 12] = 0;
        d[o + 13] = 0;
        d[o + 14] = 0;
        d[o + 15] = 0;
      }
      if (fl) {
        d[o + 16] = fl.period;
        d[o + 17] = fl.speed;
        d[o + 18] = fl.duty ?? 0.3;
        d[o + 19] = fl.intensity ?? 1.5;
      } else {
        d[o + 16] = 0;
        d[o + 17] = 0;
        d[o + 18] = 0;
        d[o + 19] = 0;
      }
    }
    return total;
  }

  segment(a: Vec3, b: Vec3, style: LineStyle): number {
    return this.polyline([a, b], style);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.count < 2) return;
    const group = this.prepare(this.count);
    const module = this.gfx.module("lines", linesWgsl);
    pass.setPipeline(this.gfx.pipeline("lines", module, this.opts));
    pass.setBindGroup(1, group);
    pass.draw(6, this.count - 1);
  }
}
