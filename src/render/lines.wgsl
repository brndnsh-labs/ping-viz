// Glowing polylines. Vertices live in a storage buffer; each instance draws the segment from
// vertex i to i+1 as a screen-space quad, mitred against its neighbours so joints don't overlap
// (overlap would double the brightness under additive blending). Free ends get round caps.

struct LineVertex {
  pos: vec3f,
  // Arc length along the polyline (scene units).
  s: f32,
  // rgb: HDR colour; a: base brightness (0 leaves only pulses/flow visible).
  color: vec4f,
  // Core width in px.
  width: f32,
  // Halo radius in px.
  glow: f32,
  // > 0.5: no segment from this vertex to the next.
  brk: f32,
  opacity: f32,
  // x: head position (s), y: trail length (s), z: intensity, w: head flare.
  pulse: vec4f,
  // x: dash period (s), y: speed (s per clock second), z: duty (0..1), w: intensity.
  flow: vec4f,
}

@group(1) @binding(0) var<storage, read> verts: array<LineVertex>;
@group(1) @binding(1) var<uniform> batch: Batch;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
  // Screen-space px: x across the line from its centre, y along it from the segment start.
  @location(1) @interpolate(linear) uv: vec2f,
  @location(2) s: f32,
  // x: half width, y: glow, z: brightness scale, w: base level
  @location(3) @interpolate(flat) widths: vec4f,
  @location(4) @interpolate(flat) pulse: vec4f,
  @location(5) @interpolate(flat) flow: vec4f,
  // x: segment length px, y: start is a free end, z: finish is a free end
  @location(6) @interpolate(flat) ends: vec3f,
}

fn screenOf(c: vec4f) -> vec2f {
  return c.xy / c.w * 0.5 * cam.viewport;
}

fn perp(d: vec2f) -> vec2f {
  return vec2f(-d.y, d.x);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  let count = u32(batch.misc.w);
  if (ii + 1u >= count) {
    return o;
  }
  let a = verts[ii];
  let b = verts[ii + 1u];
  if (a.brk > 0.5 || a.opacity <= 0.0) {
    return o;
  }
  var c0 = toClip(a.pos);
  var c1 = toClip(b.pos);
  var s0 = a.s;
  var s1 = b.s;
  let wmin = cam.near * 1.05;
  if (c0.w < wmin && c1.w < wmin) {
    return o;
  }
  var clipped0 = false;
  var clipped1 = false;
  if (c0.w < wmin) {
    let t = (wmin - c0.w) / (c1.w - c0.w);
    c0 = mix(c0, c1, t);
    s0 = mix(s0, s1, t);
    clipped0 = true;
  }
  if (c1.w < wmin) {
    let t = (wmin - c1.w) / (c0.w - c1.w);
    c1 = mix(c1, c0, t);
    s1 = mix(s1, s0, t);
    clipped1 = true;
  }
  let p0 = screenOf(c0);
  let p1 = screenOf(c1);
  let seg = p1 - p0;
  let len = length(seg);
  let d = select(vec2f(1.0, 0.0), seg / len, len > 1e-4);
  let n = perp(d);

  // Thin lines keep a 1 px core and dim instead, so they don't shimmer.
  let w = max(a.width, 0.0) * cam.pxScale;
  let halfW = max(w * 0.5, 0.5);
  let thin = min(w, 1.0);
  let glow = max(a.glow, 0.0) * cam.pxScale;
  let extent = halfW + glow + 1.0;

  // Mitre at each end: unit direction and length factor.
  var n0 = n;
  var m0 = 1.0;
  var free0 = true;
  if (ii > 0u && !clipped0) {
    let pv = verts[ii - 1u];
    if (pv.brk < 0.5) {
      let cp = toClip(pv.pos);
      if (cp.w > wmin) {
        let dp = p0 - screenOf(cp);
        let lp = length(dp);
        if (lp > 1e-4) {
          let nm = normalize(perp(dp / lp) + n);
          n0 = nm;
          m0 = 1.0 / max(dot(nm, n), 0.35);
        }
        free0 = false;
      }
    }
  }
  var n1 = n;
  var m1 = 1.0;
  var free1 = true;
  if (ii + 2u < count && b.brk < 0.5 && !clipped1) {
    let cn = toClip(verts[ii + 2u].pos);
    if (cn.w > wmin) {
      let dn = screenOf(cn) - p1;
      let ln = length(dn);
      if (ln > 1e-4) {
        let nm = normalize(perp(dn / ln) + n);
        n1 = nm;
        m1 = 1.0 / max(dot(nm, n), 0.35);
      }
      free1 = false;
    }
  }

  // Two triangles: (end, side) per corner.
  var ends = array<u32, 6>(0u, 1u, 0u, 0u, 1u, 1u);
  var sides = array<f32, 6>(-1.0, -1.0, 1.0, 1.0, -1.0, 1.0);
  let end = ends[vi];
  let side = sides[vi];
  var p: vec2f;
  var c: vec4f;
  if (end == 0u) {
    p = p0 + n0 * (side * extent * m0);
    if (free0) {
      p -= d * extent;
    }
    c = c0;
    o.s = s0;
    o.color = a.color.rgb;
  } else {
    p = p1 + n1 * (side * extent * m1);
    if (free1) {
      p += d * extent;
    }
    c = c1;
    o.s = s1;
    o.color = b.color.rgb;
  }
  o.pos = vec4f(p / (0.5 * cam.viewport) * c.w, c.z, c.w);
  o.uv = vec2f(dot(p - p0, n), dot(p - p0, d));
  o.widths = vec4f(halfW, glow, a.opacity * batch.misc.x * thin, a.color.a);
  o.pulse = a.pulse;
  o.flow = a.flow;
  o.ends = vec3f(len, select(0.0, 1.0, free0), select(0.0, 1.0, free1));
  return o;
}

fn pulseAt(s: f32, p: vec4f) -> f32 {
  if (p.z <= 0.0) {
    return 0.0;
  }
  let behind = p.x - s;
  let trail = max(p.y, 1e-6);
  var m = 0.0;
  if (behind >= 0.0 && behind <= trail) {
    let t = 1.0 - behind / trail;
    m = t * t;
  }
  let head = trail * 0.05 + 1e-6;
  m += p.w * exp(-(behind * behind) / (head * head));
  return m * p.z;
}

fn flowAt(s: f32, f: vec4f) -> f32 {
  if (f.w <= 0.0 || f.x <= 0.0) {
    return 0.0;
  }
  let ph = fract((s - batch.misc.y * f.y) / f.x);
  let on = smoothstep(0.0, 0.06, ph) * (1.0 - smoothstep(f.z, f.z + 0.06, ph));
  return on * f.w;
}

@fragment
fn fs(in: VO) -> @location(0) vec4f {
  var beyond = 0.0;
  if (in.ends.y > 0.5) {
    beyond = max(beyond, -in.uv.y);
  }
  if (in.ends.z > 0.5) {
    beyond = max(beyond, in.uv.y - in.ends.x);
  }
  let r = length(vec2f(in.uv.x, beyond));
  let halfW = in.widths.x;
  let core = 1.0 - smoothstep(halfW - 0.6, halfW + 0.6, r);
  var halo = 0.0;
  if (in.widths.y > 0.0) {
    let g = max(r - halfW, 0.0) / in.widths.y;
    halo = exp(-g * g * 3.0) * 0.45;
  }
  let level = in.widths.w + pulseAt(in.s, in.pulse) + flowAt(in.s, in.flow);
  return vec4f(in.color * (level * (core + halo) * in.widths.z), 0.0);
}
