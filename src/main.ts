import "./ui/style.css";
import { trackChapters, trackNoGpu } from "./analytics";
import { App } from "./app";
import { GpuUnavailableError, gpuErrors, initGpu } from "./gpu/context";
import type { SceneId } from "./scenes/scene";
import { CHAPTERS, chapterIndex } from "./story/chapters";
import { initContent } from "./ui/content";

/** What the page exposes for the headless scripts (scripts/shot.ts, scripts/smoke.ts). */
export interface PingDebug {
  ready: boolean;
  errors: string[];
  gpu: "ok" | string;
  /** The last frame as a PNG data URL. */
  capture: () => Promise<string>;
  /** Pin the story at chapter `id`, progress p (0..1), and scroll the text to match. */
  goto: (id: string, p: number) => Promise<void>;
  /** Wait for n rendered frames. */
  frames: (n: number) => Promise<void>;
  state: () => { chapter: string; p: number; slots: string[] } | null;
  /** Chapter ids in story order. */
  chapters: string[];
  /** Centres of a chapter's text cards as progress (0..1) in the current layout: what a reader sees. */
  cards: (id: string) => number[];
  /** Pretend the reader is hovering this field in the text (tests hover highlights). */
  setFocus: (focus: string | null) => void;
}

declare global {
  interface Window {
    __ping?: PingDebug;
  }
}

const params = new URLSearchParams(location.search);
const shot = params.has("shot");
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const debug: PingDebug = {
  ready: false,
  errors: gpuErrors,
  gpu: "starting",
  capture: () => Promise.reject(new Error("no renderer")),
  goto: () => Promise.resolve(),
  frames: () => Promise.resolve(),
  state: () => null,
  chapters: CHAPTERS.map((c) => c.id),
  cards: () => [],
  setFocus: () => {},
};
window.__ping = debug;

const story = document.getElementById("story") as HTMLElement;
initContent(story, (focus) => {
  if (app) app.focus = focus;
});
trackChapters(story);

let app: App | null = null;

function fallback(reason: string): void {
  document.body.classList.add("no-gpu");
  const note = document.getElementById("gpu-note");
  if (note) {
    note.hidden = false;
    const why = note.querySelector(".why");
    if (why && reason === "insecure-context") why.textContent = "WebGPU needs a secure (https) page.";
  }
  debug.gpu = reason;
  debug.ready = true;
  trackNoGpu(reason);
}

async function boot(): Promise<void> {
  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  try {
    const gpu = await initGpu(canvas, (reason) => fallback(`lost: ${reason}`), shot);
    const scale = params.get("scale");
    app = new App(gpu, {
      capture: shot,
      fixedScale: scale ? Number(scale) : null,
      sampleCount: params.get("msaa") === "1" ? 1 : 4,
      reducedMotion,
      maxDpr: Number(params.get("dpr") ?? 2),
      look: Object.fromEntries(
        ["bloom", "exposure", "vignette", "grain", "saturation", "power"]
          .filter((k) => params.has(k))
          .map((k) => [k, Number(params.get(k))]),
      ),
    });
    const a = app;
    const only = params.get("only");
    await a.loadScenes(only ? (only as SceneId) : null);
    let waiters: { n: number; resolve: () => void }[] = [];
    a.onFrame = () => {
      waiters = waiters.filter((w) => {
        w.n--;
        if (w.n <= 0) w.resolve();
        return w.n > 0;
      });
    };
    debug.frames = (n) => new Promise((resolve) => waiters.push({ n, resolve }));
    debug.capture = async () => {
      const img = await a.capture();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      (c.getContext("2d") as CanvasRenderingContext2D).putImageData(
        new ImageData(img.data, img.width, img.height),
        0,
        0,
      );
      return c.toDataURL("image/png");
    };
    debug.goto = async (id, p) => {
      const i = chapterIndex(id);
      if (i < 0) throw new Error(`no chapter ${id}`);
      a.pin(i + Math.min(0.9999, Math.max(0, p)));
      await debug.frames(3);
    };
    debug.state = () =>
      a.state ? { chapter: a.state.chapter.id, p: a.state.p, slots: a.state.slots.map((s) => s.scene) } : null;
    debug.setFocus = (focus) => {
      a.focus = focus;
    };
    debug.cards = (id) => a.cardCentres(id);
    debug.gpu = "ok";
    a.start();
    // Compile the other scenes' shaders while the reader is on the first card. Screenshots wait for it.
    const warmed = a.warm().catch((e) => console.error("ping-viz: warm-up failed", e));
    if (shot) await warmed;
    const at = params.get("at");
    if (at) {
      const [id, p] = at.split(":");
      await debug.goto(id as string, Number(p ?? 0.5));
    }
    await debug.frames(4);
    debug.ready = true;
  } catch (e) {
    if (e instanceof GpuUnavailableError) fallback(e.message);
    else {
      console.error("ping-viz: failed to start", e);
      fallback(e instanceof Error ? e.message : String(e));
    }
  }
}

boot();
