// `?stats`: a small readout of frame timing, for judging performance on real devices.
import type { PerfSample } from "../app";

/** Refresh the readout this often. Each refresh averages the frames since the last one. */
const PERIOD_MS = 500;

/** Show the overlay and keep it updated from `read` (App.perf). */
export function initStats(read: () => PerfSample): void {
  const el = document.createElement("pre");
  el.className = "stats";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  const dpr = window.devicePixelRatio || 1;
  setInterval(() => {
    el.textContent = formatStats(read(), PERIOD_MS, dpr);
  }, PERIOD_MS);
}

export function formatStats(s: PerfSample, periodMs: number, dpr: number): string {
  const fps = (s.frames * 1000) / periodMs;
  return [
    `${fps.toFixed(0)} fps  worst gap ${s.worstGapMs.toFixed(1)} ms`,
    `cpu ${s.cpuMs.toFixed(2)} ms  gpu ${s.gpuMs < 0 ? "–" : `${s.gpuMs.toFixed(1)} ms`}`,
    `${s.width}×${s.height}  scale ${s.renderScale.toFixed(2)}  dpr ${dpr}`,
    s.scenes.join(" + ") || "no scene",
  ].join("\n");
}
