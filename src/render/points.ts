import type { Vec3 } from "../util/math";
import { type DrawOptions, type Gfx, InstanceBatch, type Rgb } from "./gfx";
import pointsWgsl from "./points.wgsl?raw";

const STRIDE = 12;
const DEFAULT_HOOK = "fn getPoint(i: u32) -> PointInst {\n  return pts[i];\n}";

export interface PointStyle {
  color: Rgb;
  /** Brightness multiplier. Default 1. */
  intensity?: number;
  /** World-space core diameter. */
  size?: number;
  /** Fixed core diameter in px (used when `size` is absent). Default 4. */
  px?: number;
  /** Smallest drawn diameter in px. Default 1.25. */
  minPx?: number;
  /** Halo radius as a multiple of the core radius. Default 1.5. */
  glow?: number;
  shape?: "soft" | "disc" | "ring";
}

const SHAPES = { soft: 0, disc: 1, ring: 2 } as const;

export interface CustomPoints {
  /** Cache key for the shader (one per distinct hook). */
  key: string;
  /**
   * WGSL defining `fn getPoint(i: u32) -> PointInst`. It can read `batch.misc` / `batch.user[k]`,
   * the camera `cam`, `pts` (the storage buffer, if filled), and the common hash helpers.
   */
  wgsl: string;
}

export class PointBatch extends InstanceBatch {
  private readonly opts: DrawOptions;
  private readonly hook: CustomPoints | null;
  /** For custom hooks: how many instances to draw (no storage needed). */
  procedural = 0;

  /** Cap the drawn core diameter at this many CSS px (0: no cap). Stored in user[0].x. */
  set maxPx(v: number) {
    this.user[0] = v;
  }

  constructor(gfx: Gfx, label = "points", opts: DrawOptions = {}, hook: CustomPoints | null = null) {
    super(gfx, label, STRIDE, 256);
    this.opts = { blend: "add", depthWrite: false, ...opts };
    this.hook = hook;
  }

  point(p: Vec3, s: PointStyle): void {
    const o = this.alloc();
    const d = this.data;
    d[o] = p[0];
    d[o + 1] = p[1];
    d[o + 2] = p[2];
    d[o + 3] = s.size ?? 0;
    d[o + 4] = s.color[0];
    d[o + 5] = s.color[1];
    d[o + 6] = s.color[2];
    d[o + 7] = s.intensity ?? 1;
    d[o + 8] = s.px ?? 4;
    d[o + 9] = s.minPx ?? 1.25;
    d[o + 10] = s.glow ?? 1.5;
    d[o + 11] = SHAPES[s.shape ?? "soft"];
  }

  draw(pass: GPURenderPassEncoder): void {
    const n = this.hook ? this.procedural : this.count;
    if (n <= 0) return;
    const group = this.prepare(n);
    const key = this.hook ? `points:${this.hook.key}` : "points";
    const module = this.gfx.module(key, pointsWgsl.replace("//HOOK", this.hook?.wgsl ?? DEFAULT_HOOK));
    pass.setPipeline(this.gfx.pipeline(key, module, this.opts));
    pass.setBindGroup(1, group);
    pass.draw(6, n);
  }
}
