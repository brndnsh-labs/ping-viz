// Autoplay: the page scrolls itself, card to card, at reading pace. Scroll is the story's only input,
// so the scenes follow on their own. Everything here reads the DOM, so it works without WebGPU too.
import { trackAutoplay } from "../analytics";
import { readingLineFor } from "../story/layout";
import { easeInOut, smooth } from "../util/ease";
import { clamp } from "../util/math";

// ---- Pacing (pure, tested in tests/autoplay.test.ts) -----------------------------------------

export const WORDS_PER_MINUTE = 240;
/** Added to every card at any speed: time for the scene to arrive before the reader looks up. */
export const SETTLE_S = 1.5;
export const SPEEDS = [0.75, 1, 1.5, 2] as const;
const GLIDE_MIN_S = 1.2;
const GLIDE_MAX_S = 2.5;
const GLIDE_PER_SCREEN_S = 0.6;
/**
 * While a card is up, the page creeps from this fraction of the way back toward the previous card to
 * the same fraction toward the next, so the scene keeps moving slowly behind the text.
 */
export const DRIFT = 0.2;

/**
 * Parts of a card that take longer than their word count says. Each match adds `seconds` of reading
 * time; `words: false` leaves its text out of the count (hex bytes and terminal output aren't prose).
 * A card can also set `data-dwell="1.5"` to scale its whole reading time.
 */
export const SLOW_PARTS: readonly { selector: string; seconds: number; words: boolean }[] = [
  { selector: ".term", seconds: 4, words: false },
  { selector: "[data-hexdump]", seconds: 10, words: false },
  { selector: "table", seconds: 4, words: true },
];

export interface CardCost {
  /** Visible words of prose. */
  words: number;
  /** Extra reading seconds at 1× (SLOW_PARTS). */
  bonus: number;
  /** data-dwell multiplier (1 if unset). */
  factor: number;
}

export function countWords(text: string): number {
  let n = 0;
  for (const w of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(w)) n++;
  return n;
}

/** Seconds to hold on a card: reading time scaled by speed, plus the fixed settle. */
export function dwellSeconds(cost: CardCost, speed: number): number {
  const reading = ((cost.words / WORDS_PER_MINUTE) * 60 + cost.bonus) * cost.factor;
  return reading / speed + SETTLE_S;
}

/** Seconds for the move between cards: longer for longer distances, within 1.2-2.5 s. */
export function glideSeconds(distance: number, viewportH: number): number {
  const screens = Math.abs(distance) / Math.max(1, viewportH);
  return clamp(GLIDE_MIN_S + GLIDE_PER_SCREEN_S * screens, GLIDE_MIN_S, GLIDE_MAX_S);
}

/**
 * Where to hold for one card, as scroll offsets: `from` on arrival, `to` by the end of the dwell.
 * Normally the card's centre sits near the reading line and the page drifts slowly from a little
 * before it to a little after (never cutting the card off). A card taller than the screen starts with
 * its top in view and pans to its bottom (`tall`).
 */
export interface Stop {
  from: number;
  to: number;
  tall?: boolean;
}

/** px to drift before and after a card's centre. */
export interface Drift {
  back: number;
  fwd: number;
}

export interface Viewport {
  height: number;
  /** 0..1 down the viewport (story/layout.ts). */
  line: number;
  maxScroll: number;
  /** px kept clear at the top (the HUD) and bottom. */
  insetTop: number;
  insetBottom: number;
}

export function stopFor(top: number, bottom: number, v: Viewport, drift: Drift = { back: 0, fwd: 0 }): Stop {
  const ideal = (top + bottom) / 2 - v.height * v.line;
  const showsBottom = bottom - (v.height - v.insetBottom);
  const showsTop = top - v.insetTop;
  const onPage = (y: number): number => clamp(y, 0, Math.max(0, v.maxScroll));
  if (showsBottom <= showsTop) {
    const onScreen = (y: number): number => onPage(clamp(y, showsBottom, showsTop));
    return { from: onScreen(ideal - drift.back), to: onScreen(ideal + drift.fwd) };
  }
  return { from: onPage(showsTop), to: onPage(showsBottom), tall: true };
}

/** The first card whose stop is at or after scroll offset y (within `tol` px behind it), or -1. */
export function nextStop(stops: readonly Stop[], y: number, tol: number): number {
  return stops.findIndex((s) => s.to >= y - tol);
}

// ---- Measuring cards in the DOM --------------------------------------------------------------

/** Words and slow parts a reader sees: closed "More detail" blocks count only their summary. */
export function cardCost(card: HTMLElement): CardCost {
  const copy = card.cloneNode(true) as HTMLElement;
  for (const d of copy.querySelectorAll("details:not([open])")) {
    for (const child of [...d.children]) if (child.tagName !== "SUMMARY") child.remove();
  }
  let bonus = 0;
  for (const part of SLOW_PARTS) {
    for (const el of copy.querySelectorAll(part.selector)) {
      bonus += part.seconds;
      if (!part.words) el.remove();
    }
  }
  const factor = Number(card.dataset.dwell);
  return { words: countWords(copy.textContent ?? ""), bonus, factor: factor > 0 ? factor : 1 };
}

// ---- The player ------------------------------------------------------------------------------

type Phase =
  | { kind: "glide"; k: number; from: number; t: number; dur: number }
  | { kind: "dwell"; k: number; a: number; b: number; tall: boolean; done: number; cost: CardCost };

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export interface AutoplayOptions {
  story: HTMLElement;
  /** The HUD bar: its height is kept clear above a card. */
  hud: HTMLElement;
  /** The no-WebGPU note pinned to the bottom of the screen, kept clear below a card when shown. */
  note: HTMLElement | null;
  /** Holds the play and speed buttons (#autoplay in index.html). */
  controls: HTMLElement;
  reducedMotion: boolean;
  /** ?play: highlight the button and start on the reader's first tap, click or Enter/Space. */
  armed: boolean;
}

export function initAutoplay(o: AutoplayOptions): void {
  const playBtn = o.controls.querySelector(".ap-play") as HTMLButtonElement;
  const speedBtn = o.controls.querySelector(".ap-speed") as HTMLButtonElement;
  let speedIndex = SPEEDS.indexOf(1);
  let playing = false;
  let armed = o.armed;
  let tracked = false;
  let cards: HTMLElement[] = [];
  let stops: Stop[] = [];
  let dirty = true;
  let phase: Phase | null = null;
  /** The scroll offset we last set; if the page is still there on resume, carry on mid-card. */
  let y = 0;
  let lastNow = -1;

  const speed = (): number => SPEEDS[speedIndex] ?? 1;

  function measure(): void {
    const h = window.innerHeight;
    const v: Viewport = {
      height: h,
      line: readingLineFor(window.innerWidth, h),
      maxScroll: document.documentElement.scrollHeight - h,
      insetTop: o.hud.offsetHeight + 12,
      insetBottom: 16 + (o.note && !o.note.hidden ? o.note.offsetHeight + 8 : 0),
    };
    cards = [...o.story.querySelectorAll<HTMLElement>("section[data-chapter] > .card")];
    const boxes = cards.map((c) => {
      const r = c.getBoundingClientRect();
      return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY };
    });
    const mid = (k: number): number | null => {
      const b = boxes[k];
      return b ? (b.top + b.bottom) / 2 : null;
    };
    const drift = o.reducedMotion ? 0 : DRIFT;
    stops = boxes.map((b, k) => {
      const c = mid(k) as number;
      const prev = mid(k - 1);
      const next = mid(k + 1);
      return stopFor(b.top, b.bottom, v, {
        back: prev === null ? 0 : (c - prev) * drift,
        fwd: next === null ? 0 : (next - c) * drift,
      });
    });
    dirty = false;
  }

  function render(): void {
    playBtn.setAttribute("aria-pressed", String(playing));
    o.controls.classList.toggle("armed", armed && !playing);
    const s = `${speed()}×`;
    speedBtn.textContent = s;
    speedBtn.setAttribute("aria-label", `Autoplay speed ${s}. Change speed`);
  }

  function goTo(k: number): void {
    measure(); // fonts, open details and the like can move cards between stops
    const stop = stops[k];
    if (!stop) {
      stopPlaying();
      return;
    }
    if (o.reducedMotion) dwell(k, stop.from);
    else phase = { kind: "glide", k, from: y, t: 0, dur: glideSeconds(stop.from - y, window.innerHeight) };
  }

  function dwell(k: number, from: number): void {
    const card = cards[k];
    const stop = stops[k];
    if (!card || !stop) {
      stopPlaying();
      return;
    }
    phase = { kind: "dwell", k, a: from, b: Math.max(from, stop.to), tall: !!stop.tall, done: 0, cost: cardCost(card) };
  }

  function play(): void {
    if (playing) return;
    armed = false;
    measure();
    const here = window.scrollY;
    // Resuming exactly where we paused: finish that card. Otherwise start from the reader's position.
    if (!(phase && Math.abs(here - y) < 2)) {
      const tol = window.innerHeight * 0.12;
      const k = nextStop(stops, here, tol);
      const stop = stops[k];
      y = here;
      if (!stop) {
        // At the end: start over from the top.
        y = stops[0]?.from ?? 0;
        window.scrollTo(0, y);
        dwell(0, y);
      } else if (here >= stop.from - tol) dwell(k, here);
      else goTo(k);
    }
    playing = true;
    lastNow = -1;
    if (!tracked) {
      tracked = true;
      trackAutoplay(speed());
    }
    render();
    requestAnimationFrame(frame);
  }

  function pause(): void {
    if (!playing) return;
    playing = false;
    render();
  }

  function stopPlaying(): void {
    phase = null;
    pause();
  }

  function frame(now: number): void {
    if (!playing) return;
    // Clamped, so a hidden tab (no frames) doesn't skip cards when it comes back.
    const dt = lastNow < 0 ? 0 : Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
    if (dirty) {
      measure();
      // Resized mid-card (rotation, a window drag, Safari's toolbar collapsing): follow the card to where
      // it now sits and keep reading time, so repeated small resizes never restart a card.
      if (phase?.kind === "dwell") {
        const stop = stops[phase.k];
        if (stop) {
          phase.a = stop.from;
          phase.b = Math.max(stop.from, stop.to);
        }
      }
    }
    if (phase?.kind === "glide") {
      phase.t += dt;
      const to = stops[phase.k]?.from ?? phase.from;
      const p = Math.min(1, phase.t / phase.dur);
      y = phase.from + (to - phase.from) * easeInOut(p);
      if (p >= 1) dwell(phase.k, to);
    } else if (phase?.kind === "dwell") {
      phase.done += dt / dwellSeconds(phase.cost, speed());
      // Short cards drift at a steady pace for the whole dwell. Tall cards pan through the middle of
      // it; reduced motion steps instead (and has no drift).
      const pan = o.reducedMotion
        ? phase.done < 0.5
          ? 0
          : 1
        : phase.tall
          ? smooth(clamp((phase.done - 0.15) / 0.7, 0, 1))
          : Math.min(1, phase.done);
      y = phase.a + (phase.b - phase.a) * pan;
      if (phase.done >= 1) {
        if (phase.k + 1 >= stops.length) {
          stopPlaying();
          return;
        }
        goTo(phase.k + 1);
      }
    }
    if (!playing) return;
    window.scrollTo(0, y);
    requestAnimationFrame(frame);
  }

  // ---- Input: the reader always wins --------------------------------------------------------

  const inControls = (e: Event): boolean => e.target instanceof Node && o.controls.contains(e.target);
  /** The reader is scrolling: stop, and drop a pending ?play. */
  const readerScrolls = (): void => {
    pause();
    if (armed) {
      armed = false;
      render();
    }
  };
  const opts = { passive: true, capture: true };
  window.addEventListener("wheel", readerScrolls, opts);
  window.addEventListener("touchmove", readerScrolls, opts);
  window.addEventListener("touchstart", (e) => inControls(e) || pause(), opts);
  window.addEventListener("pointerdown", (e) => inControls(e) || pause(), opts);
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (e.key === "Enter") {
        if (armed && !target?.closest("a, button, summary")) play();
      } else if (e.key === " ") {
        if (target?.closest("button, summary, input, textarea, select")) return; // presses it, doesn't scroll
        if (armed) {
          e.preventDefault();
          play();
        } else readerScrolls();
      } else if (SCROLL_KEYS.has(e.key)) readerScrolls();
    },
    true,
  );
  // Opening "More detail" means the reader wants to stay. (toggle doesn't bubble; capture sees it.)
  document.addEventListener(
    "toggle",
    (e) => {
      if (e.target instanceof HTMLDetailsElement && e.target.open) pause();
    },
    true,
  );
  // ?play starts on a tap or click. pointerup rather than click: iOS Safari doesn't send clicks on
  // plain text up to a document listener, and a touch that turns into a scroll ends in pointercancel.
  window.addEventListener("pointerup", (e) => {
    if (!armed || !e.isPrimary || e.button !== 0 || inControls(e)) return;
    if (e.target instanceof Element && e.target.closest("a, button, summary, details")) return;
    play();
  });
  window.addEventListener("resize", () => {
    dirty = true;
  });

  playBtn.addEventListener("click", () => (playing ? pause() : play()));
  speedBtn.addEventListener("click", () => {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    render();
  });
  render();
}
