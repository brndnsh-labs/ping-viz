// Camera-facing glowing points. `getPoint` is the instance source: by default it reads the storage
// buffer, and a scene can swap in its own WGSL (procedural placement, animation) instead.

struct PointInst {
  pos: vec3f,
  // World-space core diameter; 0 uses `px` instead.
  size: f32,
  // rgb: HDR colour; a: intensity (0 skips the point).
  color: vec4f,
  // Fixed core diameter in px (when size == 0).
  px: f32,
  // Smallest drawn diameter in px; smaller points dim instead of shrinking (keeps their energy).
  minPx: f32,
  // Halo radius as a multiple of the core radius.
  glow: f32,
  // 0: soft blob, 1: hard disc, 2: ring.
  shape: f32,
}

@group(1) @binding(0) var<storage, read> pts: array<PointInst>;
@group(1) @binding(1) var<uniform> batch: Batch;

//HOOK

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
  @location(1) @interpolate(linear) uv: vec2f,
  // x: core radius px, y: halo radius px, z: shape
  @location(2) @interpolate(flat) rr: vec3f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  let p = getPoint(ii);
  if (p.color.a <= 0.0) {
    return o;
  }
  let c = toClip(p.pos);
  if (c.w < cam.near) {
    return o;
  }
  var dpx = p.px * cam.pxScale;
  if (p.size > 0.0) {
    dpx = p.size * cam.pxPerUnit / c.w;
  }
  // Optional per-batch cap (batch.user[0].x, CSS px): zoomed-in dots stay dots instead of blobs.
  let maxPx = batch.user[0].x * cam.pxScale;
  if (maxPx > 0.0) {
    dpx = min(dpx, maxPx);
  }
  var gain = 1.0;
  let minPx = max(p.minPx * cam.pxScale, 0.75);
  if (dpx < minPx) {
    let k = dpx / minPx;
    gain = k * k;
    dpx = minPx;
  }
  let r = dpx * 0.5;
  let glowR = max(p.glow, 0.0) * r;
  let ext = r + glowR + 1.0;
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let off = corners[vi] * ext;
  o.pos = vec4f(c.xy + off / (0.5 * cam.viewport) * c.w, c.z, c.w);
  o.uv = off;
  o.color = p.color.rgb * (p.color.a * gain * batch.misc.x);
  o.rr = vec3f(r, glowR, p.shape);
  return o;
}

@fragment
fn fs(in: VO) -> @location(0) vec4f {
  let d = length(in.uv);
  let r = in.rr.x;
  var core: f32;
  if (in.rr.z < 0.5) {
    core = exp(-(d * d) / (r * r) * 1.6);
  } else if (in.rr.z < 1.5) {
    core = 1.0 - smoothstep(r - 0.7, r + 0.7, d);
  } else {
    let w = max(r * 0.16, 0.6);
    core = 1.0 - smoothstep(w - 0.7, w + 0.7, abs(d - r * 0.84));
  }
  var halo = 0.0;
  if (in.rr.y > 0.0) {
    let g = max(d - r, 0.0) / in.rr.y;
    halo = exp(-g * g * 3.0) * 0.35;
  }
  return vec4f(in.color * (core + halo), 0.0);
}
