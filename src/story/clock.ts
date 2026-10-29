// The HUD clock: real time since Enter, in units that suit the act.
import type { Act } from "./chapters";

/** Act I lives in milliseconds (µs precision); Act II runs from milliseconds to minutes. */
export function formatClock(t: number, act: Act): string {
  if (act === "ping") return `${(t * 1000).toFixed(3)} ms`;
  if (t < 1) return `${(t * 1000).toFixed(1)} ms`;
  if (t < 60) return `${t.toFixed(2)} s`;
  const m = Math.floor(t / 60);
  const s = Math.floor(t - m * 60);
  return `${m} min ${String(s).padStart(2, "0")} s`;
}

/**
 * Elapsed real time at progress p through a chapter's clock window. Linear by default (scroll is
 * time); `ease` > 1 starts slow and speeds up, for chapters that end in a time-lapse.
 */
export function clockAt(window: readonly [number, number], p: number, ease = 1): number {
  const q = Math.min(1, Math.max(0, p)) ** ease;
  return window[0] + (window[1] - window[0]) * q;
}
