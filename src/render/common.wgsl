// Shared by every scene shader: the camera (group 0) and a per-batch uniform block (group 1).

struct Camera {
  viewProj: mat4x4f,
  view: mat4x4f,
  eye: vec3f,
  time: f32,
  right: vec3f,
  // Render px per scene unit at view depth 1.
  pxPerUnit: f32,
  up: vec3f,
  aspect: f32,
  fwd: vec3f,
  near: f32,
  // Render-target size in px.
  viewport: vec2f,
  far: f32,
  // Render px per CSS px: multiply every px-denominated size by this.
  pxScale: f32,
  params: vec4f,
}

// Per-batch values a scene can change without re-uploading instances.
struct Batch {
  // x: opacity, y: time (scene-defined clock), z: highlight, w: spare
  misc: vec4f,
  // Free slots for custom instance hooks.
  user: array<vec4f, 8>,
}

@group(0) @binding(0) var<uniform> cam: Camera;

const PI = 3.14159265358979;
const TAU = 6.28318530717959;

fn toClip(p: vec3f) -> vec4f {
  return cam.viewProj * vec4f(p, 1.0);
}

fn viewDepth(p: vec3f) -> f32 {
  return dot(p - cam.eye, cam.fwd);
}

// PCG-style integer hash, then helpers for floats in [0, 1).
fn hashu(v: u32) -> u32 {
  var s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn hash1(v: u32) -> f32 {
  return f32(hashu(v)) * (1.0 / 4294967296.0);
}

fn hash2(a: u32, b: u32) -> f32 {
  return hash1(a ^ hashu(b + 0x9e3779b9u));
}

fn hash3v(v: u32) -> vec3f {
  return vec3f(hash1(v), hash1(v ^ 0x68bc21ebu), hash1(v ^ 0x02e5be93u));
}
