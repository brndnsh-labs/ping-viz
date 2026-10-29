// Instanced boxes with glowing edges: a dark emissive fill and a px-width edge line drawn in the
// fragment shader. `getBox` is the instance source (storage buffer by default, or a scene's WGSL).

struct BoxInst {
  center: vec3f,
  // Radians around +y.
  yaw: f32,
  half: vec3f,
  // Edge line width in px (0: no edges).
  edgePx: f32,
  // rgb: HDR edge colour; a: intensity.
  edge: vec4f,
  // rgb: emissive face colour; a: face intensity.
  fill: vec4f,
}

@group(1) @binding(0) var<storage, read> boxes: array<BoxInst>;
@group(1) @binding(1) var<uniform> batch: Batch;

//HOOK

const CUBE = array<u32, 36>(
  5u, 1u, 3u, 5u, 3u, 7u,
  0u, 4u, 6u, 0u, 6u, 2u,
  6u, 7u, 3u, 6u, 3u, 2u,
  0u, 1u, 5u, 0u, 5u, 4u,
  4u, 5u, 7u, 4u, 7u, 6u,
  1u, 0u, 2u, 1u, 2u, 3u,
);
const NORMALS = array<vec3f, 6>(
  vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0),
  vec3f(0.0, 1.0, 0.0), vec3f(0.0, -1.0, 0.0),
  vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0),
);

struct VO {
  @builtin(position) pos: vec4f,
  // Position on the unit cube ([-1, 1]^3).
  @location(0) q: vec3f,
  @location(1) @interpolate(flat) half: vec3f,
  @location(2) @interpolate(flat) edge: vec4f,
  @location(3) @interpolate(flat) fill: vec4f,
  // xyz: world normal, w: edge px
  @location(4) @interpolate(flat) nrm: vec4f,
  @location(5) world: vec3f,
  @location(6) @interpolate(flat) face: u32,
}

fn rotY(v: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  let b = getBox(ii);
  if (b.edge.a <= 0.0 && b.fill.a <= 0.0) {
    return o;
  }
  let k = CUBE[vi];
  let q = vec3f(
    select(-1.0, 1.0, (k & 1u) != 0u),
    select(-1.0, 1.0, (k & 2u) != 0u),
    select(-1.0, 1.0, (k & 4u) != 0u),
  );
  let world = b.center + rotY(q * b.half, b.yaw);
  o.pos = toClip(world);
  o.q = q;
  o.half = b.half;
  o.edge = vec4f(b.edge.rgb * b.edge.a * batch.misc.x, b.edge.a);
  o.fill = vec4f(b.fill.rgb * b.fill.a * batch.misc.x, b.fill.a);
  let face = vi / 6u;
  o.nrm = vec4f(rotY(NORMALS[face], b.yaw), b.edgePx * cam.pxScale);
  o.world = world;
  o.face = face;
  return o;
}

@fragment
fn fs(in: VO) -> @location(0) vec4f {
  // The two in-face axes of this fragment's face.
  let axis = in.face / 2u;
  var qa: f32;
  var qb: f32;
  var ha: f32;
  var hb: f32;
  if (axis == 0u) {
    qa = in.q.y;
    qb = in.q.z;
    ha = in.half.y;
    hb = in.half.z;
  } else if (axis == 1u) {
    qa = in.q.x;
    qb = in.q.z;
    ha = in.half.x;
    hb = in.half.z;
  } else {
    qa = in.q.x;
    qb = in.q.y;
    ha = in.half.x;
    hb = in.half.y;
  }
  let da = (1.0 - abs(qa)) * ha;
  let db = (1.0 - abs(qb)) * hb;
  let daPx = da / max(fwidth(da), 1e-7);
  let dbPx = db / max(fwidth(db), 1e-7);
  // With MSAA, a sliver or sub-pixel face can be shaded at a pixel centre outside it, where these
  // extrapolated distances go hugely negative (or non-finite). Unclamped, exp() below overflows,
  // 0 * inf = NaN, and bloom smears that one pixel into a black block.
  let e = clamp(min(daPx, dbPx), 0.0, 1.0e4);
  let w = in.nrm.w;
  var edge = 0.0;
  if (w > 0.0) {
    edge = 1.0 - smoothstep(w * 0.5 - 0.6, w * 0.5 + 0.6, e);
    // A tight inner glow: wide ones wash small or foreshortened faces out to grey.
    edge += exp(-e / (w * 1.2 + 0.8)) * 0.12;
  }
  let v = normalize(cam.eye - in.world);
  let facing = abs(dot(in.nrm.xyz, v));
  let shade = 0.5 + 0.5 * facing + select(0.0, 0.18, in.nrm.y > 0.5);
  let rgb = in.fill.rgb * shade + in.edge.rgb * edge;
  return vec4f(rgb, 1.0);
}
