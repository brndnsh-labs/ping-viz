// The frame loop: scroll → story position → scenes → camera → render, plus labels and the HUD.
import type { Gpu } from "./gpu/context";
import { type CameraState, cameraState, type LensShift } from "./render/camera";
import type { PostParams } from "./render/post";
import { type CapturedFrame, Renderer, type SlotDraw } from "./render/renderer";
import { createScenes } from "./scenes";
import { placeholder } from "./scenes/placeholder";
import type { Label, Scene, SceneFrame, SceneId } from "./scenes/scene";
import { CHAPTERS } from "./story/chapters";
import { plan, type SlotPlan, type StoryState } from "./story/director";
import {
  isWide,
  measure,
  READING_LINE,
  READING_LINE_NARROW,
  type SectionBox,
  scrollFor,
  storyPosition,
} from "./story/layout";
import { Hud } from "./ui/hud";
import { LabelLayer } from "./ui/labels";
import { approach, clamp } from "./util/math";

export interface AppOptions {
  /** Headless capture: no smoothing, no adaptive resolution. */
  capture: boolean;
  /** Fixed render scale (else adaptive). */
  fixedScale: number | null;
  sampleCount: number;
  reducedMotion: boolean;
  maxDpr: number;
  /** Skip a display refresh that comes sooner than MIN_FRAME_GAP_MS after the last frame (`?nocap` turns it off). */
  frameCap: boolean;
  /** Time GPU work per frame (`?stats`). */
  stats: boolean;
  /** Overrides for the post-processing look (tuning: `?bloom=0.6&exposure=1.1`). */
  look: Partial<PostParams>;
}

/**
 * The shortest gap between frames. A 120 Hz screen (8.3 ms per refresh) draws every other refresh, so
 * 60 fps; 60 Hz (16.7 ms) and 90 Hz (11.1 ms) screens draw every refresh. Every scene moves slowly, so
 * 120 fps would double the GPU work (and battery) for nothing visible.
 */
export const MIN_FRAME_GAP_MS = 10;

/** One stats sample (see ui/stats.ts): averages since the previous call to App.perf(). */
export interface PerfSample {
  frames: number;
  /** Mean CPU time per frame in tick(), ms. */
  cpuMs: number;
  /** Submit to GPU-done for the most recent sampled frame, ms (includes queueing; -1 before the first). */
  gpuMs: number;
  /** Longest gap between drawn frames, ms. */
  worstGapMs: number;
  renderScale: number;
  width: number;
  height: number;
  scenes: string[];
}

interface LayoutMode {
  shift: LensShift;
  narrow: boolean;
  focusUv: [number, number];
}

export class App {
  readonly renderer: Renderer;
  scenes: Map<SceneId, Scene> = new Map();
  time = 0;
  frame = 0;
  /** The smoothed story position (chapter index + progress). */
  story = 0;
  state: StoryState | null = null;
  /** What the reader is hovering in the text (a packet field id etc.), for scenes to highlight. */
  focus: string | null = null;
  /** Called after each rendered frame. */
  onFrame: (() => void) | null = null;
  private readonly gpu: Gpu;
  private readonly opts: AppOptions;
  private readonly storyRoot: HTMLElement;
  private readonly labels: LabelLayer;
  private readonly hud: Hud;
  private sections: SectionBox[] = [];
  private cssW = 0;
  private cssH = 0;
  private renderScale = 1;
  private lastNow = -1;
  private needsMeasure = true;
  private lastMeasure = 0;
  private pinned: number | null = null;
  private slowFrames = 0;
  private fastFrames = 0;
  private running = false;
  private lastCameras: CameraState[] = [];
  private frameErrors = 0;
  private perfFrames = 0;
  private perfCpu = 0;
  private perfWorstGap = 0;
  private gpuMs = -1;
  private gpuPending = false;

  constructor(gpu: Gpu, opts: AppOptions) {
    this.gpu = gpu;
    this.opts = opts;
    this.renderer = new Renderer(gpu, opts.sampleCount);
    this.storyRoot = document.getElementById("story") as HTMLElement;
    this.labels = new LabelLayer(document.getElementById("labels") as HTMLElement);
    this.hud = new Hud(
      document.getElementById("hud") as HTMLElement,
      document.getElementById("rail") as HTMLElement,
      (i) => this.jump(i),
    );
    this.renderScale = opts.fixedScale ?? 1;
    const remeasure = (): void => {
      this.needsMeasure = true;
    };
    new ResizeObserver(remeasure).observe(this.storyRoot);
    window.addEventListener("resize", remeasure);
    document.fonts?.ready.then(remeasure);
    this.storyRoot.addEventListener("toggle", remeasure, true);
  }

  /** Load and build the scenes (all of them, or just `only`). Call before start(). */
  async loadScenes(only: SceneId | null = null): Promise<void> {
    this.scenes = await createScenes(this.renderer.gfx, only);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (now: number): void => {
      if (!this.running) return;
      // Schedule first, so one bad frame can't stop the picture for the rest of the visit.
      requestAnimationFrame(loop);
      if (this.opts.frameCap && !this.opts.capture && now - this.lastNow < MIN_FRAME_GAP_MS) return;
      try {
        this.tick(now);
      } catch (e) {
        if (++this.frameErrors <= 3) console.error("ping-viz: frame failed", e);
      }
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }

  /** Scroll to chapter i (smoothly unless reduced motion). */
  jump(i: number, p = 0.04): void {
    const top = scrollFor(this.sections, i, p, window.innerHeight, this.readingLine());
    window.scrollTo({ top, behavior: this.opts.reducedMotion || this.opts.capture ? "instant" : "smooth" });
  }

  /** Fix the story at a position and scroll the text to match (for screenshots). Null releases it. */
  pin(s: number | null): void {
    this.pinned = s;
    if (s === null) return;
    this.sections = measure(this.storyRoot);
    const i = Math.floor(clamp(s, 0, CHAPTERS.length - 1e-6));
    window.scrollTo({
      top: scrollFor(this.sections, i, s - i, window.innerHeight, this.readingLine()),
      behavior: "instant",
    });
    this.story = s;
  }

  /**
   * Compile every scene's pipelines in the background (see Gfx.record): dry-run each chapter at a
   * few positions, one position per frame so the extra work per frame stays small (a few seconds in
   * all, while the reader is on the first card).
   */
  async warm(): Promise<void> {
    const gfx = this.renderer.gfx;
    const pass = new Proxy({}, { get: () => () => undefined }) as GPURenderPassEncoder;
    if (this.sections.length === 0) this.sections = measure(this.storyRoot);
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < CHAPTERS.length; i++) {
      for (const p of [0.03, 0.2, 0.35, 0.5, 0.65, 0.8, 0.97]) {
        jobs.push(
          gfx.record(() => {
            for (const slot of plan(i + p, this.sections).slots) {
              const scene = this.scenes.get(slot.scene);
              if (!scene) continue;
              try {
                scene.update(this.frameFor(slot, 0));
                scene.draw(pass);
              } catch {
                // The real frame will meet the same error and retire the scene; nothing to add here.
              }
            }
          }),
        );
        await new Promise((r) => requestAnimationFrame(r));
      }
    }
    await Promise.all(jobs);
  }

  /** Centres of a chapter's text cards as story progress (0..1), in the current layout. */
  cardCentres(id: string): number[] {
    return [...(this.sections.find((s) => s.id === id)?.cards ?? [])];
  }

  capture(): Promise<CapturedFrame> {
    return this.renderer.capture();
  }

  /** Frame timing since the last call (for the `?stats` overlay). */
  perf(): PerfSample {
    const n = this.perfFrames;
    const sample: PerfSample = {
      frames: n,
      cpuMs: n > 0 ? this.perfCpu / n : 0,
      gpuMs: this.gpuMs,
      worstGapMs: this.perfWorstGap,
      renderScale: this.renderScale,
      width: this.renderer.width,
      height: this.renderer.height,
      scenes: this.state?.slots.map((s) => s.scene) ?? [],
    };
    this.perfFrames = 0;
    this.perfCpu = 0;
    this.perfWorstGap = 0;
    return sample;
  }

  /** The cameras used for the last frame (debugging). */
  cameras(): readonly CameraState[] {
    return this.lastCameras;
  }

  /** Where "now" is on screen (see story/layout.ts). */
  private readingLine(): number {
    return this.layoutMode().narrow ? READING_LINE_NARROW : READING_LINE;
  }

  private layoutMode(): LayoutMode {
    const aspect = this.cssW / Math.max(1, this.cssH);
    if (isWide(this.cssW, this.cssH)) return { shift: { x: 0.3, y: 0 }, narrow: false, focusUv: [0.65, 0.5] };
    if (aspect < 0.9) return { shift: { x: 0, y: 0.3 }, narrow: true, focusUv: [0.5, 0.35] };
    return { shift: { x: 0, y: 0.12 }, narrow: true, focusUv: [0.5, 0.44] };
  }

  private resize(): void {
    const canvas = this.gpu.canvas;
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, this.opts.maxDpr);
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      this.needsMeasure = true;
    }
    this.cssW = w;
    this.cssH = h;
    this.renderer.resize(pw * this.renderScale, ph * this.renderScale);
  }

  /** Dynamic resolution: drop the render scale when frames run long, raise it after a calm stretch. */
  private adapt(dt: number): void {
    if (this.opts.capture || this.opts.fixedScale !== null || this.frame < 30) return;
    if (dt > 1 / 45) {
      this.slowFrames++;
      this.fastFrames = 0;
    } else if (dt < 1 / 57) {
      this.fastFrames++;
      this.slowFrames = Math.max(0, this.slowFrames - 1);
    }
    if (this.slowFrames > 20 && this.renderScale > 0.55) {
      this.renderScale = Math.max(0.55, this.renderScale - 0.1);
      this.slowFrames = 0;
    } else if (this.fastFrames > 240 && this.renderScale < 1) {
      this.renderScale = Math.min(1, this.renderScale + 0.05);
      this.fastFrames = 0;
    }
  }

  private frameFor(slot: SlotPlan, dt: number): SceneFrame {
    const mode = this.layoutMode();
    return {
      chapter: slot.chapter.id,
      p: slot.p,
      beat: slot.beat,
      cards: slot.cards,
      local: slot.local,
      // A still clock stops every ambient animation at once; scroll-driven motion stays.
      time: this.opts.reducedMotion ? 0 : this.time,
      dt,
      weight: slot.weight,
      aspect: this.cssW / Math.max(1, this.cssH),
      narrow: mode.narrow,
      focus: this.focus,
      reducedMotion: this.opts.reducedMotion,
    };
  }

  /** A scene that throws gets its placeholder, as one that fails to load does (scenes/index.ts). */
  private retire(id: SceneId, e: unknown): void {
    console.error(`ping-viz: scene "${id}" failed; showing a placeholder`, e);
    this.scenes.set(id, placeholder(id)(this.renderer.gfx));
  }

  private tick(now: number): void {
    const start = performance.now();
    if (this.lastNow >= 0) this.perfWorstGap = Math.max(this.perfWorstGap, now - this.lastNow);
    const dt = this.lastNow < 0 ? 1 / 60 : clamp((now - this.lastNow) / 1000, 0, 0.1);
    this.lastNow = now;
    this.time += this.opts.capture ? 1 / 60 : dt;
    this.frame++;
    this.adapt(dt);
    this.resize();
    if (this.needsMeasure || now - this.lastMeasure > 1500) {
      this.sections = measure(this.storyRoot);
      this.needsMeasure = false;
      this.lastMeasure = now;
    }

    const target = this.pinned ?? storyPosition(this.sections, window.scrollY, window.innerHeight, this.readingLine());
    if (this.pinned !== null || this.frame <= 2 || this.opts.capture) this.story = target;
    else this.story += (target - this.story) * approach(dt, this.opts.reducedMotion ? 0.04 : 0.12);
    const state = plan(this.story, this.sections);
    this.state = state;

    const mode = this.layoutMode();
    const draws: SlotDraw[] = [];
    const cams: CameraState[] = [];
    this.labels.begin();
    for (const slot of state.slots) {
      const scene = this.scenes.get(slot.scene);
      if (!scene) continue;
      const labels: Label[] = [];
      let pose: ReturnType<Scene["update"]>;
      try {
        pose = scene.update(this.frameFor(slot, dt));
        scene.labels(labels);
      } catch (e) {
        this.retire(slot.scene, e);
        continue;
      }
      const cam = cameraState({ ...pose, distance: pose.distance * slot.dolly }, [this.cssW, this.cssH], mode.shift);
      cams.push(cam);
      this.labels.place(slot.scene, labels, cam, slot.weight);
      draws.push({
        camera: cam,
        weight: slot.weight,
        draw: (pass) => {
          try {
            scene.draw(pass);
          } catch (e) {
            this.retire(slot.scene, e);
          }
        },
      });
    }
    this.labels.end();
    this.lastCameras = cams;
    this.renderer.render(draws, this.time, this.frame, { focus: mode.focusUv, ...this.opts.look });
    this.hud.update(state.index, state.p, state.chapter);
    this.perfFrames++;
    this.perfCpu += performance.now() - start;
    if (this.opts.stats && !this.gpuPending) this.timeGpu();
    this.onFrame?.();
  }

  /** Time from now (just after submit) until the GPU finishes this frame. One frame in flight at a time. */
  private timeGpu(): void {
    this.gpuPending = true;
    const t0 = performance.now();
    this.gpu.device.queue.onSubmittedWorkDone().then(
      () => {
        this.gpuMs = performance.now() - t0;
        this.gpuPending = false;
      },
      () => {
        this.gpuPending = false;
      },
    );
  }
}
