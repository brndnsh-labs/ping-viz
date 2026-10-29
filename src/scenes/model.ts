// The model: what happens inside it. A transformer you can see: a stack of layers (faint planes)
// and the request as a row of token columns crossing every one of them. Each column is a token's
// residual stream, with a node where it passes through each layer.
//
// prefill: text → tokens → vectors; the whole prompt rises through the layers together, attention
// arcs looking back in each layer; then the truth: the cached prefix's keys and values are loaded,
// only your message computes, and the first token appears at the top.
// decode: the next-token distribution and the pick; one pass per token, each reading the KV cache;
// the batch stepping in lockstep; thinking tokens first, then the reply.
import { C, CSS, mixRgb, scaleRgb } from "../config";
import { BoxBatch } from "../render/boxes";
import { type CameraPose, type PoseKey, pose, poseAt } from "../render/camera";
import type { Gfx, Rgb } from "../render/gfx";
import { LineBatch } from "../render/lines";
import { PointBatch } from "../render/points";
import { piecewise, ramp, seg, window as win } from "../util/ease";
import { clamp, type Vec3 } from "../util/math";
import {
  type Arc,
  BAND,
  CANDIDATES,
  COLS,
  colX,
  FIRST_NEW,
  genX,
  hash2,
  LANE_COLS,
  LANE_DZ,
  LANE_HUES,
  LANE_OFFSET,
  LANES,
  LAYERS,
  layerY,
  MESSAGE,
  pickKey,
  prefillArcs,
  REWIND,
  rng,
  S,
  SEQ_A,
  SEQ_B,
  type Step,
  THINK_N,
  X_LAST,
  X_MIN,
  Y_IN,
  Y_OUT,
  Z_BACK,
  Z_FRONT,
} from "./model-layout";
import type { Label, Scene, SceneFactory, SceneFrame } from "./scene";

// ---- drawing helpers ---------------------------------------------------------------------------

/** Line style for the allocation-free writers below (one shared, mutable instance). */
interface Stroke {
  level: number;
  width: number;
  glow: number;
  pulseAt: number;
  pulseTrail: number;
  pulseInt: number;
  pulseFlare: number;
  flowPeriod: number;
  flowSpeed: number;
  flowDuty: number;
  flowInt: number;
  /** Arcs only: dim both ends over this fraction of the curve (0: off), down to `endFloor`. */
  ends: number;
  endFloor: number;
}

const ST: Stroke = {
  level: 0,
  width: 1,
  glow: 4,
  pulseAt: 0,
  pulseTrail: 0,
  pulseInt: 0,
  pulseFlare: 0,
  flowPeriod: 0,
  flowSpeed: 0,
  flowDuty: 0,
  flowInt: 0,
  ends: 0,
  endFloor: 1,
};

function stroke(level: number, width = 1.2, glow = 4): Stroke {
  ST.level = level;
  ST.width = width;
  ST.glow = glow;
  ST.pulseAt = 0;
  ST.pulseTrail = 0;
  ST.pulseInt = 0;
  ST.pulseFlare = 0;
  ST.flowPeriod = 0;
  ST.flowSpeed = 0;
  ST.flowDuty = 0;
  ST.flowInt = 0;
  ST.ends = 0;
  ST.endFloor = 1;
  return ST;
}

const ARC_PTS = new Float64Array(3 * 64);

/** Lines written straight into the instance data: hundreds of arcs a frame without garbage. */
class Lines extends LineBatch {
  private vert(
    x: number,
    y: number,
    z: number,
    s: number,
    c: Rgb,
    t: number,
    c2: Rgb,
    st: Stroke,
    last: boolean,
    total: number,
    k = 1,
  ): void {
    const o = this.alloc();
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = s;
    d[o + 4] = (c[0] + (c2[0] - c[0]) * t) * k;
    d[o + 5] = (c[1] + (c2[1] - c[1]) * t) * k;
    d[o + 6] = (c[2] + (c2[2] - c[2]) * t) * k;
    d[o + 7] = st.level;
    d[o + 8] = st.width;
    d[o + 9] = st.glow;
    d[o + 10] = last ? 1 : 0;
    d[o + 11] = 1;
    d[o + 12] = st.pulseAt * total;
    d[o + 13] = st.pulseTrail * total;
    d[o + 14] = st.pulseInt;
    d[o + 15] = st.pulseFlare;
    d[o + 16] = st.flowPeriod;
    d[o + 17] = st.flowSpeed;
    d[o + 18] = st.flowDuty;
    d[o + 19] = st.flowInt;
  }

  /** A straight segment, colour fading from ca to cb. */
  line(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    ca: Rgb,
    st: Stroke,
    cb: Rgb = ca,
  ): void {
    const total = Math.hypot(bx - ax, by - ay, bz - az);
    if (total < 1e-5 || st.level + st.pulseInt + st.flowInt <= 0.002) return;
    this.vert(ax, ay, az, 0, ca, 0, cb, st, false, total);
    this.vert(bx, by, bz, total, ca, 1, cb, st, true, total);
  }

  /** A quadratic arc a → b with control point c, n segments, colour fading from ca to cb. */
  arc(
    ax: number,
    ay: number,
    az: number,
    cx: number,
    cy: number,
    cz: number,
    bx: number,
    by: number,
    bz: number,
    n: number,
    ca: Rgb,
    cb: Rgb,
    st: Stroke,
  ): void {
    if (st.level + st.pulseInt + st.flowInt <= 0.002) return;
    const p = ARC_PTS;
    let total = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      const k0 = u * u;
      const k1 = 2 * u * t;
      const k2 = t * t;
      const j = i * 3;
      p[j] = k0 * ax + k1 * cx + k2 * bx;
      p[j + 1] = k0 * ay + k1 * cy + k2 * by;
      p[j + 2] = k0 * az + k1 * cz + k2 * bz;
      if (i > 0) total += Math.hypot(p[j] - p[j - 3], p[j + 1] - p[j - 2], p[j + 2] - p[j - 1]);
    }
    let s = 0;
    for (let i = 0; i <= n; i++) {
      const j = i * 3;
      if (i > 0) s += Math.hypot(p[j] - p[j - 3], p[j + 1] - p[j - 2], p[j + 2] - p[j - 1]);
      const t = i / n;
      let k = 1;
      if (st.ends > 0) {
        const e = Math.min(1, Math.min(t, 1 - t) / st.ends);
        k = st.endFloor + (1 - st.endFloor) * e * e * (3 - 2 * e);
      }
      this.vert(p[j], p[j + 1], p[j + 2], s, ca, t, cb, st, i === n, total, k);
    }
  }
}

/** Points written straight into the instance data. */
class Dots extends PointBatch {
  dot(
    x: number,
    y: number,
    z: number,
    c: Rgb,
    intensity: number,
    px: number,
    glow = 1.5,
    minPx = 1.25,
    size = 0,
  ): void {
    if (intensity <= 0.002) return;
    const o = this.alloc();
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = size;
    d[o + 4] = c[0];
    d[o + 5] = c[1];
    d[o + 6] = c[2];
    d[o + 7] = intensity;
    d[o + 8] = px;
    d[o + 9] = minPx;
    d[o + 10] = glow;
    d[o + 11] = 0;
  }
}

// ---- shaders -----------------------------------------------------------------------------------

// The prompt's lattice: one storage entry per column (x, colour, size), expanded to a node per layer
// here. States are uniforms, so the whole prompt animates without touching instance data:
//   user[1] = (waveA, litA, frontA, embedA)   everything computes: wave height (layers), weight,
//                                              front glow, columns embedded so far
//   user[2] = (waveB, litB, frontB, cacheSweep) only the new part computes; the prefix is loaded
//   user[3] = (layers, y0, dy, firstNew)
//   user[4] = (kvLayer, kvAmt, twinkle, idle)  decode reading the cache at one layer
//   user[5] = (cache rgb, how bright loaded-from-cache nodes are relative to computed ones)
const LATTICE_WGSL = /* wgsl */ `
fn getPoint(i: u32) -> PointInst {
  let nl = u32(batch.user[3].x);
  let col = i / nl;
  let layer = i - col * nl;
  let src = pts[col];
  let lf = f32(layer);
  let cf = f32(col);
  var o = src;
  o.pos = vec3f(src.pos.x, batch.user[3].y + lf * batch.user[3].z, 0.0);
  o.size = 0.0;
  o.shape = 0.0;
  let a = batch.user[1];
  let b = batch.user[2];
  let kv = batch.user[4];
  var compA = clamp(a.x - lf + 0.5, 0.0, 1.0);
  if (layer == 0u) {
    compA = max(compA, clamp(a.w - cf, 0.0, 1.0));
  }
  let fa = a.z * exp(-(lf - a.x) * (lf - a.x) * 2.2);
  var compB = 0.0;
  var fb = 0.0;
  var colB = src.color.rgb;
  if (cf >= batch.user[3].w) {
    compB = clamp(b.x - lf + 0.5, 0.0, 1.0);
    if (layer == 0u) {
      compB = 1.0;
    }
    fb = b.z * exp(-(lf - b.x) * (lf - b.x) * 2.2);
  } else {
    compB = clamp((b.w - cf) * 0.12, 0.0, 1.0) * batch.user[5].w;
    colB = batch.user[5].rgb;
  }
  let comp = compA * a.y + compB * b.y;
  // The compressed band is many columns per pixel: keep its wavefront from flaring.
  let front = (fa * a.y + fb * b.y) * select(0.3, 1.0, src.pos.y > 0.5);
  let read = kv.y * exp(-(lf - kv.x) * (lf - kv.x) * 2.5) * comp;
  var tw = 1.0;
  if (kv.z > 0.0) {
    tw = 1.0 + kv.z * 0.3 * sin(batch.misc.y * (0.7 + hash1(i) * 1.7) + hash1(i ^ 0x5bd1e995u) * TAU);
  }
  let inten = (kv.w + comp * 0.26 * tw + front * 0.5 + read * 0.3) * src.color.a * src.size;
  let rgb = mix(mix(src.color.rgb, colB, b.y), vec3f(1.0, 0.96, 0.9), min(front * 0.12, 0.2));
  o.color = vec4f(rgb, inten);
  return o;
}
`;

// Other conversations in the batch: one storage entry per lane (head offset, z, hue), expanded to
// LANE_COLS columns × layers. The newest column (the head) carries the step's pulse.
//   user[1] = (head x, pulse layer, pulse on, amount)
//   user[2] = (spacing, _, _, _)
//   user[3] = (layers, y0, dy, columns per lane)
const LANES_WGSL = /* wgsl */ `
fn getPoint(i: u32) -> PointInst {
  let nl = u32(batch.user[3].x);
  let nc = u32(batch.user[3].w);
  let per = nl * nc;
  let lane = i / per;
  let r = i - lane * per;
  let col = r / nl;
  let layer = r - col * nl;
  let src = pts[lane];
  let st = batch.user[1];
  let lf = f32(layer);
  let back = f32(nc - 1u - col);
  var o: PointInst;
  o.pos = vec3f(st.x + src.pos.x - back * batch.user[2].x, batch.user[3].y + lf * batch.user[3].z, src.pos.z);
  o.size = 0.0;
  o.px = 2.3;
  o.minPx = 1.0;
  o.glow = 1.4;
  o.shape = 0.0;
  var comp = 1.0;
  var front = 0.0;
  if (back < 0.5) {
    comp = mix(1.0, clamp(st.y - lf + 0.5, 0.0, 1.0), st.z);
    front = st.z * exp(-(lf - st.y) * (lf - st.y) * 2.2);
  }
  let fade = pow(max(1.0 - back / f32(nc), 0.0), 1.4);
  let inten = st.w * (0.2 * comp * fade + front * 2.2);
  o.color = vec4f(mix(src.color.rgb, vec3f(1.0), min(front * 0.4, 0.5)), inten);
  return o;
}
`;

// ---- constants -----------------------------------------------------------------------------------

/** Thinking tokens: the model's own colour, dimmed and desaturated. */
const THINK: Rgb = [0.52, 0.38, 0.37];
const PLANE: Rgb = [0.34, 0.42, 0.62];
const WHITE: Rgb = [1, 0.97, 0.92];
const N_COLS = COLS.length;
const MSG_X0 = colX(FIRST_NEW);
/**
 * Arcs bow upward, leaning a little back or forward. (Bowing toward the viewer would flatten them
 * onto the row in a three-quarter view.)
 */
const BOW_UP = Math.cos(24 * (Math.PI / 180));
const BOW_OUT = Math.sin(24 * (Math.PI / 180));

// The bar chart above the top layer (decode b0).
const CHART_X0 = X_LAST - 0.7;
const CHART_Y0 = Y_OUT + 0.62;
const CHART_GAP = 0.2;
const CHART_BAR = 3.0;
const chartY = (k: number): number => CHART_Y0 + (CANDIDATES.length - 1 - k) * CHART_GAP;
/** Where a produced token waits above its column before it drops into the next one. */
const Y_NEXT = Y_OUT + 0.3;

/** A soft staircase: holds at each whole layer, then moves on (the wave goes layer by layer). */
function stair(w: number): number {
  const k = Math.floor(w);
  const fr = w - k;
  const t = clamp((fr - 0.3) / 0.7, 0, 1);
  return k + t * t * (3 - 2 * t);
}

const sectionColor = (c: number): Rgb => (COLS[c] as (typeof COLS)[number]).color;

// ---- camera ------------------------------------------------------------------------------------

// Keyed on u: prefill beats -0.5..2.5 → 0..3, decode beats -0.5..3.5 → 3..7 (one continuous move).
const MID_X = (X_MIN + X_LAST) / 2;

/** A camera key, plus how phones change it: distance × k, target nudged by (dx, dy). */
interface Shot {
  at: number;
  pose: CameraPose;
  phone?: [k: number, dx: number, dy: number];
}

const SHOTS: Shot[] = [
  { at: 0, pose: pose([MID_X + 1.6, 2.0, 0.4], 15, 34, 16, 38) },
  { at: 0.5, pose: pose([1.8, 0.0, 0.25], 6.4, 22, 9, 38), phone: [1.9, 0.2, -0.1] },
  { at: 1.0, pose: pose([0.6, 1.5, 0.3], 11, 36, 16, 38) },
  { at: 1.5, pose: pose([MID_X + 1.2, 2.4, 0.4], 15, 46, 22, 38) },
  { at: 2.5, pose: pose([1.2, 2.7, 0.3], 13.5, 40, 18, 38) },
  { at: 2.95, pose: pose([1.7, 3.6, 0.3], 12, 38, 15, 38) },
  { at: 3.38, pose: pose([2.75, 6.4, 0.2], 5.6, 21, 5, 38), phone: [1.8, 0.2, -0.15] },
  { at: 3.62, pose: pose([2.75, 6.4, 0.2], 5.3, 19, 5, 38), phone: [1.8, 0.2, -0.15] },
  { at: 4.0, pose: pose([2.0, 3.8, 0.3], 10, 40, 14, 38) },
  { at: 4.5, pose: pose([1.4, 2.7, 0.3], 12, 52, 20, 38) },
  { at: 4.95, pose: pose([1.6, 2.7, 0.2], 12.5, 52, 21, 38) },
  { at: 5.5, pose: pose([2.0, 2.3, -2.3], 15.5, 50, 30, 38), phone: [2.25, 0.5, 0.2] },
  { at: 6.5, pose: pose([3.9, 3.0, 0.3], 12.5, 44, 17, 38), phone: [2.05, 0.3, 0.35] },
  { at: 7.0, pose: pose([4.0, 3.0, 0.3], 12, 44, 17, 38), phone: [2.05, 0.3, 0.35] },
];
const PHONE_DEFAULT: [number, number, number] = [1.95, 0.45, -0.3];
const KEYS: PoseKey[] = SHOTS.map(({ at, pose }) => ({ at, pose }));
/** Phones: the subject gets about half the room, above the text. */
const KEYS_NARROW: PoseKey[] = SHOTS.map(({ at, pose: p, phone }) => {
  const [k, dx, dy] = phone ?? PHONE_DEFAULT;
  return { at, pose: { ...p, distance: p.distance * k, target: [p.target[0] + dx, p.target[1] + dy, p.target[2]] } };
});

// ---- the scene ---------------------------------------------------------------------------------

interface ColState {
  /** Lit height (layers, fractional), or -1 for not yet in. */
  up: number;
  color: Rgb;
}

class ModelScene implements Scene {
  readonly id = "model" as const;
  private readonly fills: BoxBatch;
  private readonly cells: BoxBatch;
  private readonly lattice: Dots;
  private readonly lanes: Dots;
  private readonly lines: Lines;
  private readonly dots: Dots;
  private readonly arcs: { all: Arc[]; fresh: Arc[] }[];
  private out: Label[] = [];
  private lanesOn = 0;
  /** The prompt's lattice brightness (it steps back once it's just the KV cache). */
  private latticeOn = 1;
  private reduced = false;

  constructor(gfx: Gfx) {
    this.fills = new BoxBatch(gfx, "model-planes", { blend: "add", depthWrite: false });
    this.cells = new BoxBatch(gfx, "model-cells", { blend: "add", depthWrite: false });
    this.lines = new Lines(gfx, "model-lines");
    this.dots = new Dots(gfx, "model-dots");
    this.dots.maxPx = 9;

    this.lattice = new Dots(gfx, "model-lattice", {}, { key: "model-lattice", wgsl: LATTICE_WGSL });
    for (const c of COLS) {
      const px = c.kind === 2 ? 3.3 : c.kind === 1 ? 2.6 : 2.4;
      const base = c.kind === 2 ? 1.3 : c.kind === 1 ? 1.0 : 0.5;
      this.lattice.dot(c.x, c.kind, 0, c.color, base, px, c.kind === 0 ? 2.2 : 1.5, 1.0, c.fade);
    }
    this.lattice.procedural = N_COLS * LAYERS;
    const u = this.lattice.user;
    u[12] = LAYERS;
    u[13] = 0;
    u[14] = layerY(1);
    u[15] = FIRST_NEW;
    u[20] = C.cache[0];
    u[21] = C.cache[1];
    u[22] = C.cache[2];
    u[23] = 0.38;

    this.lanes = new Dots(gfx, "model-lanes", {}, { key: "model-lanes", wgsl: LANES_WGSL });
    for (let k = 0; k < LANES; k++) {
      this.lanes.dot(LANE_OFFSET[k] as number, 0, -(k + 1) * LANE_DZ, LANE_HUES[k] as Rgb, 1, 2, 1, 1, 1);
    }
    this.lanes.procedural = LANES * LANE_COLS * LAYERS;
    const v = this.lanes.user;
    v[8] = S;
    v[12] = LAYERS;
    v[13] = 0;
    v[14] = layerY(1);
    v[15] = LANE_COLS;

    this.arcs = [];
    for (let l = 0; l < LAYERS; l++) this.arcs.push(prefillArcs(l));
  }

  update(f: SceneFrame): CameraPose {
    this.lines.begin();
    this.dots.begin();
    this.fills.begin();
    this.cells.begin();
    this.out = [];
    this.lanesOn = 0;
    this.latticeOn = 1;
    this.reduced = f.reducedMotion;
    const decode = f.chapter === "decode";
    if (decode) this.decode(f.beat, f);
    else this.prefill(f.beat, f);
    this.lattice.time = f.time;
    this.lines.time = f.reducedMotion ? 0 : f.time;
    const u = decode ? 3.5 + f.beat : f.beat + 0.5;
    return poseAt(f.narrow ? KEYS_NARROW : KEYS, u);
  }

  // ---- the lattice (the prompt's columns) --------------------------------------------------------

  private setLattice(
    a: { wave: number; lit: number; front: number; embed: number },
    b: { wave: number; lit: number; front: number; sweep: number },
    kv: { layer: number; amt: number },
  ): void {
    const u = this.lattice.user;
    u[4] = a.wave;
    u[5] = a.lit;
    u[6] = a.front;
    u[7] = a.embed;
    u[8] = b.wave;
    u[9] = b.lit;
    u[10] = b.front;
    u[11] = b.sweep;
    u[16] = kv.layer;
    u[17] = kv.amt;
    u[18] = this.reduced ? 0 : 1;
    u[19] = 0.035;
  }

  /** The prompt's residual streams (the sampled columns; the band is nodes only). */
  private promptColumns(state: (c: number) => ColState, dim = 1): void {
    for (let c = BAND; c < N_COLS; c++) {
      const s = state(c);
      const x = colX(c);
      const fresh = c >= FIRST_NEW;
      const yLit = s.up < 0 ? Y_IN : s.up >= LAYERS - 0.5 ? Y_OUT : Math.max(Y_IN, layerY(s.up));
      if (yLit > Y_IN + 1e-3) {
        const k = s.color === C.cache ? 0.6 : 1;
        this.lines.line(
          x,
          Y_IN,
          0,
          x,
          yLit,
          0,
          s.color,
          stroke((fresh ? 0.15 : 0.075) * k * dim, fresh ? 1 : 0.8, fresh ? 3 : 2),
        );
      }
      if (yLit < Y_OUT - 1e-3) {
        this.lines.line(x, yLit, 0, x, Y_OUT, 0, s.color, stroke((fresh ? 0.04 : 0.025) * dim, 0.8, 2));
      }
    }
  }

  // ---- layer planes ------------------------------------------------------------------------------

  /** The layer stack; the `hot` layer (the wave or the pass) lights up, `sheet` sets how much its plane glows. */
  private planes(xRight: number, zBack: number, hot: number, hotAmt: number, sheet = 0.012, amt = 1): void {
    const x0 = X_MIN + 0.3;
    const x1 = xRight + 0.35;
    const z1 = Z_FRONT;
    const z0 = zBack;
    const none: Rgb = [0, 0, 0];
    for (let l = 0; l < LAYERS; l++) {
      const y = layerY(l);
      const h = hotAmt * Math.max(0, 1 - Math.abs(l - hot) * 0.9);
      const frame = l === 0 || l === LAYERS - 1 ? 0.5 : 0;
      const k = (0.03 + 0.24 * h + 0.06 * frame) * amt;
      const edge = mixRgb(PLANE, WHITE, h * 0.35);
      // The near edge and the far edge fade out toward the old end of the context.
      if (h > 0.02 || frame > 0) {
        this.lines.line(x0, y, z1, x1, y, z1, none, stroke(k, 1, 3), edge);
        this.lines.line(x1, y, z0, x0, y, z0, edge, stroke(k * 0.6, 1, 3), none);
      }
      this.lines.line(x1, y, z1, x1, y, z0, edge, stroke(k + 0.03 * amt, 1, 2.5));
      const fill = 0.0022 + sheet * h;
      this.fills.box([(x0 + x1) / 2, y - 0.004, (z0 + z1) / 2], [x1 - x0, 0.002, z1 - z0], {
        edge: PLANE,
        edgePx: 0,
        fill: scaleRgb(mixRgb(PLANE, WHITE, h * 0.3), fill * amt),
        fillIntensity: 1,
      });
    }
  }

  // ---- attention arcs ------------------------------------------------------------------------------

  /** One attention link at height y: from a key at x = xk to the query at xq, bowed up out of the row. */
  private link(
    xk: number,
    xq: number,
    y: number,
    z: number,
    side: number,
    ck: Rgb,
    cq: Rgb,
    w: number,
    amt: number,
    lift = 1,
  ): void {
    const dx = Math.abs(xq - xk);
    if (dx < 1e-4) return;
    const h = Math.min(1.1, 0.14 + 0.19 * dx ** 0.85) * lift;
    const n = Math.max(6, Math.min(18, Math.round(6 + dx * 2)));
    // Short hops are the most common links; dim them so they don't pile up into a rope on the row.
    const near = 0.3 + 0.7 * Math.min(1, dx / 1.2);
    const level = (0.1 + 0.75 * w) * amt * near;
    const st = stroke(level, 0.75 + 0.9 * w, 3 + 2.5 * w);
    st.ends = 0.22;
    st.endFloor = 0.15;
    if (!this.reduced) {
      st.flowPeriod = 0.22;
      st.flowSpeed = 0.55;
      st.flowDuty = 0.2;
      st.flowInt = 0.9 * w * amt * near;
    }
    this.lines.arc(xk, y, z, (xk + xq) / 2, y + 2 * h * BOW_UP, z - side * 2 * h * BOW_OUT, xq, y, z, n, ck, cq, st);
  }

  private prefillArcs(wave: number, amt: number, fresh: boolean, color: (c: number) => Rgb): void {
    if (amt <= 0.01) return;
    const l0 = Math.max(0, Math.floor(wave - 1));
    const l1 = Math.min(LAYERS - 1, Math.ceil(wave + 1));
    for (let l = l0; l <= l1; l++) {
      const k = clamp(1 - Math.abs(wave - l) * 1.3, 0, 1) * amt;
      if (k <= 0.01) continue;
      const set = this.arcs[l] as { all: Arc[]; fresh: Arc[] };
      const y = layerY(l);
      for (const a of fresh ? set.fresh : set.all) {
        this.link(colX(a.dst), colX(a.src), y, 0, a.side, color(a.dst), color(a.src), a.w, k, a.lift);
      }
    }
  }

  // ---- prefill -----------------------------------------------------------------------------------

  private prefill(b: number, f: SceneFrame): void {
    // b0: tokens in. The prefix is embedded in a quick sweep, your message token by token.
    const embed = piecewise(b, [
      [-0.02, 0],
      [0.2, FIRST_NEW],
      [0.37, FIRST_NEW + MESSAGE.length],
      [0.4, N_COLS + 2],
    ]);
    // b1: everything rises through every layer together.
    const waveA = stair(seg(b, 0.58, 1.42) * (LAYERS + 1) - 0.5);
    const frontA = win(b, 0.52, 0.62, 1.38, 1.46);
    // b2: rewind; the prefix comes from the cache; only your message computes.
    const litB = ramp(b, 1.52, 1.66);
    const sweep = seg(b, 1.64, 1.84) * (FIRST_NEW + 24);
    const waveB = stair(seg(b, 1.88, 2.3) * (LAYERS + 1) - 0.5);
    const frontB = win(b, 1.84, 1.92, 2.26, 2.34);
    this.setLattice(
      { wave: waveA, lit: 1 - litB, front: frontA, embed },
      { wave: waveB, lit: litB, front: frontB, sweep },
      { layer: 0, amt: 0 },
    );

    const stateA = (c: number): ColState => ({ up: embed > c ? Math.max(0, waveA) : -1, color: sectionColor(c) });
    const stateB = (c: number): ColState =>
      c >= FIRST_NEW ? { up: Math.max(0, waveB), color: C.prompt } : { up: sweep > c ? LAYERS : -1, color: C.cache };
    this.promptColumns((c) => {
      const a = stateA(c);
      if (litB <= 0) return a;
      const s = stateB(c);
      if (litB >= 1) return s;
      // While rewinding, the old state drains away before the new one appears.
      return litB < 0.5
        ? { up: a.up * (1 - litB * 2), color: a.color }
        : { up: s.up, color: mixRgb(a.color, s.color, litB) };
    });

    const hot = litB > 0.5 ? waveB : waveA;
    this.planes(X_LAST, Z_BACK, hot, litB > 0.5 ? frontB : frontA, 0.03);

    // Attention: every token's arcs while the whole prompt computes; only your message's later.
    const arcColorA = (c: number): Rgb => sectionColor(c);
    const arcColorB = (c: number): Rgb => (c >= FIRST_NEW ? C.prompt : C.cache);
    this.prefillArcs(waveA, frontA * (1 - litB), false, arcColorA);
    this.prefillArcs(waveB, frontB * litB, true, arcColorB);

    this.tokensIn(b, f);
    this.cacheMarks(b, f.narrow);

    // The first token: ready at the top of the last column.
    const first = ramp(b, 2.28, 2.4);
    if (first > 0) this.nextToken(X_LAST, first, f);
    this.label("first", [X_LAST, Y_NEXT, 0], "first token", {
      color: CSS.claude,
      dx: 10,
      opacity: first,
    });

    // Prefill labels.
    this.label("band", [f.narrow ? X_MIN + 2.6 : X_MIN + 0.9, Y_IN - 0.55, 0], "tens of thousands of tokens", {
      align: "center",
      opacity: win(b, 0.15, 0.5, 1.3, 1.6),
    });
    this.label("layers", [X_LAST + 0.5, layerY(LAYERS / 2), 0], "layers", {
      opacity: win(b, 0.55, 0.8, 1.3, 1.55),
    });
    this.label("attn", [X_LAST - 2.2, Y_OUT + 0.55, 0.6], "attention: each token looks back", {
      align: "center",
      color: CSS.prompt,
      opacity: win(b, 0.7, 0.9, 1.3, 1.5) * (f.narrow ? 0 : 1),
    });
  }

  /** b0: the message's tokens appear at the base, each becomes a vector that rises into its column. */
  private tokensIn(b: number, f: SceneFrame): void {
    const shown = 1 - ramp(b, 0.36, 0.6);
    if (shown <= 0) return;
    for (let j = 0; j < MESSAGE.length; j++) {
      const x = MSG_X0 + j * S;
      const t = -0.34 + j * 0.016;
      const op = ramp(b, t, t + 0.08) * shown;
      if (op <= 0) continue;
      const text = (MESSAGE[j] as string).trim();
      // Two staggered rows; phones show every other token (still two rows).
      const row = f.narrow ? (j >> 1) % 2 : j % 2;
      this.label(`tok${j}`, [x, Y_IN - 0.62, 0], text, {
        kind: "mono",
        align: "center",
        color: CSS.prompt,
        dy: row * 15,
        opacity: f.narrow && j % 2 === 1 ? 0 : op,
      });
      // The vector: a few cells, brightness = its numbers. They rise into the column's base.
      const rise = ramp(b, 0.02 + j * 0.009, 0.2 + j * 0.009);
      const gone = seg(rise, 0.7, 1);
      const vis = ramp(b, t + 0.05, t + 0.12) * (1 - gone);
      if (vis <= 0.01) continue;
      for (let k = 0; k < 6; k++) {
        const v = 0.25 + 0.75 * hash2(j, k);
        const y = Y_IN - 0.12 - k * 0.075 + rise * (0.12 + 5 * 0.075);
        if (y > Y_IN + 0.02) continue;
        this.cells.box([x, y, 0], [0.058, 0.058, 0.058], {
          edge: scaleRgb(C.prompt, 0.9 * v),
          edgePx: 1,
          edgeIntensity: vis,
          fill: scaleRgb(C.prompt, 0.35 * v),
          fillIntensity: vis,
        });
      }
    }
    // Your message, bracketed.
    const op = ramp(b, -0.2, 0.05) * shown;
    const yb = Y_IN - 0.9;
    this.lines.line(MSG_X0 - 0.05, yb, 0, X_LAST + 0.05, yb, 0, C.prompt, stroke(0.35 * op, 1, 3));
    this.label("msg", [(MSG_X0 + X_LAST) / 2, yb, 0], "the start of your message", {
      kind: "name",
      align: "center",
      color: CSS.prompt,
      dy: 14,
      opacity: op,
    });
    this.label("vec", [MSG_X0 - 0.16, Y_IN - 0.28, 0], "tokens → vectors", {
      align: "right",
      opacity: win(b, -0.05, 0.12, 0.45, 0.6) * shown * (f.narrow ? 0 : 1),
    });
  }

  /** b2: where the cache ends. */
  private cacheMarks(b: number, narrow: boolean): void {
    const on = win(b, 1.66, 1.82, 2.28, 2.46);
    if (on <= 0.01) return;
    const xb = (colX(FIRST_NEW - 1) + MSG_X0) / 2;
    const st = stroke(0.2 * on, 1, 3);
    st.flowPeriod = 0.12;
    st.flowSpeed = 0;
    st.flowDuty = 0.5;
    st.flowInt = 0.9 * on;
    this.lines.line(xb, Y_IN - 0.25, 0.02, xb, Y_OUT + 0.5, 0.02, scaleRgb(C.cache, 1.2), st);
    this.label("bp", [xb, Y_OUT + 0.5, 0], "cache breakpoint", {
      kind: "mono",
      align: "center",
      dy: -12,
      color: CSS.cache,
      opacity: on,
    });
    this.label("cached", [xb - (narrow ? 1.7 : 2.6), Y_IN - 0.45, 0], "keys and values: from the cache", {
      align: "center",
      color: CSS.cache,
      opacity: win(b, 1.72, 1.9, 2.28, 2.46),
    });
    this.label("fresh", [(MSG_X0 + X_LAST) / 2, Y_IN - 0.45, 0], "computed now", {
      align: "center",
      color: CSS.prompt,
      opacity: win(b, 1.86, 2.0, 2.28, 2.46),
    });
  }

  /** A produced token waiting above column x (a coral spark). */
  private nextToken(x: number, k: number, f: SceneFrame): void {
    const tw = this.reduced ? 1 : 0.85 + 0.15 * Math.sin(f.time * 5);
    this.lines.line(x, Y_OUT, 0, x, Y_NEXT, 0, C.claude, stroke(0.5 * k, 1.2, 4));
    this.dots.dot(x, Y_NEXT, 0, scaleRgb(C.claude, 1.6), 2.2 * k * tw, 7, 2.2);
  }

  // ---- decode ------------------------------------------------------------------------------------

  private decode(b: number, f: SceneFrame): void {
    const rewound = b >= REWIND[0] + (REWIND[1] - REWIND[0]) * 0.5;
    const seq = rewound ? SEQ_B : SEQ_A;
    const fadeA = rewound ? 1 : 1 - ramp(b, REWIND[0], (REWIND[0] + REWIND[1]) / 2);

    // Which step is running, and how far its pass has risen (for the cache-read glow).
    let active: Step | null = null;
    let lastG = -1;
    // The layers grow to the right as columns arrive (smoothly, and back again when rewound).
    let xRight = X_LAST;
    for (const s of seq) {
      if (b >= s.t0) {
        lastG = s.g;
        xRight = Math.max(xRight, genX(s.g - 1) + S * seg(b, s.t0, s.t1));
      }
      if (b >= s.t1 && b < s.t2) active = s;
    }
    xRight = X_LAST + (xRight - X_LAST) * fadeA;
    const pulse = active ? this.pulseLayer(b, active) : -2;
    this.setLattice(
      { wave: -1, lit: 0, front: 0, embed: 0 },
      { wave: LAYERS + 1, lit: 1, front: 0, sweep: N_COLS + 30 },
      { layer: pulse, amt: active ? 0.7 : 0 },
    );
    // Batching: other conversations, behind yours, in lockstep.
    this.lanesOn = win(b, 1.5, 1.7, 2.42, 2.56);
    this.latticeOn = 1 - 0.25 * ramp(b, -0.45, 0.1) - 0.3 * this.lanesOn;
    this.promptColumns((c) => ({ up: LAYERS, color: c >= FIRST_NEW ? C.prompt : C.cache }), this.latticeOn);
    const zBack = Z_BACK + (-(LANES * LANE_DZ) - 0.45 - Z_BACK) * ramp(b, 1.45, 1.75) * (1 - ramp(b, 2.42, 2.6));
    this.planes(xRight, zBack, pulse, active ? 1 : 0);

    this.chart(b, f);
    this.generated(b, seq, fadeA, f);
    if (this.lanesOn > 0.01) this.batch(b, active, pulse);
    // Rewound: the first token is back at the top, ready to start the real sequence.
    const s0 = SEQ_B[0] as Step;
    if (rewound && b < s0.t0 + 0.002) this.nextToken(X_LAST, ramp(b, REWIND[1] - 0.04, REWIND[1]), f);

    // Labels.
    // Introduced on the first pass, riding just above its fan.
    const first = SEQ_A[0] as Step;
    const kvY = layerY(clamp(this.pulseLayer(b, first), 0, LAYERS - 1)) + 1.15;
    this.label("kv", [X_LAST - 2.3, kvY, -0.35], "reading the KV cache", {
      align: "center",
      color: CSS.cache,
      opacity: win(b, first.t1 + 0.04, first.t1 + 0.12, first.t2 - 0.04, first.t2 + 0.04),
    });
    this.label("lanes", [X_LAST - 2.6, Y_OUT + 0.3, -LANES * LANE_DZ], "other conversations, same step", {
      align: "center",
      opacity: win(b, 1.62, 1.8, 2.35, 2.5),
    });
    if (rewound) {
      const thinkMid = (genX(0) + genX(THINK_N - 1)) / 2;
      const replyMid = (genX(THINK_N) + genX(Math.max(THINK_N, lastG))) / 2;
      this.label("think", [thinkMid, Y_OUT + 0.55, 0], "thinking", {
        align: "center",
        color: CSS.muted,
        opacity: ramp(b, 2.64, 2.74),
      });
      this.label("reply", [replyMid, Y_OUT + 0.55, 0], "reply", {
        kind: "name",
        align: "center",
        color: CSS.claude,
        opacity: ramp(b, 2.9, 2.98),
      });
    }
  }

  private pulseLayer(b: number, s: Step): number {
    return -0.6 + seg(b, s.t1, s.t2) * (LAYERS + 0.4);
  }

  /** The next-token distribution over the top of the stack, and the pick. */
  private chart(b: number, f: SceneFrame): void {
    // The first token, still waiting at the top from the end of prefill.
    const wait = 1 - ramp(b, -0.3, -0.12);
    if (wait > 0) this.nextToken(X_LAST, wait, f);
    this.label("first", [X_LAST, Y_NEXT, 0], "first token", {
      color: CSS.claude,
      dx: 10,
      opacity: 1 - ramp(b, -0.42, -0.3),
    });
    const on = win(b, -0.42, -0.24, 0.3, 0.5);
    if (on <= 0.01) return;
    const pick = ramp(b, -0.08, 0.06);
    const top = chartY(0);
    // From the last column's top into the chart: its vector becomes scores, the scores probabilities.
    const st = stroke(0.3 * on, 1, 3);
    st.pulseAt = seg(b, -0.42, -0.2);
    st.pulseTrail = 0.6;
    st.pulseInt = 2 * on;
    this.lines.arc(X_LAST, Y_OUT, 0, X_LAST, Y_OUT + 0.35, 0, CHART_X0, CHART_Y0 - 0.12, 0, 10, C.prompt, C.prompt, st);
    this.lines.line(CHART_X0, CHART_Y0 - 0.12, 0, CHART_X0, top + 0.12, 0, C.cache, stroke(0.35 * on, 1, 2));
    for (const [k, [tok, p]] of CANDIDATES.entries()) {
      const y = chartY(k);
      const grow = ramp(b, -0.3 + k * 0.03, -0.12 + k * 0.03);
      const len = p * CHART_BAR * grow;
      const chosen = k === 0;
      const c = chosen ? mixRgb(WHITE, C.claude, pick) : mixRgb(WHITE, C.cache, pick);
      const level = on * (chosen ? 0.55 + 1.2 * pick : 0.55 - 0.3 * pick);
      if (len > 0.004) this.lines.line(CHART_X0 + 0.02, y, 0, CHART_X0 + len, y, 0, c, stroke(level, 5.5, 5));
      const op = on * ramp(b, -0.28 + k * 0.03, -0.18 + k * 0.03);
      this.label(`ct${k}`, [CHART_X0, y, 0], tok, {
        kind: "mono",
        align: "right",
        color: chosen && pick > 0.5 ? CSS.claude : CSS.prompt,
        opacity: op * (chosen ? 1 : 1 - 0.45 * pick),
      });
      this.label(`cp${k}`, [CHART_X0 + len, y, 0], p.toFixed(2), {
        kind: "mono",
        color: chosen && pick > 0.5 ? CSS.claude : CSS.muted,
        opacity: op * (chosen ? 1 : 1 - 0.45 * pick),
      });
    }
    this.label("ctitle", [CHART_X0, top + 0.28, 0], "next token · probabilities illustrative", {
      dx: -8,
      opacity: on * ramp(b, -0.3, -0.18),
    });
    this.label("cvocab", [CHART_X0, CHART_Y0 - 0.32, 0], "… and the rest of the vocabulary", {
      dx: -8,
      opacity: on * ramp(b, -0.24, -0.14) * (1 - pick * 0.6),
    });
  }

  /** The generated tokens' columns: drop in, one pass up, the next token out. */
  private generated(b: number, seq: readonly Step[], fade: number, f: SceneFrame): void {
    if (fade <= 0.01) return;
    let lastDone: Step | null = null;
    let caption = "";
    let more = false;
    for (const [i, s] of seq.entries()) {
      if (b < s.t0) break;
      const x = genX(s.g);
      const color = s.think ? THINK : C.claude;
      const bright = s.think ? 0.42 : 1;
      if (b < s.t1) {
        this.drop(b, s, i > 0 ? genX((seq[i - 1] as Step).g) : X_LAST, x, color, fade);
        continue;
      }
      const phase = seg(b, s.t1, s.t2);
      const pl = this.pulseLayer(b, s);
      const running = phase < 1;
      const yLit = phase >= 1 ? Y_OUT : Math.max(Y_IN, Math.min(Y_OUT, layerY(pl)));
      const lit = stroke(0.36 * bright * fade, 1.4, 4.5);
      if (running) {
        lit.pulseAt = 1;
        lit.pulseTrail = 0.3;
        lit.pulseInt = 3 * fade;
        lit.pulseFlare = 2;
      }
      this.lines.line(x, Y_IN, 0, x, yLit, 0, color, lit);
      if (running) this.lines.line(x, yLit, 0, x, Y_OUT, 0, color, stroke(0.08 * fade, 1, 2.5));
      for (let l = 0; l < LAYERS; l++) {
        const comp = clamp(pl - l + 0.5, 0, 1);
        const front = running ? Math.exp(-(l - pl) * (l - pl) * 2.2) : 0;
        const inten = (0.05 + comp * 0.5 * bright + front * 2.6) * fade;
        this.dots.dot(
          x,
          layerY(l),
          0,
          front > 0.3 ? mixRgb(color, WHITE, 0.35) : color,
          inten,
          s.think ? 2.6 : 3.3,
          1.5,
        );
      }
      if (running) {
        for (let l = Math.max(0, Math.floor(pl - 1)); l <= Math.min(LAYERS - 1, Math.ceil(pl + 1)); l++) {
          const k = clamp(1 - Math.abs(pl - l) * 1.1, 0, 1) * fade;
          if (k > 0.01) this.fan(s, x, l, k, color, seq);
        }
      } else lastDone = s;
      if (!s.think && b >= s.t1 - 0.01) {
        if (s.text) caption += s.text;
        else more = true;
      }
    }
    // Each reply token leaves for home as soon as it exists (thinking stays put).
    if (seq === SEQ_B) {
      for (const [i, s] of seq.entries()) {
        const next = seq[i + 1];
        if (b < s.t2 || (next?.think ?? false)) continue;
        const u = seg(b, s.t2, s.t2 + 0.09);
        if (u >= 1) continue;
        const x = genX(s.g);
        const sx = x + u * 1.5;
        const sy = Y_NEXT + u * 0.35 + u * u * 0.9;
        this.dots.dot(sx, sy, 0, scaleRgb(C.claude, 1.5), 1.6 * (1 - u) * fade, 4.5, 2);
      }
    }
    // The reply so far, as text under its columns.
    if (caption) {
      const x0 = genX(seq === SEQ_B ? THINK_N : 0) - S * 0.4;
      this.label(seq === SEQ_B ? "replyB" : "replyA", [x0, Y_IN - 0.62, 0], more ? `${caption} …` : caption, {
        kind: "mono",
        color: CSS.claude,
        dx: -6,
        opacity: fade,
      });
    }
    // The last finished pass has produced the next token: it waits at the top until it drops.
    const last = seq[seq.length - 1] as Step;
    if (lastDone === last) this.nextToken(genX(last.g), fade * ramp(b, last.t2, last.t2 + 0.03), f);
  }

  /** A picked token falling into its new column (from the chart, or from the previous column's top). */
  private drop(b: number, s: Step, fromX: number, x: number, color: Rgb, fade: number): void {
    const t = seg(b, s.t0, s.t1);
    let hx: number;
    let hy: number;
    if (s.from === "chart") {
      // Off the end of the winning bar, over to the column, then down.
      const bx = CHART_X0 + (CANDIDATES[0] as readonly [string, number])[1] * CHART_BAR;
      const by = chartY(0);
      const hop = seg(t, 0, 0.35);
      const fall = seg(t, 0.35, 1);
      hx = bx + (x - bx) * hop;
      hy = by + (Y_OUT + 0.05 - by) * hop * hop + (Y_IN - (Y_OUT + 0.05)) * fall * fall;
      if (hop > 0) this.lines.line(x, Y_OUT, 0, x, Math.min(Y_OUT, hy), 0, color, stroke(0.12 * fade, 1, 3));
    } else {
      const hop = seg(t, 0, 0.25);
      const fall = seg(t, 0.25, 1);
      hx = fromX + (x - fromX) * hop;
      hy = Y_NEXT + (Y_IN - Y_NEXT) * fall * fall;
      if (fall > 0) this.lines.line(x, Y_OUT, 0, x, Math.min(Y_OUT, hy), 0, color, stroke(0.12 * fade, 1, 3));
    }
    this.dots.dot(hx, hy, 0, scaleRgb(color, 1.6), 2.2 * fade, 6.5, 2.2);
  }

  /** Decode attention: the new token, at one layer, looks back at every earlier column. */
  private fan(s: Step, xq: number, l: number, amt: number, cq: Rgb, seq: readonly Step[]): void {
    const r = rng(s.g * 7919 + l * 104729 + (seq === SEQ_B ? 31 : 17));
    const y = layerY(l);
    const n = 44;
    for (let k = 0; k < n; k++) {
      let xk: number;
      let ck: Rgb;
      if (s.g > 0 && r() < 0.2) {
        const g2 = Math.floor(r() * s.g);
        xk = genX(g2);
        ck = (seq[g2] as Step).think ? THINK : C.claude;
      } else {
        const c = pickKey(r, X_LAST + S, N_COLS);
        xk = colX(c);
        ck = c >= FIRST_NEW ? C.prompt : C.cache;
      }
      const w = 0.12 + 0.88 * r() ** 2.6;
      this.link(xk, xq, y, 0, r() < 0.8 ? 1 : -1, mixRgb(ck, cq, 0.35), cq, w, amt, 0.7 + 0.6 * r());
    }
  }

  /** Other conversations: lanes behind yours sharing the same layers, stepping together. */
  private batch(b: number, active: Step | null, pulse: number): void {
    const on = this.lanesOn;
    // The lockstep step running now (or the last one), so heads advance with ours.
    let step = SEQ_A[4] as Step;
    for (const s of SEQ_A) if (s.lockstep && b >= s.t0) step = s;
    const running = active?.lockstep === true;
    const headX = genX(step.g);
    const v = this.lanes.user;
    v[4] = headX;
    v[5] = running ? pulse : LAYERS;
    v[6] = running ? 1 : 0;
    v[7] = on;
    for (let k = 0; k < LANES; k++) {
      const z = -(k + 1) * LANE_DZ;
      const x = headX + (LANE_OFFSET[k] as number);
      const hue = LANE_HUES[k] as Rgb;
      const yLit = running ? Math.max(Y_IN, Math.min(Y_OUT, layerY(pulse))) : Y_OUT;
      const st = stroke(0.25 * on, 1.1, 3.5);
      if (running) {
        st.pulseAt = 1;
        st.pulseTrail = 0.3;
        st.pulseInt = 2.4 * on;
        st.pulseFlare = 1.6;
      }
      this.lines.line(x, Y_IN, z, x, yLit, z, hue, st);
      if (running) {
        this.lines.line(x, yLit, z, x, Y_OUT, z, hue, stroke(0.06 * on, 1, 2));
        const r = rng(k * 131 + step.g * 977);
        const l = Math.round(pulse);
        if (l >= 0 && l < LAYERS) {
          const amt = clamp(1 - Math.abs(pulse - l) * 1.1, 0, 1) * on;
          for (let j = 0; j < 9; j++) {
            const back = 1 + Math.floor(r() * r() * (LANE_COLS - 4));
            this.link(x - back * S, x, layerY(l), z, 1, scaleRgb(hue, 0.6), hue, 0.2 + 0.6 * r(), amt * 0.8);
          }
        }
      }
    }
  }

  // ---- output ------------------------------------------------------------------------------------

  private label(id: string, pos: Vec3, text: string, opts: Partial<Label> = {}): void {
    if ((opts.opacity ?? 1) <= 0.01) return;
    this.out.push({ id, pos, text, kind: "note", ...opts });
  }

  draw(pass: GPURenderPassEncoder): void {
    this.fills.draw(pass);
    this.lattice.opacity = this.latticeOn;
    this.lattice.draw(pass);
    if (this.lanesOn > 0.01) this.lanes.draw(pass);
    this.cells.draw(pass);
    this.lines.draw(pass);
    this.dots.draw(pass);
  }

  labels(out: Label[]): void {
    out.push(...this.out);
  }
}

const modelScene: SceneFactory = (gfx) => new ModelScene(gfx);
export default modelScene;
