// Orbit camera poses, their interpolation, and the matrices/uniforms the shaders read.
import {
  add,
  clamp,
  cross,
  DEG,
  type Mat4,
  multiply,
  normalize,
  perspective,
  scale,
  sub,
  type Vec3,
  viewFromBasis,
} from "../util/math";

/** Where the camera is, described as an orbit around a target point (y up). */
export interface CameraPose {
  target: Vec3;
  /** Distance from target to eye, in scene units. */
  distance: number;
  /** Radians around +y. 0 puts the eye on the +z side of the target. */
  yaw: number;
  /** Radians above the target's horizontal plane (positive looks down). */
  pitch: number;
  /** Vertical field of view, degrees. */
  fov: number;
  /** Radians of roll around the viewing direction. */
  roll?: number;
}

export interface CameraState {
  pose: CameraPose;
  viewProj: Mat4;
  view: Mat4;
  eye: Vec3;
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
  near: number;
  far: number;
  /** CSS px per scene unit at view depth 1. */
  pxPerUnit: number;
  /** Viewport size in CSS px. */
  viewport: [number, number];
}

/** Lens shift in NDC: moves the subject off-centre (e.g. away from the text column). */
export interface LensShift {
  x: number;
  y: number;
}

export const CAMERA_UNIFORM_SIZE = 224;

export function eyeOf(p: CameraPose): Vec3 {
  const cp = Math.cos(p.pitch);
  return add(p.target, scale([cp * Math.sin(p.yaw), Math.sin(p.pitch), cp * Math.cos(p.yaw)], p.distance));
}

export function cameraState(
  pose: CameraPose,
  viewport: [number, number],
  shift: LensShift,
  nearFar?: { near: number; far: number },
): CameraState {
  const eye = eyeOf(pose);
  const fwd = normalize(sub(pose.target, eye));
  let right = normalize(cross(fwd, [0, 1, 0]));
  if (right[0] === 0 && right[1] === 0 && right[2] === 0) right = [1, 0, 0];
  let up = cross(right, fwd);
  const roll = pose.roll ?? 0;
  if (roll !== 0) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const r2 = add(scale(right, c), scale(up, s));
    up = add(scale(up, c), scale(right, -s));
    right = r2;
  }
  const aspect = viewport[0] / Math.max(1, viewport[1]);
  const near = nearFar?.near ?? Math.max(pose.distance * 0.004, 1e-5);
  const far = nearFar?.far ?? pose.distance * 400;
  const fovY = clamp(pose.fov, 5, 120) * DEG;
  const proj = perspective(fovY, aspect, near, far);
  // Off-centre projection: shift the image by `shift` in NDC (see the derivation in camera.test).
  proj[8] = -shift.x;
  proj[9] = -shift.y;
  const view = viewFromBasis(eye, right, up, fwd);
  return {
    pose,
    viewProj: multiply(proj, view),
    view,
    eye,
    right,
    up,
    fwd,
    near,
    far,
    pxPerUnit: viewport[1] / (2 * Math.tan(fovY / 2)),
    viewport,
  };
}

/** Pack a camera into the WGSL `Camera` uniform (see common.wgsl). */
export function packCamera(
  out: Float32Array,
  c: CameraState,
  time: number,
  pxScale: number,
  params: [number, number, number, number] = [0, 0, 0, 0],
): void {
  out.set(c.viewProj, 0);
  out.set(c.view, 16);
  out.set(c.eye, 32);
  out[35] = time;
  out.set(c.right, 36);
  out[39] = c.pxPerUnit * pxScale;
  out.set(c.up, 40);
  out[43] = c.viewport[0] / Math.max(1, c.viewport[1]);
  out.set(c.fwd, 44);
  out[47] = c.near;
  out[48] = c.viewport[0] * pxScale;
  out[49] = c.viewport[1] * pxScale;
  out[50] = c.far;
  out[51] = pxScale;
  out.set(params, 52);
}

/** Project a world point to CSS px (origin top-left); null when behind the camera. */
export function projectToScreen(c: CameraState, p: Vec3): { x: number; y: number; depth: number } | null {
  const m = c.viewProj;
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  if (w <= c.near * 0.5) return null;
  return {
    x: ((x / w) * 0.5 + 0.5) * c.viewport[0],
    y: (0.5 - (y / w) * 0.5) * c.viewport[1],
    depth: w,
  };
}

const wrapAngle = (a: number): number => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};

/**
 * Zoom from pose a into close-up b (fly-throughs, story/flights.ts). Distance moves in log space with
 * s, and everything else moves in step with how much of the distance has been covered, so the anchor
 * holds its place on screen as the camera closes in. (Moving the target linearly in s while the
 * distance shrinks geometrically can put the eye inside whatever it's zooming toward, such as a planet.)
 */
export function flyPose(a: CameraPose, b: CameraPose, s: number): CameraPose {
  const d = Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * s);
  const span = a.distance - b.distance;
  const u = Math.abs(span) < 1e-9 * a.distance ? s : (a.distance - d) / span;
  return { ...lerpPose(a, b, u), distance: d };
}

/** Blend two poses: positions linearly, distance in log space (so big zooms feel even), yaw the short way. */
export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  const yaw = a.yaw + wrapAngle(b.yaw - a.yaw) * t;
  return {
    target: [
      a.target[0] + (b.target[0] - a.target[0]) * t,
      a.target[1] + (b.target[1] - a.target[1]) * t,
      a.target[2] + (b.target[2] - a.target[2]) * t,
    ],
    distance: Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * t),
    yaw,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    fov: a.fov + (b.fov - a.fov) * t,
    roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * t,
  };
}

export interface PoseKey {
  /** Position on the scene's timeline (see SceneFrame.local). */
  at: number;
  pose: CameraPose;
}

/** Catmull-Rom weights for a point between p1 and p2. */
function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * Smooth camera path through keys (sorted by `at`): a Catmull-Rom spline over each pose field, so the
 * camera keeps moving through a key instead of stopping at it. Distance goes through log space.
 */
export function poseAt(keys: PoseKey[], x: number): CameraPose {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (!first || !last) throw new Error("poseAt: no keys");
  if (keys.length === 1 || x <= first.at) return first.pose;
  if (x >= last.at) return last.pose;
  let i = 0;
  while (i < keys.length - 2 && x > (keys[i + 1] as PoseKey).at) i++;
  const k1 = keys[i] as PoseKey;
  const k2 = keys[i + 1] as PoseKey;
  const k0 = keys[i - 1] ?? k1;
  const k3 = keys[i + 2] ?? k2;
  const t = (x - k1.at) / Math.max(1e-9, k2.at - k1.at);
  // Unwrap yaw so the spline never takes the long way round.
  const y1 = k1.pose.yaw;
  const y0 = y1 + wrapAngle(k0.pose.yaw - y1);
  const y2 = y1 + wrapAngle(k2.pose.yaw - y1);
  const y3 = y2 + wrapAngle(k3.pose.yaw - y2);
  const f = (g: (p: CameraPose) => number): number => cr(g(k0.pose), g(k1.pose), g(k2.pose), g(k3.pose), t);
  const ld = f((p) => Math.log(p.distance));
  return {
    target: [f((p) => p.target[0]), f((p) => p.target[1]), f((p) => p.target[2])],
    distance: Math.exp(ld),
    yaw: cr(y0, y1, y2, y3, t),
    pitch: f((p) => p.pitch),
    fov: f((p) => p.fov),
    roll: f((p) => p.roll ?? 0),
  };
}

/**
 * Phones: the field of view is vertical, so a portrait screen sees well under half as much across as
 * a desktop. Pull a pose framed for desktop back until its subject fits the width again. `width` is
 * how wide the subject runs (about 1 for a subject that fills the desktop frame's height).
 */
export function fitNarrow(p: CameraPose, f: { narrow: boolean; aspect: number }, width = 0.95): CameraPose {
  return f.narrow ? { ...p, distance: p.distance * clamp(width / f.aspect, 1, 3) } : p;
}

/** Shorthand for writing poses in scene files: target, distance, yaw/pitch in degrees, fov. */
export function pose(
  target: Vec3,
  distance: number,
  yawDeg: number,
  pitchDeg: number,
  fov = 40,
  rollDeg = 0,
): CameraPose {
  return { target, distance, yaw: yawDeg * DEG, pitch: pitchDeg * DEG, fov, roll: rollDeg * DEG };
}
