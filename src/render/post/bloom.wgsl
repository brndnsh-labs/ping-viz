// Bloom mip chain (Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare"):
// 13-tap downsamples, then 3x3 tent upsamples added back up the chain. The first level is built by
// prefilter.wgsl, which also mixes the two scene slots during a crossfade.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VO;
  o.pos = vec4f(p, 0.0, 1.0);
  o.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return o;
}

fn tap(uv: vec2f) -> vec3f {
  return textureSampleLevel(src, samp, uv, 0.0).rgb;
}

fn down13(uv: vec2f) -> vec3f {
  let t = 1.0 / vec2f(textureDimensions(src));
  let a = tap(uv + t * vec2f(-2.0, -2.0));
  let b = tap(uv + t * vec2f(0.0, -2.0));
  let c = tap(uv + t * vec2f(2.0, -2.0));
  let d = tap(uv + t * vec2f(-1.0, -1.0));
  let e = tap(uv + t * vec2f(1.0, -1.0));
  let f = tap(uv + t * vec2f(-2.0, 0.0));
  let g = tap(uv);
  let h = tap(uv + t * vec2f(2.0, 0.0));
  let i = tap(uv + t * vec2f(-1.0, 1.0));
  let j = tap(uv + t * vec2f(1.0, 1.0));
  let k = tap(uv + t * vec2f(-2.0, 2.0));
  let l = tap(uv + t * vec2f(0.0, 2.0));
  let m = tap(uv + t * vec2f(2.0, 2.0));
  return (d + e + i + j) * 0.125 + (a + b + f + g) * 0.03125 + (b + c + g + h) * 0.03125 +
    (f + g + k + l) * 0.03125 + (g + h + l + m) * 0.03125;
}

@fragment
fn fs_down(in: VO) -> @location(0) vec4f {
  return vec4f(down13(in.uv), 1.0);
}

// Upsample the smaller level with a tent filter; the pipeline blends it onto the larger one.
@fragment
fn fs_up(in: VO) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var s = tap(in.uv) * 4.0;
  s += (tap(in.uv + vec2f(t.x, 0.0)) + tap(in.uv - vec2f(t.x, 0.0)) + tap(in.uv + vec2f(0.0, t.y)) +
    tap(in.uv - vec2f(0.0, t.y))) * 2.0;
  s += tap(in.uv + t) + tap(in.uv - t) + tap(in.uv + vec2f(t.x, -t.y)) + tap(in.uv + vec2f(-t.x, t.y));
  return vec4f(s / 16.0, 1.0);
}
