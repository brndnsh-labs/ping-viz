// Ray-traced sphere impostors on camera-facing quads: exact silhouettes and depth at any size.
// Entry points: fs_solid (opaque, writes depth), fs_halo (additive glow outside the silhouette),
// fs_glass (additive rim-lit shell, no depth write).

struct SphereInst {
  center: vec3f,
  radius: f32,
  // rgb: emissive surface colour; a: intensity.
  fill: vec4f,
  // rgb: rim colour; a: rim exponent (higher = thinner rim).
  rim: vec4f,
  // rgb: halo colour; a: halo width as a fraction of the radius.
  halo: vec4f,
}

@group(1) @binding(0) var<storage, read> spheres: array<SphereInst>;
@group(1) @binding(1) var<uniform> batch: Batch;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) @interpolate(flat) id: u32,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let s = spheres[ii];
  let reach = s.radius * (1.0 + max(s.halo.a, 0.0) * 3.0);
  let d = length(s.center - cam.eye);
  // Grow the quad so the perspective silhouette (wider than the radius up close) stays covered.
  let grow = min(d / sqrt(max(d * d - reach * reach, 1e-6 * d * d)), 4.0) * 1.15;
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let c = corners[vi] * reach * grow;
  let world = s.center + cam.right * c.x + cam.up * c.y;
  o.pos = toClip(world);
  o.world = world;
  o.id = ii;
  return o;
}

struct Hit {
  hit: bool,
  p: vec3f,
  n: vec3f,
  nv: f32,
  // Perpendicular distance from the centre to the ray (for halos).
  perp: f32,
}

fn trace(s: SphereInst, world: vec3f) -> Hit {
  var h: Hit;
  let rd = normalize(world - cam.eye);
  let oc = cam.eye - s.center;
  let b = dot(oc, rd);
  let c = dot(oc, oc) - s.radius * s.radius;
  let disc = b * b - c;
  h.perp = sqrt(max(dot(oc, oc) - b * b, 0.0));
  h.hit = disc >= 0.0 && -b > 0.0;
  if (h.hit) {
    let t = -b - sqrt(disc);
    h.p = cam.eye + rd * t;
    h.n = normalize(h.p - s.center);
    h.nv = max(dot(h.n, -rd), 0.0);
  }
  return h;
}

struct SolidOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fs_solid(in: VO) -> SolidOut {
  let s = spheres[in.id];
  let h = trace(s, in.world);
  if (!h.hit) {
    discard;
  }
  var o: SolidOut;
  let base = s.fill.rgb * s.fill.a * (0.35 + 0.65 * h.nv);
  let rim = s.rim.rgb * pow(1.0 - h.nv, max(s.rim.a, 0.5));
  o.color = vec4f((base + rim) * batch.misc.x, 1.0);
  let c = toClip(h.p);
  o.depth = clamp(c.z / c.w, 0.0, 1.0);
  return o;
}

@fragment
fn fs_halo(in: VO) -> @location(0) vec4f {
  let s = spheres[in.id];
  let h = trace(s, in.world);
  if (h.hit || s.halo.a <= 0.0) {
    discard;
  }
  let x = max(h.perp - s.radius, 0.0) / (s.radius * s.halo.a);
  let g = exp(-x * 2.2) * smoothstep(0.0, 0.02, x + 0.02);
  return vec4f(s.halo.rgb * g * batch.misc.x, 0.0);
}

@fragment
fn fs_glass(in: VO) -> @location(0) vec4f {
  let s = spheres[in.id];
  let h = trace(s, in.world);
  if (!h.hit) {
    discard;
  }
  let body = s.fill.rgb * s.fill.a * (0.25 + 0.75 * h.nv * h.nv);
  let rim = s.rim.rgb * pow(1.0 - h.nv, max(s.rim.a, 0.5));
  return vec4f((body + rim) * batch.misc.x, 0.0);
}
