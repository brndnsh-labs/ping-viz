// Owns the frame: two HDR scene slots (so two scenes can crossfade, each with its own camera and
// depth), MSAA, the camera uniforms, and post-processing to the canvas.
import type { Gpu } from "../gpu/context";
import { CAMERA_UNIFORM_SIZE, type CameraState, packCamera } from "./camera";
import { DEPTH_FORMAT, Gfx, HDR_FORMAT } from "./gfx";
import { createPost, type PostModule, type PostParams } from "./post";

export interface SlotDraw {
  /** Camera with a CSS-px viewport (the renderer scales it to the render target). */
  camera: CameraState;
  weight: number;
  /** Free values for the scene's shaders (`cam.params`). */
  params?: [number, number, number, number];
  draw: (pass: GPURenderPassEncoder) => void;
}

export interface CapturedFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

interface Slot {
  uniform: GPUBuffer;
  group: GPUBindGroup;
  data: Float32Array;
  tex: GPUTexture | null;
  view: GPUTextureView | null;
}

export const DEFAULT_LOOK: Omit<PostParams, "weightA" | "weightB" | "focus" | "aspect" | "frame"> = {
  bloom: 0.9,
  exposure: 1.0,
  vignette: 0.32,
  grain: 0.012,
  saturation: 1.18,
  power: 1.12,
  bgFocus: [0.0016, 0.0022, 0.0042],
  bgEdge: [0.0003, 0.0004, 0.0009],
};

export class Renderer {
  readonly gfx: Gfx;
  private readonly gpu: Gpu;
  private readonly post: PostModule;
  private readonly slots: Slot[];
  private msaa: GPUTexture | null = null;
  private msaaView: GPUTextureView | null = null;
  private depth: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private captureRequest: ((img: CapturedFrame) => void) | null = null;
  private captureReadback: (() => void) | null = null;
  width = 0;
  height = 0;

  constructor(gpu: Gpu, sampleCount: number) {
    this.gpu = gpu;
    const device = gpu.device;
    this.gfx = new Gfx(device, sampleCount);
    this.post = createPost(device, gpu.format, gpu.colorSpace);
    this.slots = [0, 1].map((i) => {
      const uniform = device.createBuffer({
        label: `camera-${i}`,
        size: CAMERA_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      return {
        uniform,
        group: device.createBindGroup({
          label: `camera-${i}`,
          layout: this.gfx.cameraLayout,
          entries: [{ binding: 0, resource: { buffer: uniform } }],
        }),
        data: new Float32Array(CAMERA_UNIFORM_SIZE / 4),
        tex: null,
        view: null,
      };
    });
  }

  /** Size of the scene targets in device px (canvas size times render scale). */
  resize(width: number, height: number): void {
    width = Math.max(16, Math.round(width));
    height = Math.max(16, Math.round(height));
    if (width === this.width && height === this.height && this.depth) return;
    this.width = width;
    this.height = height;
    const device = this.gpu.device;
    for (const [i, s] of this.slots.entries()) {
      s.tex?.destroy();
      s.tex = device.createTexture({
        label: `scene-${i}`,
        size: [width, height],
        format: HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      s.view = s.tex.createView();
    }
    this.msaa?.destroy();
    this.msaa = null;
    this.msaaView = null;
    const sampleCount = this.gfx.sampleCount;
    if (sampleCount > 1) {
      this.msaa = device.createTexture({
        label: "scene-msaa",
        size: [width, height],
        format: HDR_FORMAT,
        sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.msaaView = this.msaa.createView();
    }
    this.depth?.destroy();
    this.depth = device.createTexture({
      label: "scene-depth",
      size: [width, height],
      format: DEPTH_FORMAT,
      sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depth.createView();
    this.post.resize(width, height);
  }

  /** Render up to two scene slots and post-process into the canvas. */
  render(draws: SlotDraw[], time: number, frame: number, look: Partial<PostParams> = {}): void {
    const device = this.gpu.device;
    const encoder = device.createCommandEncoder({ label: "frame" });
    const used = draws.slice(0, 2);
    for (const [i, d] of used.entries()) {
      const slot = this.slots[i] as Slot;
      packCamera(slot.data, d.camera, time, this.width / Math.max(1, d.camera.viewport[0]), d.params);
      device.queue.writeBuffer(slot.uniform, 0, slot.data);
      const target = slot.view as GPUTextureView;
      const pass = encoder.beginRenderPass({
        label: `scene-${i}`,
        colorAttachments: [
          this.msaaView
            ? {
                view: this.msaaView,
                resolveTarget: target,
                loadOp: "clear",
                storeOp: "discard",
                clearValue: [0, 0, 0, 1],
              }
            : { view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
        ],
        depthStencilAttachment: {
          view: this.depthView as GPUTextureView,
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "discard",
        },
      });
      pass.setBindGroup(0, slot.group);
      d.draw(pass);
      pass.end();
    }
    const a = this.slots[0] as Slot;
    const b = this.slots[1] as Slot;
    const out = this.gpu.context.getCurrentTexture();
    const aspect = this.width / Math.max(1, this.height);
    this.post.encode(encoder, a.view as GPUTextureView, b.view as GPUTextureView, out.createView(), {
      ...DEFAULT_LOOK,
      focus: [0.5, 0.5],
      aspect,
      frame,
      ...look,
      weightA: used[0]?.weight ?? 0,
      weightB: used.length > 1 ? (used[1]?.weight ?? 0) : 0,
    });
    if (this.captureRequest) this.encodeCapture(encoder, out);
    device.queue.submit([encoder.finish()]);
    this.captureReadback?.();
    this.captureReadback = null;
  }

  /** Read back the next finished frame (RGBA8, top row first). Needs the canvas configured with COPY_SRC. */
  capture(): Promise<CapturedFrame> {
    return new Promise((resolve) => {
      this.captureRequest = resolve;
    });
  }

  private encodeCapture(encoder: GPUCommandEncoder, tex: GPUTexture): void {
    const resolve = this.captureRequest as (img: CapturedFrame) => void;
    this.captureRequest = null;
    const { width, height } = tex;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buf = this.gpu.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow }, [width, height]);
    const bgra = tex.format === "bgra8unorm";
    this.captureReadback = () => {
      buf.mapAsync(GPUMapMode.READ).then(() => {
        const src = new Uint8Array(buf.getMappedRange());
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const s = y * bytesPerRow + x * 4;
            const d = (y * width + x) * 4;
            data[d] = src[bgra ? s + 2 : s] as number;
            data[d + 1] = src[s + 1] as number;
            data[d + 2] = src[bgra ? s : s + 2] as number;
            data[d + 3] = 255;
          }
        }
        buf.unmap();
        buf.destroy();
        resolve({ width, height, data });
      });
    };
  }
}
