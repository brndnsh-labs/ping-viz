import type { Vec3 } from "../util/math";
import boxesWgsl from "./boxes.wgsl?raw";
import { type DrawOptions, type Gfx, InstanceBatch, type Rgb } from "./gfx";

const STRIDE = 16;
const DEFAULT_HOOK = "fn getBox(i: u32) -> BoxInst {\n  return boxes[i];\n}";

export interface BoxStyle {
  /** Edge colour (HDR). */
  edge: Rgb;
  edgeIntensity?: number;
  /** Edge width in px. Default 1.5; 0 hides edges. */
  edgePx?: number;
  /** Face colour (emissive, usually very dark). Default a faint tint of the edge. */
  fill?: Rgb;
  fillIntensity?: number;
  /** Radians around +y. */
  yaw?: number;
}

export interface CustomBoxes {
  key: string;
  /** WGSL defining `fn getBox(i: u32) -> BoxInst` (see boxes.wgsl). */
  wgsl: string;
}

export class BoxBatch extends InstanceBatch {
  private readonly opts: DrawOptions;
  private readonly hook: CustomBoxes | null;
  procedural = 0;

  constructor(gfx: Gfx, label = "boxes", opts: DrawOptions = {}, hook: CustomBoxes | null = null) {
    super(gfx, label, STRIDE, 64);
    this.opts = { blend: "opaque", depthWrite: true, ...opts };
    this.hook = hook;
  }

  /** A box by centre and full size. */
  box(center: Vec3, size: Vec3, s: BoxStyle): void {
    const o = this.alloc();
    const d = this.data;
    const fill = s.fill ?? [s.edge[0] * 0.02, s.edge[1] * 0.02, s.edge[2] * 0.02];
    d[o] = center[0];
    d[o + 1] = center[1];
    d[o + 2] = center[2];
    d[o + 3] = s.yaw ?? 0;
    d[o + 4] = size[0] / 2;
    d[o + 5] = size[1] / 2;
    d[o + 6] = size[2] / 2;
    d[o + 7] = s.edgePx ?? 1.5;
    d[o + 8] = s.edge[0];
    d[o + 9] = s.edge[1];
    d[o + 10] = s.edge[2];
    d[o + 11] = s.edgeIntensity ?? 1;
    d[o + 12] = fill[0];
    d[o + 13] = fill[1];
    d[o + 14] = fill[2];
    d[o + 15] = s.fillIntensity ?? 1;
  }

  draw(pass: GPURenderPassEncoder): void {
    const n = this.hook ? this.procedural : this.count;
    if (n <= 0) return;
    const group = this.prepare(n);
    const key = this.hook ? `boxes:${this.hook.key}` : "boxes";
    const module = this.gfx.module(key, boxesWgsl.replace("//HOOK", this.hook?.wgsl ?? DEFAULT_HOOK));
    pass.setPipeline(this.gfx.pipeline(key, module, this.opts, { cull: "back" }));
    pass.setBindGroup(1, group);
    pass.draw(36, n);
  }
}
