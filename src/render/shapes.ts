// Polyline builders for scenes: circles, curves, arcs and filleted paths.
import { add, length, lerp3, normalize, scale, sub, type Vec3 } from "../util/math";

/** A circle in the plane spanned by unit vectors u and v. */
export function circle(center: Vec3, radius: number, segments = 64, u: Vec3 = [1, 0, 0], v: Vec3 = [0, 0, 1]): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push(add(center, add(scale(u, Math.cos(a) * radius), scale(v, Math.sin(a) * radius))));
  }
  return out;
}

/** Quadratic Bézier from a to b through control c. */
export function quad(a: Vec3, c: Vec3, b: Vec3, segments = 32): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    out.push(lerp3(lerp3(a, c, t), lerp3(c, b, t), t));
  }
  return out;
}

/** Cubic Bézier. */
export function cubic(a: Vec3, c1: Vec3, c2: Vec3, b: Vec3, segments = 40): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const ab = lerp3(a, c1, t);
    const bc = lerp3(c1, c2, t);
    const cd = lerp3(c2, b, t);
    out.push(lerp3(lerp3(ab, bc, t), lerp3(bc, cd, t), t));
  }
  return out;
}

/** An arc from a to b lifted by `height` along `up` at its middle (a parabola-ish bridge). */
export function bridge(a: Vec3, b: Vec3, height: number, up: Vec3 = [0, 1, 0], segments = 32): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    out.push(add(lerp3(a, b, t), scale(up, height * 4 * t * (1 - t))));
  }
  return out;
}

/**
 * A path through `pts` with each interior corner rounded by `radius` (like a circuit trace).
 * The radius shrinks where segments are too short to fit it.
 */
export function filleted(pts: readonly Vec3[], radius: number, arcSegments = 8): Vec3[] {
  if (pts.length < 3 || radius <= 0) return [...pts];
  const out: Vec3[] = [pts[0] as Vec3];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i] as Vec3;
    const a = sub(pts[i - 1] as Vec3, p);
    const b = sub(pts[i + 1] as Vec3, p);
    const r = Math.min(radius, length(a) * 0.5, length(b) * 0.5);
    const p0 = add(p, scale(normalize(a), r));
    const p1 = add(p, scale(normalize(b), r));
    for (let k = 0; k <= arcSegments; k++) {
      const t = k / arcSegments;
      out.push(lerp3(lerp3(p0, p, t), lerp3(p, p1, t), t));
    }
  }
  out.push(pts[pts.length - 1] as Vec3);
  return out;
}

/** Total length of a polyline. */
export function pathLength(pts: readonly Vec3[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += length(sub(pts[i] as Vec3, pts[i - 1] as Vec3));
  return s;
}

/** The point at fraction t (0..1) of a polyline's length. */
export function pointAt(pts: readonly Vec3[], t: number): Vec3 {
  const first = pts[0];
  if (!first) return [0, 0, 0];
  if (pts.length === 1 || t <= 0) return first;
  const total = pathLength(pts);
  let want = Math.min(1, t) * total;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Vec3;
    const b = pts[i] as Vec3;
    const l = length(sub(b, a));
    if (want <= l || i === pts.length - 1) return lerp3(a, b, l > 0 ? Math.min(1, want / l) : 0);
    want -= l;
  }
  return pts[pts.length - 1] as Vec3;
}

/** The part of a polyline between fractions t0 and t1 of its length. */
export function slice(pts: readonly Vec3[], t0: number, t1: number, steps = 24): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= steps; i++) out.push(pointAt(pts, t0 + ((t1 - t0) * i) / steps));
  return out;
}
