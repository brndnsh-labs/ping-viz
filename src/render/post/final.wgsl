// Final pass at canvas resolution: mix the scene slots (crossfades), upscale if the scene was
// rendered smaller (Catmull-Rom), lay the scene over a faint background, add bloom, tone map with
// AgX and a punchy look, vignette, encode for the canvas colour space, then grain and dither.
// Expects `const OUT_P3: bool` prepended.

@group(0) @binding(0) var hdrA: texture_2d<f32>;
@group(0) @binding(1) var hdrB: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> post: Post;

struct Post {
  // x: slot A weight, y: slot B weight, z: bloom strength, w: exposure
  mixw: vec4f,
  // x: vignette, y: grain, z: saturation, w: look power
  look: vec4f,
  // rgb: background colour at the focus, w: frame index
  bg0: vec4f,
  // rgb: background colour at the edges, w: bloom normalisation
  bg1: vec4f,
  // xy: focus point (uv), z: aspect, w: unused
  focus: vec4f,
}

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

const LUMA = vec3f(0.2126, 0.7152, 0.0722);

// Catmull-Rom from 5 bilinear taps.
fn catmullRom(tex: texture_2d<f32>, uv: vec2f, size: vec2f) -> vec3f {
  let sp = uv * size;
  let t1 = floor(sp - 0.5) + 0.5;
  let f = sp - t1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let t12 = (t1 + w2 / w12) / size;
  let t0 = (t1 - 1.0) / size;
  let t3 = (t1 + 2.0) / size;
  var c = textureSampleLevel(tex, samp, vec2f(t12.x, t0.y), 0.0).rgb * (w12.x * w0.y);
  c += textureSampleLevel(tex, samp, vec2f(t0.x, t12.y), 0.0).rgb * (w0.x * w12.y);
  c += textureSampleLevel(tex, samp, t12, 0.0).rgb * (w12.x * w12.y);
  c += textureSampleLevel(tex, samp, vec2f(t3.x, t12.y), 0.0).rgb * (w3.x * w12.y);
  c += textureSampleLevel(tex, samp, vec2f(t12.x, t3.y), 0.0).rgb * (w12.x * w3.y);
  let norm = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(c / norm, vec3f(0.0));
}

fn sceneAt(tex: texture_2d<f32>, uv: vec2f, size: vec2f, exact: bool) -> vec3f {
  if (exact) {
    return textureLoad(tex, vec2i(uv * size), 0).rgb;
  }
  return catmullRom(tex, uv, size);
}

// AgX (Sobotka), minimal fit by Wrensch.
const AGX_IN = mat3x3f(
  vec3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051),
  vec3f(0.0784335999999992, 0.878468636469772, 0.0784336),
  vec3f(0.0792237451477643, 0.0791661274605434, 0.879142973793104),
);
const AGX_OUT = mat3x3f(
  vec3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438),
  vec3f(-0.0980208811401368, 1.15190312990417, -0.0980434501171241),
  vec3f(-0.0990297440797205, -0.0989611768448433, 1.15107367264116),
);
const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;

fn agxCurve(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

const SRGB_TO_P3 = mat3x3f(
  vec3f(0.8224621, 0.0331941, 0.0170827),
  vec3f(0.177538, 0.9668058, 0.0723974),
  vec3f(0.0, 0.0, 0.9105199),
);

fn encodeSrgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

fn hash(p: vec2f, n: u32) -> f32 {
  var q = vec3u(vec2u(p), n);
  q = q * 1664525u + 1013904223u;
  q.x += q.y * q.z;
  q.y += q.z * q.x;
  q.z += q.x * q.y;
  q ^= q >> vec3u(16u);
  q.x += q.y * q.z;
  return f32(q.x) * (1.0 / 4294967296.0);
}

@fragment
fn fs(in: VO) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(hdrA));
  let exact = abs(fwidth(in.uv.x) * size.x - 1.0) < 0.002;
  var c = sceneAt(hdrA, in.uv, size, exact) * post.mixw.x;
  if (post.mixw.y > 0.0) {
    c += sceneAt(hdrB, in.uv, size, exact) * post.mixw.y;
  }
  // A non-finite scene pixel (see boxes.wgsl) shows as black rather than as garbage.
  if (!(dot(c, c) < 1.0e30)) {
    c = vec3f(0.0);
  }

  // A faint, deep-blue field with a soft lift around the subject.
  let q = (in.uv - post.focus.xy) * vec2f(post.focus.z, 1.0);
  let r = length(q);
  let bg = mix(post.bg0.rgb, post.bg1.rgb, smoothstep(0.0, 1.1, r));
  c += bg;

  let bloom = textureSampleLevel(bloomTex, samp, in.uv, 0.0).rgb * post.bg1.w;
  c = (c + bloom * post.mixw.z) * post.mixw.w;

  // AgX with a punchy look: neon on black wants saturated highlights.
  var x = AGX_IN * max(c, vec3f(0.0));
  x = (clamp(log2(max(x, vec3f(1e-10))), vec3f(AGX_MIN_EV), vec3f(AGX_MAX_EV)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
  x = agxCurve(x);
  x = pow(max(x, vec3f(0.0)), vec3f(post.look.w));
  let l = dot(x, LUMA);
  x = l + post.look.z * (x - l);
  var lin = pow(max(AGX_OUT * x, vec3f(0.0)), vec3f(2.2));

  let vq = (in.uv - 0.5) * vec2f(1.0, 0.85);
  lin *= 1.0 - post.look.x * smoothstep(0.1, 0.8, dot(vq, vq) * 2.0);

  if (OUT_P3) {
    lin = SRGB_TO_P3 * lin;
  }
  var e = encodeSrgb(clamp(lin, vec3f(0.0), vec3f(1.0)));
  let n = u32(post.bg0.w);
  let grain = (hash(in.pos.xy, n) + hash(in.pos.xy + 17.0, n) - 1.0) * post.look.y;
  e += grain * (1.0 - abs(dot(e, LUMA) * 2.0 - 1.0) * 0.6);
  e += (hash(in.pos.xy, n + 7919u) + hash(in.pos.xy + 31.0, n + 104729u) - 1.0) / 255.0;
  return vec4f(e, 1.0);
}
