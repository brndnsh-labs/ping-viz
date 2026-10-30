// The agent loop: a track between your laptop and the model. Each lap carries the whole
// conversation out and a reply back; replies that ask for a tool make your machine do work (one of
// them is all of Act I), and the context in the middle grows every lap until it's compacted.
import { C, CSS, mixRgb, scaleRgb } from "../config";
import { BoxBatch } from "../render/boxes";
import { type CameraPose, fitNarrow, pose, poseAt } from "../render/camera";
import type { Gfx, Rgb } from "../render/gfx";
import { LineBatch } from "../render/lines";
import { PointBatch } from "../render/points";
import { circle, pointAt, slice } from "../render/shapes";
import { SphereBatch } from "../render/spheres";
import { piecewise, ramp, window as win } from "../util/ease";
import type { Vec3 } from "../util/math";
import type { Label, Scene, SceneFactory, SceneFrame } from "./scene";

const R = 6;
/** Context column height per token (1M tokens, the default window on current models, = 8 units). */
const PER_TOKEN = 1 / 125_000;
const LAPTOP: Vec3 = [-R, 0, 0];
const MODEL: Vec3 = [R, 0, 0];

// Top half of the ring: laptop → model. Bottom half: model → laptop.
const RING = circle([0, 0, 0], R, 160, [-1, 0, 0], [0, 0, -1]);
const OUTBOUND = RING.slice(0, 81);
const INBOUND = RING.slice(80);

const TOOLS = [
  "Bash: ping -c 1 google.com",
  "Read: src/app.ts",
  'Grep: "storyPosition"',
  "Edit: src/story/layout.ts",
  "Bash: npm test",
  "Read: test output",
  "Edit: src/story/layout.ts",
  "Bash: npm test",
  "Bash: git diff",
];

interface Lap {
  /** Tokens in the conversation when this lap's request goes out. */
  before: number;
  /** Tokens this lap adds: the reply and the tool result. */
  reply: number;
  result: number;
  compacted: boolean;
}

/** A deterministic session: 48 laps of file reads and test runs, compacted once when it passes ~900k tokens. */
const LAPS: Lap[] = (() => {
  const out: Lap[] = [];
  let total = 23_000;
  let compacted = false;
  for (let i = 0; i < 48; i++) {
    const reply = 300 + ((i * 137) % 500);
    const result = i === 0 ? 400 : 10_000 + ((i * 9_011) % 32_000);
    let didCompact = false;
    if (!compacted && total > 900_000) {
      total = 34_000;
      compacted = true;
      didCompact = true;
    }
    out.push({ before: total, reply, result, compacted: didCompact });
    total += reply + result;
  }
  return out;
})();

class LoopScene implements Scene {
  readonly id = "loop" as const;
  private readonly boxes: BoxBatch;
  private readonly lines: LineBatch;
  private readonly points: PointBatch;
  private readonly globe: SphereBatch;
  private out: Label[] = [];
  private beat = 0;
  private stackTop = 1;
  private showGlobe = 0;

  constructor(gfx: Gfx) {
    this.boxes = new BoxBatch(gfx, "loop-boxes");
    this.lines = new LineBatch(gfx, "loop-lines");
    this.points = new PointBatch(gfx, "loop-points");
    this.globe = new SphereBatch(gfx, "loop-globe");
  }

  private label(id: string, pos: Vec3, text: string, opts: Partial<Label> = {}): void {
    this.out.push({ id, pos, text, kind: "note", ...opts });
  }

  update(f: SceneFrame): CameraPose {
    this.boxes.begin();
    this.lines.begin();
    this.points.begin();
    this.globe.begin();
    this.out = [];
    this.lines.time = f.time;
    const b = f.beat;
    this.beat = b;

    // Lap position: lap 0 is the reply arriving (b0), then the tool (b1), lap 1 goes out (b2),
    // then a time-lapse through the rest of the session (b3).
    const lapF = piecewise(b, [
      [-0.5, 0.5],
      [0.05, 0.98],
      [1.2, 0.999],
      [1.6, 1.0],
      [2.3, 1.5],
      [2.55, 1.9],
      [3.5, 44.0],
    ]);
    const lap = Math.min(LAPS.length - 1, Math.floor(lapF));
    const u = lapF - Math.floor(lapF);
    const fast = ramp(b, 2.5, 2.9);

    // Track and stations.
    this.lines.polyline(RING, {
      color: C.dim,
      width: 1.2,
      glow: 3,
      level: 0.5,
      flow: { period: 0.9, speed: -0.9 - 6 * fast, duty: 0.08, intensity: 1.2 },
    });
    this.boxes.box([LAPTOP[0], 0.55, LAPTOP[2]], [1.8, 1.1, 1.3], {
      edge: C.user,
      edgeIntensity: 1.1,
      edgePx: 1.6,
      fill: scaleRgb(C.user, 0.01),
    });
    this.boxes.box([MODEL[0], 0.8, MODEL[2]], [1.8, 1.6, 1.8], {
      edge: C.claude,
      edgeIntensity: 1.1,
      edgePx: 1.6,
      fill: scaleRgb(C.claude, 0.01),
    });
    // Desktop: from the box's top-right corner, reading away from the text column on the left.
    // Phones (text below the picture): centred on top.
    const lp: Vec3 = f.narrow ? [LAPTOP[0], 1.55, LAPTOP[2]] : [LAPTOP[0] + 0.9, 1.25, LAPTOP[2] - 0.65];
    this.label("laptop", lp, "Claude Code, on your machine", {
      kind: "name",
      align: f.narrow ? "center" : "left",
      color: CSS.user,
    });
    this.label("model", [MODEL[0], 2.0, MODEL[2]], "the model", { kind: "name", align: "center", color: CSS.claude });

    // The traveller: the request (the whole context) on top, the reply underneath.
    const thinking = u >= 0.45 && u < 0.55;
    if (u < 0.45) {
      const t = u / 0.45;
      const p = pointAt(OUTBOUND, t);
      this.lines.polyline(slice(OUTBOUND, Math.max(0, t - 0.35), t, 16), {
        color: C.out,
        width: 2,
        glow: 6,
        level: 0,
        pulse: { at: 1, trail: 1, intensity: 3 + fast * 2 },
      });
      this.points.point(p, { color: scaleRgb(C.out, 2), px: 8, glow: 2.4, intensity: 2 });
    } else if (!thinking) {
      const t = (u - 0.55) / 0.45;
      const p = pointAt(INBOUND, t);
      this.lines.polyline(slice(INBOUND, Math.max(0, t - 0.35), t, 16), {
        color: C.claude,
        width: 2,
        glow: 6,
        level: 0,
        pulse: { at: 1, trail: 1, intensity: 3 + fast * 2 },
      });
      this.points.point(p, { color: scaleRgb(C.claude, 2), px: 8, glow: 2.4, intensity: 2 });
    } else {
      this.points.point([MODEL[0], 1.9, MODEL[2]], {
        color: C.claude,
        px: 30,
        glow: 1,
        intensity: 0.6 + 0.4 * Math.sin(f.time * 8),
      });
    }

    // b0: the reply ends in a tool call.
    const toolName = TOOLS[lap % TOOLS.length] as string;
    // Gone before the little globe arrives at b1; back, higher up, while the time-lapse cycles tools.
    this.label("tooluse", [LAPTOP[0] + 1.1, 3.2 + 1.6 * fast, LAPTOP[2] + 1.6], `tool_use → ${toolName}`, {
      kind: "mono",
      color: CSS.claude,
      opacity: win(b, -0.4, -0.1, 0.5, 0.75) + fast * 0.85 * (1 - ramp(b, 2.75, 2.95)),
    });
    this.label("stop", [LAPTOP[0] + 1.1, 2.8, LAPTOP[2] + 1.6], 'stop_reason: "tool_use"', {
      kind: "mono",
      opacity: win(b, -0.2, 0.05, 0.45, 0.7),
    });

    // b1: your machine runs it. For this command, that's Act I: a tiny globe and a 12 ms round trip.
    this.showGlobe = win(b, 0.55, 0.8, 1.5, 1.8);
    if (this.showGlobe > 0.01) {
      const g: Vec3 = [LAPTOP[0] + 2.2, 2.6, LAPTOP[2] + 0.9];
      this.globe.sphere(g, 0.75, {
        fill: [0.01, 0.015, 0.03],
        fillIntensity: this.showGlobe,
        rim: scaleRgb([0.15, 0.3, 0.7], this.showGlobe),
        rimPower: 3,
        halo: scaleRgb([0.08, 0.18, 0.5], this.showGlobe),
        haloWidth: 0.15,
      });
      const a: Vec3 = [g[0] - 0.35, g[1] + 0.35, g[2] + 0.62];
      const c: Vec3 = [g[0] + 0.3, g[1] + 0.05, g[2] + 0.7];
      const arcPts: Vec3[] = [a, [g[0] - 0.02, g[1] + 0.5, g[2] + 0.85], c];
      const pingT = (f.time * 1.3) % 1;
      this.lines.polyline(arcPts, {
        color: C.out,
        width: 1.5,
        glow: 4,
        level: 0.4 * this.showGlobe,
        pulse: { at: pingT, trail: 0.4, intensity: 4 * this.showGlobe },
      });
      this.label("act1", [g[0], g[1] + 1.2, g[2]], "round trip to Google: ~12 ms", {
        kind: "mono",
        align: "center",
        color: CSS.out,
        opacity: this.showGlobe,
      });
      this.label("perm", [LAPTOP[0], -0.6, LAPTOP[2] + 0.9], "permission check ✓", {
        kind: "note",
        align: "center",
        color: CSS.back,
        opacity: this.showGlobe,
      });
    }

    // The context, in the middle of the loop: grows every lap; compacted once.
    this.context(lap, u, b, fast);

    // b3: subagents, each with its own loop.
    const subs = ramp(b, 2.6, 2.95);
    if (subs > 0.01) {
      for (const [k, cx] of [-4.6, -0.6].entries()) {
        const c: Vec3 = [cx, 0, -R - 3.2 - k * 0.6];
        const ring = circle(c, 1.4, 64);
        this.lines.polyline(ring, { color: C.dim, width: 1, glow: 3, level: 0.5 * subs });
        this.lines.segment([LAPTOP[0] + 0.3, 0.3, LAPTOP[2] - 0.7], [c[0], 0, c[2] + 1.4], {
          color: C.user,
          width: 1,
          glow: 3,
          level: 0.3 * subs,
        });
        const a = f.time * (1.7 + k * 0.6) + k;
        this.points.point([c[0] + Math.cos(a) * 1.4, 0, c[2] + Math.sin(a) * 1.4], {
          color: scaleRgb(C.claude, 1.6),
          px: 5,
          glow: 2,
          intensity: subs * 1.6,
        });
      }
      this.label("subs", [-2.6, 1.4, -R - 3.6], "subagents: loops of their own", { align: "center", opacity: subs });
    }

    // Lap counter while the time-lapse runs.
    this.label("lap", [0, -1.1, R + 0.8], `lap ${lap + 1}`, {
      kind: "mono",
      align: "center",
      opacity: ramp(b, 1.6, 2.0),
    });

    // On desktop the whole ring runs wider than the room right of the text: the wide shots sit back
    // and to the right there.
    const d = f.narrow ? 0 : 1;
    const cam = poseAt(
      [
        { at: -0.5, pose: pose([-4.2, 1.2, 0.6], 11, -12, 26, 40) },
        { at: 0.9, pose: pose([-4.6, 1.8, 0.6], 10, -24, 22, 40) },
        { at: 2.0, pose: pose([-1.5 * d, 1.5, 0], 17 + 4 * d, -15, 30, 40) },
        { at: 3.5, pose: pose([-1.2 - 1.4 * d, 2.8, -1.5], 24 + 3 * d, -16, 38, 40) },
      ],
      b,
    );
    // The ring runs wider than the desktop frame is tall, so phones pull back further.
    return fitNarrow(cam, f, 1.15);
  }

  anchor(name: string): CameraPose | null {
    // "lap" serves both ends of the chapter (story/flights.ts): your laptop at the start, and at the end
    // the top of the conversation's stack, where each lap's reply and tool result land.
    if (name !== "lap") return null;
    if (this.beat < 1.5) return pose([LAPTOP[0] + 0.3, 0.7, 0.2], 3.5, -24, 22, 40);
    return pose([0, Math.max(0.5, this.stackTop - 0.4), 0], 3, -16, 20, 40);
  }

  /** The conversation as a stack: the starting request, then a slice per lap (reply + tool result). */
  private context(lap: number, u: number, b: number, fast: number): void {
    const x = 0;
    const z = 0;
    const w = 1.6;
    const first = LAPS[0] as Lap;
    // Show compaction as a short squash when the time-lapse passes it.
    const compactAt = LAPS.findIndex((l) => l.compacted);
    let y = 0;
    const slab = (tokens: number, col: Rgb, glow: number, cached: boolean): void => {
      const h = Math.max(0.02, tokens * PER_TOKEN);
      const c = cached ? mixRgb(col, C.cache, 0.55) : col;
      this.boxes.box([x, y + h / 2, z], [w, h * 0.96, w], {
        edge: c,
        edgeIntensity: glow,
        edgePx: 1,
        fill: scaleRgb(c, 0.02),
      });
      y += h;
    };
    const sending = u < 0.45;
    const past = compactAt >= 0 && lap >= compactAt;
    // The opening request (or, after compaction, the summary that replaced the history).
    slab(past ? 34_000 : first.before, past ? C.memory : C.system, 0.6, sending);
    const start = past ? compactAt : 0;
    for (let i = start; i < lap; i++) {
      const l = LAPS[i] as Lap;
      slab(l.reply, C.claude, 0.9, sending);
      slab(l.result, C.tools, 0.9, sending && i < lap - 1);
    }
    this.stackTop = y;
    const total = (LAPS[lap] as Lap).before;
    this.label("ctx", [x, y + 0.5, z], `context ≈ ${Math.round(total / 1000)}k tokens`, {
      kind: "mono",
      align: "center",
      opacity: ramp(b, 1.4, 1.8),
    });
    this.label("cached", [x + w, Math.max(0.6, y * 0.5), z], "cache hit", {
      kind: "note",
      color: CSS.cache,
      opacity: win(b, 1.75, 2.0, 2.45, 2.7),
    });
    if (past && lap - compactAt < 3) {
      this.label("compact", [x + w, y + 0.2, z], "compacted into a summary", { color: CSS.memory, opacity: fast });
    }
    // The model's context window, as a glass column the stack fills: it nears the top, then compacts.
    if (fast > 0.01) {
      const lim = 1_000_000 * PER_TOKEN;
      const s = w / 2 + 0.15;
      const foot: Vec3[] = [
        [x - s, 0, z - s],
        [x + s, 0, z - s],
        [x + s, 0, z + s],
        [x - s, 0, z + s],
      ];
      const top = foot.map(([fx, , fz]): Vec3 => [fx, lim, fz]);
      this.lines.polyline([...top, top[0] as Vec3], { color: C.memory, width: 1, glow: 3, level: 0.6 * fast });
      for (const [k, a] of foot.entries()) {
        this.lines.segment(a, top[k] as Vec3, { color: C.memory, width: 0.8, glow: 2, level: 0.12 * fast });
      }
      this.label("limit", [x + s, lim, z + s], "context limit", { kind: "note", color: CSS.memory, opacity: fast });
    }
  }

  draw(pass: GPURenderPassEncoder): void {
    this.boxes.draw(pass);
    if (this.showGlobe > 0.01) {
      this.globe.draw(pass, "solid");
      this.globe.draw(pass, "halo");
    }
    this.lines.draw(pass);
    this.points.draw(pass);
  }

  labels(out: Label[]): void {
    out.push(...this.out);
  }
}

const factory: SceneFactory = (gfx) => new LoopScene(gfx);
export default factory;
