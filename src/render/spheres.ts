import type { Vec3 } from "../util/math";
import { type Gfx, InstanceBatch, type Rgb } from "./gfx";
import spheresWgsl from "./spheres.wgsl?raw";

const STRIDE = 16;

export interface SphereStyle {
  fill: Rgb;
  fillIntensity?: number;
  rim?: Rgb;
  /** Rim exponent: higher is a thinner rim. Default 3. */
  rimPower?: number;
  halo?: Rgb;
  /** Halo width as a fraction of the radius. Default 0 (none). */
  haloWidth?: number;
}

export type SphereMode = "solid" | "halo" | "glass";

const ENTRY: Record<SphereMode, string> = { solid: "fs_solid", halo: "fs_halo", glass: "fs_glass" };

export class SphereBatch extends InstanceBatch {
  constructor(gfx: Gfx, label = "spheres") {
    super(gfx, label, STRIDE, 16);
  }

  sphere(center: Vec3, radius: number, s: SphereStyle): void {
    const o = this.alloc();
    const d = this.data;
    const rim = s.rim ?? [0, 0, 0];
    const halo = s.halo ?? [0, 0, 0];
    d[o] = center[0];
    d[o + 1] = center[1];
    d[o + 2] = center[2];
    d[o + 3] = radius;
    d[o + 4] = s.fill[0];
    d[o + 5] = s.fill[1];
    d[o + 6] = s.fill[2];
    d[o + 7] = s.fillIntensity ?? 1;
    d[o + 8] = rim[0];
    d[o + 9] = rim[1];
    d[o + 10] = rim[2];
    d[o + 11] = s.rimPower ?? 3;
    d[o + 12] = halo[0];
    d[o + 13] = halo[1];
    d[o + 14] = halo[2];
    d[o + 15] = s.haloWidth ?? 0;
  }

  draw(pass: GPURenderPassEncoder, mode: SphereMode = "solid"): void {
    if (this.count <= 0) return;
    const group = this.prepare(this.count);
    const module = this.gfx.module("spheres", spheresWgsl);
    const opts =
      mode === "solid" ? { blend: "opaque" as const, depthWrite: true } : { blend: "add" as const, depthWrite: false };
    pass.setPipeline(this.gfx.pipeline("spheres", module, opts, { fs: ENTRY[mode] }));
    pass.setBindGroup(1, group);
    pass.draw(6, this.count);
  }
}
