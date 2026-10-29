// The GPU state scenes share: formats, bind group layouts, a pipeline cache, and the instance batch
// that every primitive (lines, points, boxes, spheres) builds on.
import { gpuErrors } from "../gpu/context";
import commonWgsl from "./common.wgsl?raw";

export const HDR_FORMAT: GPUTextureFormat = "rgba16float";
export const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";

/** How a primitive's colour lands in the HDR target. Everything glowing is additive. */
export type BlendMode = "add" | "opaque";

export interface DrawOptions {
  blend?: BlendMode;
  /** Write depth (solid geometry). Additive glows test depth but don't write it. */
  depthWrite?: boolean;
  /** Ignore depth entirely (overlays). */
  depthTest?: boolean;
}

const BATCH_UNIFORM_FLOATS = 4 + 8 * 4;

/**
 * Stand-ins handed out while `Gfx.record` runs. Only the no-op pass used for the dry run ever sees
 * them; nothing is drawn with them.
 */
const RECORDING_PIPELINE = {} as GPURenderPipeline;
const RECORDING_GROUP = {} as GPUBindGroup;

export class Gfx {
  readonly device: GPUDevice;
  readonly sampleCount: number;
  readonly cameraLayout: GPUBindGroupLayout;
  readonly batchLayout: GPUBindGroupLayout;
  readonly pipelineLayout: GPUPipelineLayout;
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  /** Pipelines being compiled in the background (see `record`). */
  private readonly compiling = new Set<string>();
  private recording: Map<string, GPURenderPipelineDescriptor> | null = null;

  constructor(device: GPUDevice, sampleCount: number) {
    this.device = device;
    this.sampleCount = sampleCount;
    this.cameraLayout = device.createBindGroupLayout({
      label: "camera",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }],
    });
    this.batchLayout = device.createBindGroupLayout({
      label: "batch",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.cameraLayout, this.batchLayout] });
  }

  /** A shader module with the common prelude (camera, batch uniforms, hashes) prepended. */
  module(key: string, code: string): GPUShaderModule {
    let m = this.modules.get(key);
    if (!m) {
      m = this.device.createShaderModule({ label: key, code: `${commonWgsl}\n${code}` });
      this.modules.set(key, m);
    }
    return m;
  }

  /** True while `record` runs: batches skip their uploads, pipelines are only noted. */
  get recordingPipelines(): boolean {
    return this.recording !== null;
  }

  /**
   * Run `fn` (a dry run of some scenes' draws, into a pass that records nothing) and compile every
   * pipeline it asked for that doesn't exist yet, in the background. Built on first use instead, a
   * pipeline stalls the frame a scene first fades in on; that stall is worst on Safari.
   */
  record(fn: () => void): Promise<void> {
    const wanted = new Map<string, GPURenderPipelineDescriptor>();
    this.recording = wanted;
    try {
      fn();
    } finally {
      this.recording = null;
    }
    const jobs = [...wanted].map(async ([key, desc]) => {
      this.compiling.add(key);
      try {
        const p = await this.device.createRenderPipelineAsync(desc);
        if (!this.pipelines.has(key)) this.pipelines.set(key, p);
      } catch (e) {
        const msg = `pipeline ${key}: ${e instanceof Error ? e.message : String(e)}`;
        if (gpuErrors.length < 50) gpuErrors.push(msg);
        console.error("WebGPU:", msg);
      } finally {
        this.compiling.delete(key);
      }
    });
    return Promise.all(jobs).then(() => undefined);
  }

  /** A cached render pipeline for one primitive shader and draw options. */
  pipeline(
    key: string,
    module: GPUShaderModule,
    opts: DrawOptions,
    entries: { vs?: string; fs?: string; topology?: GPUPrimitiveTopology; cull?: GPUCullMode } = {},
  ): GPURenderPipeline {
    const blend = opts.blend ?? "add";
    const depthWrite = opts.depthWrite ?? blend === "opaque";
    const depthTest = opts.depthTest ?? true;
    const full = `${key}|${blend}|${depthWrite}|${depthTest}|${entries.vs ?? "vs"}|${entries.fs ?? "fs"}|${entries.cull ?? "none"}`;
    let p = this.pipelines.get(full);
    if (p) return p;
    if (this.recording && this.compiling.has(full)) return RECORDING_PIPELINE;
    const blendState: GPUBlendState | undefined =
      blend === "add"
        ? {
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
          }
        : undefined;
    const desc: GPURenderPipelineDescriptor = {
      label: full,
      layout: this.pipelineLayout,
      vertex: { module, entryPoint: entries.vs ?? "vs" },
      fragment: { module, entryPoint: entries.fs ?? "fs", targets: [{ format: HDR_FORMAT, blend: blendState }] },
      primitive: { topology: entries.topology ?? "triangle-list", cullMode: entries.cull ?? "none" },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: depthWrite,
        depthCompare: depthTest ? "less-equal" : "always",
      },
      multisample: { count: this.sampleCount },
    };
    if (this.recording) {
      this.recording.set(full, desc);
      return RECORDING_PIPELINE;
    }
    // Asked for before its background compile finished (a jump straight to a scene): build it now.
    p = this.device.createRenderPipeline(desc);
    this.pipelines.set(full, p);
    return p;
  }
}

/**
 * A growable array of fixed-size instances, mirrored to a storage buffer, plus the batch uniform
 * block (opacity, a clock, a highlight, and eight free vec4 slots for custom shaders).
 *
 * Fill it with `begin()` + the subclass's add methods every frame (cheap for a few thousand
 * instances), or once for static sets and animate them through the uniforms.
 */
export class InstanceBatch {
  protected readonly gfx: Gfx;
  protected readonly stride: number;
  protected data: Float32Array;
  count = 0;
  /** misc.x: opacity multiplier. */
  opacity = 1;
  /** misc.y: the clock shaders animate with (flowing dashes, twinkles). */
  time = 0;
  /** misc.z: free for highlight effects. */
  highlight = 0;
  /** Eight vec4 slots for custom instance hooks. */
  readonly user = new Float32Array(32);
  private buffer: GPUBuffer | null = null;
  private capacity = 0;
  private readonly uniform: GPUBuffer;
  private readonly uniformData = new Float32Array(BATCH_UNIFORM_FLOATS);
  private group: GPUBindGroup | null = null;
  private dirty = true;
  private readonly label: string;

  constructor(gfx: Gfx, label: string, strideFloats: number, initialCapacity = 64) {
    this.gfx = gfx;
    this.label = label;
    this.stride = strideFloats;
    this.data = new Float32Array(strideFloats * Math.max(1, initialCapacity));
    this.uniform = gfx.device.createBuffer({
      label: `${label}-batch`,
      size: BATCH_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  begin(): void {
    this.count = 0;
    this.dirty = true;
  }

  /** Reserve one instance and return its float offset in `data`. */
  protected alloc(): number {
    if ((this.count + 1) * this.stride > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const o = this.count * this.stride;
    this.count++;
    this.dirty = true;
    return o;
  }

  /** Mark instance data as changed after editing `data` in place. */
  touch(): void {
    this.dirty = true;
  }

  /** Upload changed instances and this frame's uniforms. Returns the bind group for group 1. */
  protected prepare(extraW = 0): GPUBindGroup {
    if (this.gfx.recordingPipelines) return RECORDING_GROUP;
    const device = this.gfx.device;
    const need = Math.max(1, this.count) * this.stride * 4;
    if (!this.buffer || need > this.capacity) {
      this.buffer?.destroy();
      this.capacity = Math.max(need, this.capacity * 2, this.stride * 4 * 64);
      this.buffer = device.createBuffer({
        label: `${this.label}-instances`,
        size: this.capacity,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.group = null;
      this.dirty = true;
    }
    if (this.dirty && this.count > 0) {
      device.queue.writeBuffer(this.buffer, 0, this.data.buffer, this.data.byteOffset, this.count * this.stride * 4);
      this.dirty = false;
    }
    const u = this.uniformData;
    u[0] = this.opacity;
    u[1] = this.time;
    u[2] = this.highlight;
    u[3] = extraW;
    u.set(this.user, 4);
    device.queue.writeBuffer(this.uniform, 0, u);
    if (!this.group) {
      this.group = device.createBindGroup({
        label: `${this.label}-group`,
        layout: this.gfx.batchLayout,
        entries: [
          { binding: 0, resource: { buffer: this.buffer } },
          { binding: 1, resource: { buffer: this.uniform } },
        ],
      });
    }
    return this.group;
  }

  destroy(): void {
    this.buffer?.destroy();
    this.uniform.destroy();
  }
}

/** Linear HDR colour plus an intensity, as stored in instance data. */
export type Rgb = [number, number, number];
