// Small helpers for scroll-driven animation: map a progress value through windows and curves.
import { clamp } from "./math";

/** 0 before `a`, 1 after `b`, linear between. */
export const seg = (x: number, a: number, b: number): number => clamp((x - a) / (b - a), 0, 1);

export const smooth = (t: number): number => t * t * (3 - 2 * t);
export const smoother = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
export const easeOut = (t: number): number => 1 - (1 - t) * (1 - t) * (1 - t);
export const easeIn = (t: number): number => t * t * t;
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Smooth 0→1 across [a, b]. */
export const ramp = (x: number, a: number, b: number): number => smooth(seg(x, a, b));

/** Rises across [a, b], holds, falls across [c, d]. */
export const window = (x: number, a: number, b: number, c: number, d: number): number =>
  ramp(x, a, b) * (1 - ramp(x, c, d));

/** Piecewise-linear lookup through (x, y) pairs sorted by x. */
export function piecewise(x: number, pts: readonly (readonly [number, number])[]): number {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return 0;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i] as readonly [number, number];
    if (x <= b[0]) {
      const a = pts[i - 1] as readonly [number, number];
      return a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
    }
  }
  return last[1];
}
