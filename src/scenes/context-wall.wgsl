// The request as a wall of tokens. One instance per token; where it sits, what colour it is and every
// animation come from the instance index and a few uniforms, so nothing is rebuilt on the CPU.
//
// context.ts prepends constants generated from its own tables (so the labels and the tiles can't
// disagree): W_N (tokens), W_E0..W_E4 (section ends), W_C0..W_C5 (colours), W_G0..W_G5 (brightness),
// W_CACHE, and the packet stream (W_NP, W_PCOLS, W_PROWS, W_STAG, W_FORM, W_V, W_DIR).
//
// batch.user slots (vec4 each):
//   [0] x: tile size cap in px (PointBatch.maxPx)  y: columns  z: pitch (scene units)  w: ghost level
//   [1] x: build front (rows)  y: your message landing 0..1  z: breakpoint gap 0..1  w: cache sweep 0..1
//   [2] x: cache shimmer 0..1  y: dim the prefix 0..1  z: caption scrim row  w: scrim strength 0..1
//   [3] x: stream progress     y: nozzle x   z: nozzle y   w: scrim half height (rows)
// batch.misc.y is the ambient clock (0 with reduced motion).

fn wallSection(i: u32) -> u32 {
  return select(0u, 1u, i >= W_E0) + select(0u, 1u, i >= W_E1) + select(0u, 1u, i >= W_E2) +
    select(0u, 1u, i >= W_E3) + select(0u, 1u, i >= W_E4);
}

fn wallColor(s: u32) -> vec3f {
  var c = W_C0;
  c = select(c, W_C1, s == 1u);
  c = select(c, W_C2, s == 2u);
  c = select(c, W_C3, s == 3u);
  c = select(c, W_C4, s == 4u);
  c = select(c, W_C5, s == 5u);
  return c;
}

fn wallGain(s: u32) -> f32 {
  var g = W_G0;
  g = select(g, W_G1, s == 1u);
  g = select(g, W_G2, s == 2u);
  g = select(g, W_G3, s == 3u);
  g = select(g, W_G4, s == 4u);
  g = select(g, W_G5, s == 5u);
  return g;
}

// Index of the first token after section s (s < 5).
fn wallEnd(s: u32) -> u32 {
  var e = W_E0;
  e = select(e, W_E1, s == 1u);
  e = select(e, W_E2, s == 2u);
  e = select(e, W_E3, s == 3u);
  e = select(e, W_E4, s == 4u);
  return e;
}

fn getPoint(i: u32) -> PointInst {
  var p: PointInst;
  p.pos = vec3f(0.0);
  p.size = 0.0;
  p.color = vec4f(0.0);
  p.px = 0.0;
  p.minPx = 0.85;
  p.glow = 0.3;
  p.shape = 1.0;

  let cols = max(u32(batch.user[0].y), 1u);
  let colsF = f32(cols);
  let pitch = batch.user[0].z;
  let ghost = batch.user[0].w;
  let t = batch.misc.y;
  let front = batch.user[1].x;
  let landing = batch.user[1].y;
  let gap = batch.user[1].z;
  let sweep = batch.user[1].w;
  let shimmer = batch.user[2].x;
  let dim = batch.user[2].y;
  let tau = batch.user[3].x;

  let s = wallSection(i);
  let rowF = f32(i / cols);
  let colF = f32(i % cols);
  let h0 = hash1(i * 5u + 17u);
  let h1 = hash1(i * 7u + 3u);
  let h2 = hash1(i * 11u + 29u);
  let rows = f32((W_N + cols - 1u) / cols);

  // Where this token sits in the wall: rows fill left to right, bottom to top, like text wrapping.
  var pos = vec3f((colF - (colsF - 1.0) * 0.5) * pitch, (rowF + 0.5) * pitch, 0.0);

  // ---- arriving -------------------------------------------------------------------------------
  var appear = 0.0;
  var heat = 0.0;
  var flash = 0.0;
  var size = pitch * 0.7;
  if (s < 5u) {
    // The build front sweeps up the wall; a little jitter and slope keep it from being a scan line.
    let age = front - (rowF + colF / colsF * 0.8 + h0 * 2.2);
    appear = smoothstep(0.0, 1.5, age);
    heat = exp(-max(age, 0.0) / 6.0) * step(0.0, age);
    pos.z = (1.0 - appear) * 0.3;
    // When a section's last row lands the whole band brightens once, then settles.
    let since = front - f32(wallEnd(s)) / colsF;
    flash = exp(-max(since, 0.0) / 12.0) * step(0.0, since);
  } else {
    // Your message drops onto the top of the wall.
    let k = clamp(landing * 1.3 - h0 * 0.18 - colF / colsF * 0.12, 0.0, 1.0);
    appear = smoothstep(0.0, 0.25, k);
    let fall = 1.0 - k;
    pos.y += fall * fall * 0.7 + gap * 1.8 * pitch;
    pos.z = fall * 0.25;
    heat = fall * 0.6;
    size = pitch * (0.8 + 0.15 * fall);
  }

  // ---- colour ---------------------------------------------------------------------------------
  let tw = 0.86 + 0.14 * sin(t * (0.6 + h1 * 1.6) + h2 * TAU);
  let v = (0.7 + 0.3 * h1) * tw;
  var col = mix(W_CACHE * 0.8, wallColor(s), appear);
  var inten = wallGain(s) * v;

  // Marked for reuse: a steel front sweeps down from the breakpoint, then a glint drifts through.
  var steel = 0.0;
  if (s < 5u && shimmer > 0.0) {
    let bpRow = f32(W_E4) / colsF;
    let dist = bpRow - rowF;
    let reach = sweep * (bpRow + 12.0);
    let hit = smoothstep(0.0, 12.0, reach - dist);
    let d = (reach - dist) / 3.0;
    let edge = exp(-d * d) * (1.0 - smoothstep(0.9, 1.0, sweep));
    steel = hit * shimmer;
    let hW = rows * pitch;
    let gpos = mix(-1.0, hW + 1.0, fract(t * 0.15));
    let gd = (pos.x * 0.35 + pos.y - gpos) / 0.5;
    let glint = exp(-gd * gd) * steel;
    inten *= 1.0 + 1.6 * edge * shimmer + 1.3 * glint;
    col = mix(col, W_CACHE * vec3f(0.95, 1.1, 1.3), clamp(0.8 * steel + 0.3 * glint, 0.0, 1.0));
  }

  col = mix(col, vec3f(1.0), clamp(0.3 * heat, 0.0, 0.6));
  inten *= 1.0 + 1.1 * heat + 0.8 * flash;
  if (s < 5u) {
    inten *= 1.0 - 0.6 * dim;
  }

  // A dark window behind a caption (the cache label), so the text reads over the tiles.
  let scrim = batch.user[2].w;
  if (scrim > 0.0) {
    let halfRows = max(batch.user[3].w, 1.0);
    let dr = abs(rowF - batch.user[2].z);
    inten *= 1.0 - scrim * (1.0 - smoothstep(halfRows * 0.6, halfRows, dr));
  }

  // ---- leaving: the wall is read out in order, a stripe at a time, into packets ----------------
  var shown = appear * inten;
  shown = max(shown, ghost * v * select(0.0, 1.0, s < 5u));
  if (tau > 0.0) {
    let k = min(i * W_NP / W_N, W_NP - 1u);
    let k0 = (k * W_N + W_NP - 1u) / W_NP;
    let j = i - k0;
    let u = tau - f32(k) * W_STAG;
    // The stripes leave from the foot of the wall; everything above settles down to take their place.
    let rpp = f32(W_N) / f32(W_NP) / colsF;
    pos.y -= min(tau / W_STAG, f32(k)) * rpp * pitch;
    let ff = clamp((u - h0 * W_FORM * 0.6) / W_FORM, 0.0, 1.0);
    let e = ff * ff * (3.0 - 2.0 * ff);
    if (ff > 0.0) {
      let jc = j % W_PCOLS;
      let jr = j / W_PCOLS;
      let pp = pitch * 0.35;
      let lx = (f32(jc) - f32(W_PCOLS - 1u) * 0.5) * pp;
      let ly = (f32(jr) - f32(W_PROWS - 1u) * 0.5) * pp;
      let nozzle = vec3f(batch.user[3].y, batch.user[3].z, 0.0);
      let centre = nozzle + W_DIR * (W_V * max(u, 0.0));
      let slot = centre + W_DIR * lx + vec3f(0.0, ly, 0.0);
      pos = mix(pos, slot, e);
      pos.z += sin(e * PI) * 0.5;
      size = mix(size, pitch * 0.6, e);
      let boost = (1.0 - 0.62 * e + 0.9 * sin(e * PI)) * mix(1.0, 0.75 + 0.25 * sin(pos.x * 5.0 - t * 6.0), e);
      shown = shown * boost;
      // On the way out the steel tint wears off: the packets carry their section's colour again.
      col = mix(col, wallColor(s), 0.65 * e);
    }
  }

  p.pos = pos;
  p.size = size;
  p.color = vec4f(col, shown);
  return p;
}
