import bloomWgsl from "./bloom.wgsl?raw";
import finalWgsl from "./final.wgsl?raw";
import prefilterWgsl from "./prefilter.wgsl?raw";

const BLOOM_FORMAT: GPUTextureFormat = "rgba16float";
const MAX_BLOOM_LEVELS = 7;
/** Each coarser level is added back at this weight: higher keeps a wider glow. */
const BLOOM_FALLOFF = 0.82;

export interface PostParams {
  /** Weights of scene slot A and B (a crossfade). */
  weightA: number;
  weightB: number;
  bloom: number;
  exposure: number;
  vignette: number;
  grain: number;
  saturation: number;
  power: number;
  bgFocus: [number, number, number];
  bgEdge: [number, number, number];
  /** Background focus in uv. */
  focus: [number, number];
  /** Canvas width / height (keeps the background lift round). */
  aspect: number;
  frame: number;
}

export interface PostModule {
  resize(width: number, height: number): void;
  encode(encoder: GPUCommandEncoder, a: GPUTextureView, b: GPUTextureView, out: GPUTextureView, p: PostParams): void;
  destroy(): void;
}

export function createPost(
  device: GPUDevice,
  outputFormat: GPUTextureFormat,
  colorSpace: PredefinedColorSpace,
): PostModule {
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

  // Bloom chain (down/up).
  const bloomModule = device.createShaderModule({ label: "post-bloom", code: bloomWgsl });
  const bloomLayout = device.createBindGroupLayout({
    label: "post-bloom",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const bloomPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bloomLayout] });
  const bloomPipeline = (entryPoint: string, blend?: GPUBlendState): GPURenderPipeline =>
    device.createRenderPipeline({
      label: `post-${entryPoint}`,
      layout: bloomPipelineLayout,
      vertex: { module: bloomModule, entryPoint: "vs" },
      fragment: { module: bloomModule, entryPoint, targets: [{ format: BLOOM_FORMAT, blend }] },
    });
  const down = bloomPipeline("fs_down");
  const up = bloomPipeline("fs_up", {
    color: { srcFactor: "constant", dstFactor: "one", operation: "add" },
    alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
  });

  // Prefilter (mixes both slots).
  const mixBuffer = device.createBuffer({
    label: "post-mix",
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const preModule = device.createShaderModule({ label: "post-prefilter", code: prefilterWgsl });
  const preLayout = device.createBindGroupLayout({
    label: "post-prefilter",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
    ],
  });
  const prefilter = device.createRenderPipeline({
    label: "post-prefilter",
    layout: device.createPipelineLayout({ bindGroupLayouts: [preLayout] }),
    vertex: { module: preModule, entryPoint: "vs" },
    fragment: { module: preModule, entryPoint: "fs", targets: [{ format: BLOOM_FORMAT }] },
  });

  // Final.
  const p3 = colorSpace === "display-p3";
  const finalModule = device.createShaderModule({
    label: "post-final",
    code: `const OUT_P3: bool = ${p3};\n${finalWgsl}`,
  });
  const finalLayout = device.createBindGroupLayout({
    label: "post-final",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
    ],
  });
  const finalPipeline = device.createRenderPipeline({
    label: "post-final",
    layout: device.createPipelineLayout({ bindGroupLayouts: [finalLayout] }),
    vertex: { module: finalModule, entryPoint: "vs" },
    fragment: { module: finalModule, entryPoint: "fs", targets: [{ format: outputFormat }] },
  });
  const params = device.createBuffer({
    label: "post-params",
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const paramData = new Float32Array(20);

  interface Level {
    tex: GPUTexture;
    view: GPUTextureView;
    group: GPUBindGroup;
  }
  let levels: Level[] = [];
  let norm = 1;
  let cache: { a: GPUTextureView; b: GPUTextureView; pre: GPUBindGroup; final: GPUBindGroup } | null = null;

  const sampling = (view: GPUTextureView): GPUBindGroup =>
    device.createBindGroup({
      layout: bloomLayout,
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: sampler },
      ],
    });

  const run = (
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    pipeline: GPURenderPipeline,
    group: GPUBindGroup,
    load: GPULoadOp,
    constant?: number,
  ): void => {
    const p = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: load, storeOp: "store", clearValue: [0, 0, 0, 1] }],
    });
    p.setPipeline(pipeline);
    p.setBindGroup(0, group);
    if (constant !== undefined) p.setBlendConstant([constant, constant, constant, 1]);
    p.draw(3);
    p.end();
  };

  return {
    resize: (width, height) => {
      for (const l of levels) l.tex.destroy();
      levels = [];
      let w = Math.max(1, Math.ceil(width / 2));
      let h = Math.max(1, Math.ceil(height / 2));
      for (let i = 0; i < MAX_BLOOM_LEVELS && Math.min(w, h) >= 4; i++) {
        const tex = device.createTexture({
          label: `post-bloom-${i}`,
          size: [w, h],
          format: BLOOM_FORMAT,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const view = tex.createView();
        levels.push({ tex, view, group: sampling(view) });
        w = Math.max(1, Math.ceil(w / 2));
        h = Math.max(1, Math.ceil(h / 2));
      }
      norm = 0;
      for (let i = 0; i < levels.length; i++) norm += BLOOM_FALLOFF ** i;
      norm = 1 / Math.max(norm, 1);
      cache = null;
    },
    encode: (encoder, a, b, out, p) => {
      const first = levels[0];
      if (!first) return;
      if (!cache || cache.a !== a || cache.b !== b) {
        cache = {
          a,
          b,
          pre: device.createBindGroup({
            layout: preLayout,
            entries: [
              { binding: 0, resource: a },
              { binding: 1, resource: b },
              { binding: 2, resource: sampler },
              { binding: 3, resource: { buffer: mixBuffer } },
            ],
          }),
          final: device.createBindGroup({
            layout: finalLayout,
            entries: [
              { binding: 0, resource: a },
              { binding: 1, resource: b },
              { binding: 2, resource: first.view },
              { binding: 3, resource: sampler },
              { binding: 4, resource: { buffer: params } },
            ],
          }),
        };
      }
      device.queue.writeBuffer(mixBuffer, 0, new Float32Array([p.weightA, p.weightB, 0, 0]));
      const d = paramData;
      d.set([p.weightA, p.weightB, p.bloom, p.exposure], 0);
      d.set([p.vignette, p.grain, p.saturation, p.power], 4);
      d.set([...p.bgFocus, p.frame % 65536], 8);
      d.set([...p.bgEdge, norm], 12);
      d.set([p.focus[0], p.focus[1], p.aspect, 0], 16);
      device.queue.writeBuffer(params, 0, d);

      run(encoder, first.view, prefilter, cache.pre, "clear");
      for (let i = 1; i < levels.length; i++) {
        run(encoder, (levels[i] as Level).view, down, (levels[i - 1] as Level).group, "clear");
      }
      for (let i = levels.length - 2; i >= 0; i--) {
        run(encoder, (levels[i] as Level).view, up, (levels[i + 1] as Level).group, "load", BLOOM_FALLOFF);
      }
      const pass = encoder.beginRenderPass({
        label: "post-final",
        colorAttachments: [{ view: out, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
      });
      pass.setPipeline(finalPipeline);
      pass.setBindGroup(0, cache.final);
      pass.draw(3);
      pass.end();
    },
    destroy: () => {
      for (const l of levels) l.tex.destroy();
      params.destroy();
      mixBuffer.destroy();
    },
  };
}
