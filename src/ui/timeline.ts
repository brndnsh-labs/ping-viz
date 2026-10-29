// `data-timeline="from:to"`: the chapters between two ids drawn to scale on one bar, with buttons
// that play it back at real speed (and slower, from `data-speeds`). Widths and times come from the
// chapter clocks in story/chapters.ts, the same numbers as the HUD clock, so the two can't disagree.
import { type Act, CHAPTERS } from "../story/chapters";
import { formatClock } from "../story/clock";

export interface Segment {
  id: string;
  title: string;
  /** Seconds since Enter. */
  start: number;
  end: number;
}

/** The chapters from `from` to `to` (inclusive), in order. Throws unless their clocks join up end to start. */
export function timelineSegments(from: string, to: string): Segment[] {
  const a = CHAPTERS.findIndex((c) => c.id === from);
  const b = CHAPTERS.findIndex((c) => c.id === to);
  if (a < 0 || b < a) throw new Error(`timeline: bad range ${from}:${to}`);
  const segs: Segment[] = [];
  for (const c of CHAPTERS.slice(a, b + 1)) {
    if (!c.clock) throw new Error(`timeline: ${c.id} has no clock`);
    const prev = segs[segs.length - 1];
    if (prev && Math.abs(prev.end - c.clock[0]) > 1e-12) throw new Error(`timeline: gap before ${c.id}`);
    segs.push({ id: c.id, title: c.title, start: c.clock[0], end: c.clock[1] });
  }
  return segs;
}

/** The segment running at time t (the last one at or after the end). */
export function segmentAt(segs: readonly Segment[], t: number): Segment {
  return segs.find((s) => t < s.end) ?? (segs[segs.length - 1] as Segment);
}

/** A duration, in the unit that suits it: 20 µs, 260 µs, 1.4 ms, 29.2 ms, 2.1 s. */
export function formatSpan(s: number): string {
  if (s === 0) return "0";
  if (s < 1e-3) return `${Math.round(s * 1e6)} µs`;
  if (s < 1) return `${(s * 1e3).toFixed(1)} ms`;
  return `${s.toFixed(1)} s`;
}

/** Label a segment inside the bar when it's at least this share of the whole. */
const LABEL_MIN_SHARE = 0.1;

export function renderTimeline(el: HTMLElement): void {
  const [from = "", to = ""] = (el.dataset.timeline ?? "").split(":");
  const segs = timelineSegments(from, to);
  const act = (CHAPTERS.find((c) => c.id === from)?.act ?? "ping") as Act;
  const t0 = (segs[0] as Segment).start;
  const total = (segs[segs.length - 1] as Segment).end - t0;
  const speeds = (el.dataset.speeds ?? "1").split(",").map(Number);
  const clock = (t: number): string => formatClock(t, act);

  el.classList.add("tl");
  const bar = document.createElement("div");
  bar.className = "tl-bar";
  for (const [i, s] of segs.entries()) {
    const seg = document.createElement("span");
    seg.className = `tl-seg${i % 2 ? " odd" : ""}`;
    const share = (s.end - s.start) / total;
    seg.style.flexGrow = String(share);
    if (share >= LABEL_MIN_SHARE) seg.textContent = s.title;
    bar.appendChild(seg);
  }
  const fill = document.createElement("span");
  fill.className = "tl-fill";
  bar.appendChild(fill);

  const axis = document.createElement("div");
  axis.className = "tl-axis";
  axis.innerHTML = `<span>Enter</span><span>${formatSpan(total)}</span>`;

  const read = document.createElement("p");
  read.className = "tl-read";
  read.setAttribute("aria-live", "polite");
  const hint = "Hover or tap the bar to see each step.";
  let resting = hint;
  read.textContent = hint;

  const buttons = document.createElement("div");
  buttons.className = "tl-buttons";
  const playButtons = speeds.map((slow) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = slow === 1 ? "▶ Real speed" : `▶ ${slow.toLocaleString("en-US")}× slower`;
    b.addEventListener("click", () => play(slow));
    buttons.appendChild(b);
    return b;
  });

  el.replaceChildren(bar, axis, read, buttons);

  const show = (t: number): void => {
    fill.style.transform = `scaleX(${Math.min(1, (t - t0) / total).toFixed(5)})`;
  };
  show(t0);

  let run = 0;
  function play(slow: number): void {
    const id = ++run;
    const begin = performance.now();
    for (const b of playButtons) b.disabled = true;
    const step = (now: number): void => {
      if (id !== run) return;
      const t = Math.min(t0 + total, t0 + (now - begin) / 1000 / slow);
      show(t);
      const done = t >= t0 + total;
      read.textContent = done
        ? `${clock(t0 + total)}: done${slow === 1 ? ", at real speed" : ""}.`
        : `${clock(t)} · ${segmentAt(segs, t).title}`;
      if (done) {
        resting = read.textContent;
        for (const b of playButtons) b.disabled = false;
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Hover (or drag a finger along) the bar to name the step under it, with its duration.
  const inspect = (e: PointerEvent): void => {
    if (playButtons[0]?.disabled) return;
    const r = bar.getBoundingClientRect();
    const t = t0 + total * Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const s = segmentAt(segs, t);
    read.textContent = `${s.title}: ${formatSpan(s.end - s.start)}, from ${formatSpan(s.start)} to ${formatSpan(s.end)}`;
  };
  bar.addEventListener("pointermove", inspect);
  bar.addEventListener("pointerdown", inspect);
  bar.addEventListener("pointerleave", () => {
    if (!playButtons[0]?.disabled) read.textContent = resting;
  });
}
