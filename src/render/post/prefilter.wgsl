// First bloom level: a 13-tap downsample of the weighted sum of both scene slots, with single-pixel
// extremes tamed so tiny hot spots glow without strobing as they cross pixels.

@group(0) @binding(0) var srcA: texture_2d<f32>;
@group(0) @binding(1) var srcB: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> mixw: vec4f; // x: slot A weight, y: slot B weight

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
  var c = textureSampleLevel(srcA, samp, uv, 0.0).rgb * mixw.x;
  if (mixw.y > 0.0) {
    c += textureSampleLevel(srcB, samp, uv, 0.0).rgb * mixw.y;
  }
  return c;
}

@fragment
fn fs(in: VO) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(srcA));
  let a = tap(in.uv + t * vec2f(-2.0, -2.0));
  let b = tap(in.uv + t * vec2f(0.0, -2.0));
  let c = tap(in.uv + t * vec2f(2.0, -2.0));
  let d = tap(in.uv + t * vec2f(-1.0, -1.0));
  let e = tap(in.uv + t * vec2f(1.0, -1.0));
  let f = tap(in.uv + t * vec2f(-2.0, 0.0));
  let g = tap(in.uv);
  let h = tap(in.uv + t * vec2f(2.0, 0.0));
  let i = tap(in.uv + t * vec2f(-1.0, 1.0));
  let j = tap(in.uv + t * vec2f(1.0, 1.0));
  let k = tap(in.uv + t * vec2f(-2.0, 2.0));
  let l = tap(in.uv + t * vec2f(0.0, 2.0));
  let m = tap(in.uv + t * vec2f(2.0, 2.0));
  let s = (d + e + i + j) * 0.125 + (a + b + f + g) * 0.03125 + (b + c + g + h) * 0.03125 +
    (f + g + k + l) * 0.03125 + (g + h + l + m) * 0.03125;
  let mx = max(s.r, max(s.g, s.b));
  // Keep non-finite samples out of the bloom chain: blurred, one bad pixel becomes a black block.
  // Test the sum, not mx: max() returns the other operand when one of them is NaN.
  if (!(s.r + s.g + s.b < 1.0e30)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  return vec4f(s * min(1.0, 60.0 / max(mx, 1e-6)), 1.0);
}
