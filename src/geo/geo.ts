// The globe's coordinate system: unit sphere, y up, longitude 0 on +z and 90°E on +x, so a camera
// with yaw = longitude and pitch = latitude looks straight down at that place.
import { add, DEG, normalize, scale, type Vec3 } from "../util/math";
import { isLand } from "./land";

/** Earth's mean radius: one globe unit. */
export const EARTH_KM = 6371;

export function ll(lat: number, lon: number, r = 1): Vec3 {
  const la = lat * DEG;
  const lo = lon * DEG;
  return [Math.cos(la) * Math.sin(lo) * r, Math.sin(la) * r, Math.cos(la) * Math.cos(lo) * r];
}

/** Great-circle distance in km. */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const p = ll(a[0], a[1]);
  const q = ll(b[0], b[1]);
  const d = Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
  return Math.acos(d) * EARTH_KM;
}

/**
 * Points along the great circle from a to b (lat/lon degrees), lifted off the surface by
 * `lift` (globe units) at the middle, proportionally to the arc's length when `lift` < 0.
 */
export function arc(a: [number, number], b: [number, number], segments = 48, lift = -0.12, base = 1.002): Vec3[] {
  const p = ll(a[0], a[1]);
  const q = ll(b[0], b[1]);
  const dot = Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
  const ang = Math.acos(dot);
  const h = lift < 0 ? -lift * ang : lift;
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let v: Vec3;
    if (ang < 1e-6) v = p;
    else {
      const s = Math.sin(ang);
      v = add(scale(p, Math.sin((1 - t) * ang) / s), scale(q, Math.sin(t * ang) / s));
    }
    out.push(scale(normalize(v), base + h * Math.sin(Math.PI * t)));
  }
  return out;
}

/** Light in fibre covers about 204 km per millisecond (refractive index ~1.47). */
export const FIBER_KM_PER_MS = 204;

/**
 * Dots on land in tidy latitude rows, `step` degrees apart (spacing along each row is widened by
 * 1/cos(lat) so dots stay evenly spaced on the sphere). Optional bounding box [south, west, north, east].
 */
export function landDots(step: number, box?: [number, number, number, number]): { lat: number; lon: number }[] {
  const [s, w, n, e] = box ?? [-90, -180, 90, 180];
  const out: { lat: number; lon: number }[] = [];
  const row0 = Math.ceil(s / step);
  const row1 = Math.floor(n / step);
  for (let r = row0; r <= row1; r++) {
    const lat = r * step;
    const c = Math.cos(lat * DEG);
    if (c < 0.02) continue;
    const dlon = step / c;
    // Offset alternate rows by half a step so the pattern reads as a hex lattice.
    const off = (r & 1) * dlon * 0.5;
    const k0 = Math.ceil((w - off) / dlon);
    const k1 = Math.floor((e - off) / dlon);
    for (let k = k0; k <= k1; k++) {
      const lon = k * dlon + off;
      if (lon < -180 || lon >= 180) continue;
      if (isLand(lat, lon)) out.push({ lat, lon });
    }
  }
  return out;
}
