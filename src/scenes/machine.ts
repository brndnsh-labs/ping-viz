// The laptop, exploded into three planes of light: hardware (violet), the kernel (cyan) and user space
// (amber). Act I follows one ping from the Enter key up through the layers to bash, out through the
// network stack, back in, and onto the screen; Act II starts claude on the same machine.
//
// Everything the story shows is a function of the beat; wall time only moves particles and dashes.
import { C, CSS, mixRgb, scaleRgb } from "../config";
import { REPLY, REQUEST } from "../net/packet";
import { BoxBatch } from "../render/boxes";
import { type CameraPose, eyeOf, type PoseKey, pose, poseAt } from "../render/camera";
import type { Gfx, Rgb } from "../render/gfx";
import { LineBatch, type LineStyle } from "../render/lines";
import { PointBatch } from "../render/points";
import { circle, filleted, pathLength, pointAt } from "../render/shapes";
import { SphereBatch } from "../render/spheres";
import { ramp, seg, smooth, window as win } from "../util/ease";
import { add, cross, lerp3, normalize, type Vec3 } from "../util/math";
import { type CellDraw, Cells, neck, rng, SEGMENTS } from "./machine-cells";
import { PANEL, Screen } from "./machine-display";
import {
  ANTENNA,
  ARCH,
  BOUNDS,
  type CellSpot,
  cellCenter,
  center,
  DISPLAY,
  ENTER,
  HW,
  K,
  KBD,
  KBD_D,
  KBD_W,
  KEY_U,
  KEYS,
  MCP,
  on,
  type Part,
  PLANES,
  type PlaneId,
  STACK_X,
  STAGES,
  stageZ,
  U,
  Y,
} from "./machine-layout";
import { type CardState, drawCard, fieldPos } from "./machine-packet";
import type { Label, Scene, SceneFactory, SceneFrame } from "./scene";

const CH = ["enter", "shell", "fork", "packet", "arrive", "print", "interlude", "launch"] as const;
type Ch = (typeof CH)[number];
const CARDS: Record<Ch, number> = {
  enter: 3,
  shell: 3,
  fork: 3,
  packet: 4,
  arrive: 3,
  print: 4,
  interlude: 1,
  launch: 3,
};
/** Position on the scene's timeline (like SceneFrame.local, but linear in beats). */
const T = (ch: Ch, b: number): number => CH.indexOf(ch) + (b + 0.5) / CARDS[ch];

const PLANE_RGB: Record<PlaneId, Rgb> = { hw: C.hardware, k: C.kernel, u: C.user };
const PLANE_CSS: Record<PlaneId, string> = { hw: CSS.hardware, k: CSS.kernel, u: CSS.user };
const PLANE_NAME: Record<PlaneId, string> = { hw: "hardware", k: "kernel", u: "user space" };
const CLAUDE_RGB = mixRgb(C.user, C.claude, 0.55);

/** The colour of a point by height: the plane it's on, blended across the gaps. */
function planeRgb(y: number): Rgb {
  if (y <= Y.k) return mixRgb(C.hardware, C.kernel, Math.min(1, Math.max(0, y / Y.k)));
  return mixRgb(C.kernel, C.user, Math.min(1, (y - Y.k) / (Y.u - Y.k)));
}

/** Piecewise through (x, y) stops, eased within each segment: moves out of a stop and settles into the next. */
function hop(x: number, pts: readonly (readonly [number, number])[]): number {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return 0;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i] as readonly [number, number];
    if (x <= b[0]) {
      const a = pts[i - 1] as readonly [number, number];
      return a[1] + (b[1] - a[1]) * smooth((x - a[0]) / Math.max(1e-6, b[0] - a[0]));
    }
  }
  return last[1];
}

// ---- routes: circuit traces with gates where they cross planes ----------------------------------

interface Route {
  pts: Vec3[];
  colors: Rgb[];
  /** Fraction of the length at the end of each leg. */
  marks: number[];
  length: number;
  /** Where vertical legs meet planes, and the fraction along the route. */
  gates: { p: Vec3; t: number }[];
}

/** Legs share their end points; each leg is filleted, joints between legs stay sharp (gates). */
function chain(legs: Vec3[][], radius = 0.2): Route {
  const pts: Vec3[] = [];
  const ends: number[] = [];
  const gateAt: number[] = [];
  for (const leg of legs) {
    const a = leg[0] as Vec3;
    const b = leg[leg.length - 1] as Vec3;
    const vertical = leg.length === 2 && Math.abs(b[1] - a[1]) > 0.5;
    const f = filleted(leg, radius, 6);
    if (pts.length) f.shift();
    if (vertical) gateAt.push(Math.max(0, pts.length - 1));
    pts.push(...f);
    if (vertical) gateAt.push(pts.length - 1);
    ends.push(pathLength(pts));
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i] as Vec3;
    const q = pts[i - 1] as Vec3;
    cum.push((cum[i - 1] as number) + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  }
  const length = cum[cum.length - 1] as number;
  const gates: { p: Vec3; t: number }[] = [];
  for (const i of gateAt) {
    const p = pts[i] as Vec3;
    if (gates.some((g) => Math.hypot(g.p[0] - p[0], g.p[1] - p[1], g.p[2] - p[2]) < 0.05)) continue;
    gates.push({ p, t: (cum[i] as number) / length });
  }
  return { pts, colors: pts.map((p) => planeRgb(p[1])), marks: ends.map((e) => e / length), length, gates };
}

function reverse(r: Route): Route {
  return {
    pts: [...r.pts].reverse(),
    colors: [...r.colors].reverse(),
    marks: [...r.marks].reverse().map((m) => 1 - m),
    length: r.length,
    gates: r.gates.map((g) => ({ p: g.p, t: 1 - g.t })),
  };
}

const hwy = (x: number, z: number, lift = 0.012): Vec3 => on("hw", x, z, lift);
const ky = (x: number, z: number): Vec3 => on("k", x, z);
const uy = (x: number, z: number): Vec3 => on("u", x, z);

const CPU = HW.cpu;
/** The cable from the keyboard's microcontroller to the host controller, a little above the board. */
const USB_LEG: Vec3[] = [hwy(-1.45, 1.78, 0.05), hwy(-0.85, 1.78, 0.05), hwy(-0.6, 1.9, 0.05), hwy(0.0, 1.9, 0.05)];
/** Host controller → CPU (the interrupt line), into the CPU's middle. */
const IRQ_LEG: Vec3[] = [hwy(0.9, 1.95), hwy(CPU.x, 1.95), hwy(CPU.x, CPU.z)];
/** CPU → kernel → input driver → compositor → terminal → pty → (bash's side). */
const SHELL_LEGS: Vec3[][] = [
  [hwy(CPU.x, CPU.z), ky(CPU.x, CPU.z)],
  [ky(CPU.x, CPU.z), ky(CPU.x, 2.25), ky(-3.75, 2.25)],
  [ky(-3.75, 2.25), uy(-3.75, 2.25)],
  [uy(-3.75, 2.25), uy(-3.75, 1.05)],
  [uy(-3.75, 1.05), uy(-2.6, 1.05), uy(-2.6, 0.55), uy(-1.45, 0.55)],
  [uy(-1.45, 0.55), uy(-0.55, 0.55)],
  [uy(-0.55, 0.55), ky(-0.55, 0.55)],
  [ky(-0.55, 0.55), ky(0.15, 0.55)],
  [ky(0.15, 0.55), uy(0.15, 0.55)],
];
const TABLE_X = K.route.x - K.route.w / 2;

const R = {
  usb: chain([USB_LEG]),
  dmaX: chain([[hwy(0.9, 1.62), hwy(1.15, 1.62), hwy(1.15, -0.94)]]),
  irqX: chain([IRQ_LEG]),
  shell: chain([...SHELL_LEGS, [uy(0.15, 0.55), uy(0.9, 0.55), uy(0.9, 0.05)]]),
  clone: chain([
    [uy(0.9, 0.05), ky(0.9, 0.05)],
    [ky(0.9, 0.05), ky(0.9, -2.6), ky(2.3, -2.6)],
  ]),
  execve: chain([[uy(U.child.x, U.child.z), ky(U.child.x, U.child.z)]]),
  execve2: chain([[uy(U.claude.x, U.claude.z), ky(U.claude.x, U.claude.z)]]),
  lookupRoute: chain([[ky(STACK_X + 0.4, 0.05), ky(TABLE_X, 0.05)]]),
  lookupNeigh: chain([[ky(STACK_X + 0.4, 0.95), ky(TABLE_X, 0.95)]]),
  antennaOut: chain([[hwy(HW.nic.x + HW.nic.w / 2, 2.75), hwy(ANTENNA[0], 2.75)]]),
  nicDma: chain([[hwy(4.075, 2.9), hwy(3.3, 2.9), hwy(3.3, -1.3), hwy(2.8, -1.3)]]),
  nicIrq: chain([[hwy(4.075, 2.6), hwy(3.0, 2.6), hwy(3.0, CPU.z), hwy(CPU.x, CPU.z)]]),
  wake: chain([
    [ky(3.62, -1.75), ky(3.1, -1.75), ky(3.1, -2.6)],
    [ky(3.1, -2.6), uy(3.1, -2.6)],
    [uy(3.1, -2.6), uy(4.6, -2.6), uy(4.6, -2.4)],
  ]),
  write: chain([
    [uy(4.6, -2.4), ky(4.6, -2.4)],
    [ky(4.6, -2.4), ky(4.6, -2.05), ky(0.15, -2.05), ky(0.15, 0.55)],
    [ky(0.15, 0.55), ky(-0.55, 0.55)],
    [ky(-0.55, 0.55), uy(-0.55, 0.55)],
    [uy(-0.55, 0.55), uy(-1.45, 0.55)],
  ]),
  render: chain([
    [uy(-1.45, 0.55), uy(-1.45, -0.45)],
    [uy(-1.45, -0.45), ky(-1.45, -0.45)],
    [ky(-1.45, -0.45), hwy(-1.45, -0.45)],
    [hwy(-1.45, -0.45), hwy(-1.45, -1.0)],
  ]),
  handoff: chain([[uy(-1.45, 0.55), uy(-2.6, 0.55), uy(-2.6, 1.05), uy(-3.75, 1.05)]]),
  /** Compositor → DRM/KMS → the display controller (in the GPU) → the panel. */
  scanout: chain([
    [uy(-3.75, 1.05), ky(-3.75, 1.05)],
    [ky(-3.75, 1.05), ky(-3.0, 1.05), ky(-3.0, -1.2), ky(-1.6, -1.2)],
    [ky(-1.6, -1.2), hwy(-1.6, -1.2)],
    [hwy(-1.6, -1.2), hwy(-1.6, -1.45), hwy(DISPLAY.x + DISPLAY.w / 2, -1.45)],
  ]),
  typing: chain([
    USB_LEG,
    [hwy(0.0, 1.9, 0.05), hwy(0.9, 1.95)],
    IRQ_LEG,
    ...SHELL_LEGS,
    [uy(0.15, 0.55), uy(0.15, -1.15), uy(U.claude.x, -1.15)],
  ]),
};
const R_USB_BACK = reverse(R.usb);
const R_CLONE_BACK = reverse(R.clone);

/** Static circuit traces on the hardware plane (buses), drawn dim. */
const BUSES: Vec3[][] = [
  USB_LEG,
  [hwy(0.9, 1.62), hwy(1.15, 1.62), hwy(1.15, -0.94)],
  [hwy(0.9, 1.95), hwy(CPU.x, 1.95), hwy(CPU.x, CPU.z + CPU.d / 2)],
  [hwy(1.65, CPU.z - CPU.d / 2), hwy(1.65, -0.94)],
  [hwy(2.25, CPU.z - CPU.d / 2), hwy(2.25, -0.94)],
  [hwy(CPU.x - CPU.w / 2, 0.6), hwy(-0.3, 0.6), hwy(-0.3, -1.45), hwy(-0.65, -1.45)],
  [hwy(-1.85, -1.45), hwy(-2.7, -1.45)],
  [hwy(CPU.x + CPU.w / 2, CPU.z), hwy(3.0, CPU.z), hwy(3.0, 2.6), hwy(4.075, 2.6)],
  [hwy(4.075, 2.9), hwy(3.3, 2.9), hwy(3.3, -1.3), hwy(2.8, -1.3)],
  [hwy(5.125, 2.75), hwy(ANTENNA[0], 2.75)],
];

// ---- camera ------------------------------------------------------------------------------------

const P = (x: number, y: number, z: number, d: number, yaw: number, pitch: number, fov = 38): CameraPose =>
  pose([x, y, z], d, yaw, pitch, fov);

interface Shot {
  at: number;
  wide: CameraPose;
  /** Phone framing (the subject sits above the text, which is narrow and tall). */
  narrow?: CameraPose;
}

const WIDE = P(0.55, Y.k, 0.05, 26, -17, 24);
const WIDE_N = P(0.5, Y.k + 0.2, 0.0, 50, -17, 25);
const BASH = cellCenter(U.bash as CellSpot);
const CHILD = cellCenter(U.child as CellSpot);
const PING = cellCenter(U.ping as CellSpot);

/** A shot; phones get the same view from further back unless given their own. */
const S = (at: number, wide: CameraPose, narrow: CameraPose | number = 1.6): Shot => ({
  at,
  wide,
  narrow:
    typeof narrow === "number"
      ? { ...wide, distance: wide.distance * narrow, pitch: wide.pitch + 3 * (Math.PI / 180) }
      : narrow,
});

const SHOTS: Shot[] = [
  // enter: macro on the Enter key, out along the cable, then pull back to reveal the machine.
  S(T("enter", -0.5), P(ENTER.c[0] + 0.1, 0.08, ENTER.c[2] + 0.05, 2.6, -24, 32, 34), 1.45),
  S(T("enter", 0.05), P(ENTER.c[0] + 0.2, 0.06, ENTER.c[2] + 0.02, 2.4, -18, 30, 34), 1.45),
  S(T("enter", 0.6), P(-1.25, 0.05, 1.8, 3.5, -10, 30), 1.7),
  S(T("enter", 1.15), P(-0.25, 0.05, 1.8, 3.7, -6, 34), 1.7),
  S(T("enter", 1.75), P(1.1, 0.1, 0.6, 6.4, -10, 40), 1.7),
  S(T("enter", 2.5), WIDE, WIDE_N),
  // shell: up through the kernel to the input driver, across user space, through the pty to bash.
  S(T("shell", 0.0), P(-1.3, Y.k * 0.55, 1.3, 15.5, -6, 24), 1.65),
  S(T("shell", 1.0), P(-1.9, (Y.k + Y.u) / 2 + 0.6, 0.9, 10.5, -12, 22), 1.65),
  S(T("shell", 2.0), P(-0.2, Y.u - 0.4, 0.4, 8.5, -10, 20), P(0.0, Y.u + 0.1, 0.3, 13, -8, 22)),
  // fork: bash parses, buds a copy (clone into the kernel and back), the copy execs ping.
  // (Phones aim at the cells themselves: the top plane would otherwise end up under the HUD.)
  S(
    T("fork", 0.0),
    P(BASH[0] + 0.45, BASH[1] - 0.05, BASH[2], 5.6, -12, 14, 36),
    P(BASH[0] + 0.3, BASH[1] - 0.1, BASH[2], 8.4, -10, 16, 36),
  ),
  S(T("fork", 1.0), P(1.7, Y.u - 0.5, -0.9, 7.0, -14, 22, 36), P(1.6, Y.u + 0.2, -0.6, 10.5, -12, 22, 36)),
  S(
    T("fork", 2.0),
    P(CHILD[0] + 0.2, Y.u - 0.35, CHILD[2], 5.6, -18, 18, 36),
    P(CHILD[0], Y.u + 0.25, CHILD[2], 8.6, -16, 20, 36),
  ),
  S(
    T("fork", 2.5),
    P(CHILD[0] + 0.2, Y.u - 0.2, CHILD[2], 5.2, -18, 16, 36),
    P(CHILD[0], Y.u + 0.3, CHILD[2], 8.2, -16, 18, 36),
  ),
  // packet: the card at ping, through the syscall gate, down the stack's gates, out of the NIC.
  S(T("packet", -0.5), P(STACK_X, Y.u + 1.05, -1.7, 4.8, -10, 10, 36), 1.55),
  S(T("packet", 0.05), P(STACK_X, Y.u + 0.95, -1.7, 4.6, -12, 10, 36), 1.55),
  S(T("packet", 0.28), P(STACK_X, Y.u + 0.85, -1.7, 4.8, -12, 11, 36), 1.55),
  S(T("packet", 0.6), P(STACK_X, Y.k + 1.2, -1.5, 6.0, -16, 14, 36), 1.55),
  S(
    T("packet", 1.35),
    P(STACK_X + 0.55, Y.k + 0.5, -0.2, 6.4, -26, 20, 36),
    P(STACK_X + 0.1, Y.k + 0.5, -0.2, 9.4, -22, 22, 36),
  ),
  S(
    T("packet", 2.2),
    P(STACK_X + 0.65, Y.k + 0.5, 0.8, 6.4, -28, 20, 36),
    P(STACK_X + 0.1, Y.k + 0.5, 0.8, 9.4, -24, 22, 36),
  ),
  S(T("packet", 2.85), P(STACK_X + 0.2, Y.k * 0.75, 2.2, 6.4, -26, 20, 36), 1.55),
  S(T("packet", 3.5), P(STACK_X + 0.6, 0.6, 2.7, 5.6, -22, 22, 36), 1.55),
  // arrive: in at the antenna, DMA and interrupt, up the gates, wake ping.
  S(T("arrive", -0.5), P(STACK_X + 1.0, 0.45, 2.6, 5.2, -10, 20, 36), 1.55),
  S(T("arrive", 0.25), P(3.5, 0.4, 0.9, 9.0, -16, 36), 1.6),
  S(T("arrive", 0.62), P(STACK_X + 0.4, Y.k * 0.7, 2.2, 7.2, -24, 24, 36), 1.55),
  S(
    T("arrive", 1.1),
    P(STACK_X + 0.8, Y.k + 0.4, 0.2, 6.8, -26, 22, 36),
    P(STACK_X, Y.k + 0.45, 0.05, 10.5, -14, 24, 36),
  ),
  S(T("arrive", 1.75), P(STACK_X - 0.6, (Y.k + Y.u) / 2 + 0.3, -1.9, 8.6, -22, 20, 36), 1.55),
  S(T("arrive", 2.5), P(PING[0] - 0.5, PING[1] - 0.3, PING[2] + 0.2, 6.0, -18, 16, 36), 1.55),
  // print: write() to the terminal, the GPU, the compositor, the screen (see lateShots); back to you.
  S(T("print", 0.15), P(1.4, (Y.k + Y.u) / 2 + 0.4, -0.6, 11.5, -18, 24), 1.65),
  S(T("print", 1.0), P(-2.0, Y.k + 0.5, -0.2, 13.5, -16, 26), 1.65),
  S(T("print", 1.55), P(-3.0, Y.k * 0.6, -0.4, 10.5, -12, 38), 1.65),
  S(T("print", 1.8), P(-3.2, Y.k * 0.45, -0.6, 9.0, -10, 44), 1.65),
];

// ---- the scene ---------------------------------------------------------------------------------

class MachineScene implements Scene {
  readonly id = "machine" as const;
  private readonly planeLines: Record<PlaneId, LineBatch>;
  private readonly buses: LineBatch;
  private readonly matrix: LineBatch;
  private readonly boxes: BoxBatch;
  private readonly bytes: BoxBatch;
  private readonly lines: LineBatch;
  private readonly points: PointBatch;
  /** Drawn without depth testing: the key matrix's wires seen through the keycaps, and the spark. */
  private readonly xray: LineBatch;
  private readonly xrayPts: PointBatch;
  private readonly glass: SphereBatch;
  private readonly dust: PointBatch;
  private readonly cells = new Cells();
  private readonly screen: Screen;
  private out: Label[] = [];

  // Per-frame state, set by the chapter functions and drawn afterwards.
  private readonly act = new Map<string, number>();
  private readonly named = new Map<string, number>();
  private planeOp: Record<PlaneId, number> = { hw: 1, k: 1, u: 1 };
  private planeNames = 0;
  private cellList: CellDraw[] = [];
  private card: CardState | null = null;
  private press = 0;
  private readonly keyLit = new Map<number, number>();
  private matrixLit = 0;
  private eye: Vec3 = [0, 0, 0];
  private narrow = false;
  private t = 0;
  private vis: [number, number, number, number] = [1, 0, 0, 0];
  private scan = -1;
  private reveal = false;
  private grid = 0;

  constructor(gfx: Gfx) {
    this.planeLines = {
      hw: new LineBatch(gfx, "machine-plane-hw"),
      k: new LineBatch(gfx, "machine-plane-k"),
      u: new LineBatch(gfx, "machine-plane-u"),
    };
    for (const id of PLANES) this.buildPlane(id);
    this.buses = new LineBatch(gfx, "machine-buses");
    for (const b of BUSES)
      this.buses.polyline(filleted(b, 0.18, 6), { color: C.hardware, width: 1, glow: 3, level: 0.16 });
    this.matrix = new LineBatch(gfx, "machine-matrix");
    for (let r = 0; r < 5; r++) {
      const z = KBD.z0 + (r + 0.5) * KEY_U;
      this.matrix.segment([KBD.x0, KBD.slab + 0.004, z], [KBD.x0 + KBD_W, KBD.slab + 0.004, z], {
        color: C.hardware,
        width: 0.8,
        glow: 2,
        level: 0.12,
      });
    }
    for (let c = 0; c < 15; c++) {
      const x = KBD.x0 + (c + 0.5) * KEY_U;
      this.matrix.segment([x, KBD.slab + 0.004, KBD.z0], [x, KBD.slab + 0.004, KBD.z0 + KBD_D], {
        color: C.hardware,
        width: 0.8,
        glow: 2,
        level: 0.12,
      });
    }
    this.boxes = new BoxBatch(gfx, "machine-boxes");
    this.bytes = new BoxBatch(gfx, "machine-bytes", { blend: "add", depthWrite: false });
    this.lines = new LineBatch(gfx, "machine-lines");
    this.points = new PointBatch(gfx, "machine-points");
    this.xray = new LineBatch(gfx, "machine-xray", { depthTest: false });
    this.xrayPts = new PointBatch(gfx, "machine-xray-pts", { depthTest: false });
    this.glass = new SphereBatch(gfx, "machine-cells");
    this.dust = new PointBatch(gfx, "machine-dust");
    this.dust.maxPx = 3;
    this.screen = new Screen(gfx);
  }

  private buildPlane(id: PlaneId): void {
    const b = this.planeLines[id];
    const y = Y[id] - 0.002;
    const { x0, x1, z0, z1 } = BOUNDS;
    const r = 0.4;
    const pts: Vec3[] = [];
    const corners: [number, number, number][] = [
      [x1 - r, z0 + r, -Math.PI / 2],
      [x1 - r, z1 - r, 0],
      [x0 + r, z1 - r, Math.PI / 2],
      [x0 + r, z0 + r, Math.PI],
    ];
    for (const [cx, cz, a0] of corners) {
      for (let k = 0; k <= 8; k++) {
        const a = a0 + (k / 8) * (Math.PI / 2);
        pts.push([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]);
      }
    }
    pts.push(pts[0] as Vec3);
    const col = PLANE_RGB[id];
    b.polyline(pts, { color: col, width: 1.3, glow: 5, level: 0.42 });
    const step = 0.5;
    const grid: LineStyle = { color: col, width: 0.7, glow: 0, level: 0.055 };
    for (let x = Math.ceil((x0 + 0.2) / step) * step; x < x1 - 0.2; x += step) {
      b.segment([x, y, z0 + 0.12], [x, y, z1 - 0.12], grid);
    }
    for (let z = Math.ceil((z0 + 0.2) / step) * step; z < z1 - 0.2; z += step) {
      b.segment([x0 + 0.12, y, z], [x1 - 0.12, y, z], grid);
    }
  }

  // ---- frame ------------------------------------------------------------------------------------

  update(f: SceneFrame): CameraPose {
    for (const b of [this.lines, this.points, this.boxes, this.bytes, this.glass, this.dust, this.xray, this.xrayPts]) {
      b.begin();
    }
    this.out = [];
    this.act.clear();
    this.named.clear();
    this.keyLit.clear();
    this.planeOp = { hw: 1, k: 1, u: 1 };
    this.planeNames = 0;
    this.cellList = [];
    this.card = null;
    this.press = 0;
    this.matrixLit = 0;
    this.vis = [1, 0, 0, 0];
    this.scan = -1;
    this.reveal = false;
    this.grid = 0;
    this.narrow = f.narrow;
    this.t = f.reducedMotion ? 0 : f.time;

    const ch = (CH as readonly string[]).includes(f.chapter) ? (f.chapter as Ch) : "interlude";
    const b = f.beat;
    const cam = this.camera(T(ch, b), f.narrow);
    this.eye = eyeOf(cam);

    switch (ch) {
      case "enter":
        this.enter(b);
        break;
      case "shell":
        this.shell(b);
        break;
      case "fork":
        this.fork(b);
        break;
      case "packet":
        this.packet(b, f.focus);
        break;
      case "arrive":
        this.arrive(b, f.focus);
        break;
      case "print":
        this.print(b);
        break;
      case "interlude":
        this.interlude(b);
        break;
      case "launch":
        this.launch(b);
        break;
    }

    this.drawParts();
    this.drawKeyboard();
    this.drawStack();
    this.drawDisplay();
    this.cells.draw(this.cellList, this.glass, this.dust, this.t);
    for (const c of this.cellList) {
      const name = this.named.get(`cell:${c.id}`) ?? 0;
      if (name > 0.01) this.cellName(c, name);
    }
    if (this.card) drawCard(this.card, this.bytes);
    for (const id of PLANES) this.planeLines[id].opacity = this.planeOp[id];
    if (this.planeNames > 0.01) {
      for (const id of PLANES) {
        if (this.planeOp[id] < 0.05) continue;
        this.label(`plane-${id}`, [BOUNDS.x1 - 0.9, Y[id], BOUNDS.z1], PLANE_NAME[id], {
          kind: "name",
          align: "center",
          dy: 14,
          color: PLANE_CSS[id],
          opacity: this.planeNames * this.planeOp[id],
        });
      }
    }
    this.screen.set({
      narrow: f.narrow,
      vis: this.vis,
      scan: this.scan,
      reveal: this.reveal,
      grid: this.grid,
      opacity: 1,
    });
    this.lines.time = this.t;
    this.buses.time = this.t;
    return cam;
  }

  private camera(x: number, narrow: boolean): CameraPose {
    const keys: PoseKey[] = [];
    for (const s of SHOTS) keys.push({ at: s.at, pose: narrow ? (s.narrow ?? s.wide) : s.wide });
    for (const s of this.lateShots(narrow)) keys.push(s);
    keys.sort((a, b) => a.at - b.at);
    const p = poseAt(keys, x);
    if (!narrow) return p;
    // Phones: a card centred on the reading line covers the middle of the screen, so lift the
    // subject higher than the renderer's default by aiming a little below it.
    const cp = Math.cos(p.pitch);
    const fwd: Vec3 = [-cp * Math.sin(p.yaw), -Math.sin(p.pitch), -cp * Math.cos(p.yaw)];
    const right = normalize(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    const k = 0.14 * 2 * p.distance * Math.tan((p.fov * Math.PI) / 360);
    return { ...p, target: [p.target[0] - up[0] * k, p.target[1] - up[1] * k, p.target[2] - up[2] * k] };
  }

  /** Shots that depend on the display layout (print's dive onto the screen), and Act II's. */
  private lateShots(narrow: boolean): PoseKey[] {
    const block = this.screen.block(narrow);
    const line = block.lines[2] as Vec3;
    const near: Vec3 = narrow ? line : [block.origin[0] + block.w * 0.34, line[1], line[2]];
    const fit = narrow ? block.w / 0.26 : block.w / 0.6;
    const pick = (s: Shot): CameraPose => (narrow ? (s.narrow ?? s.wide) : s.wide);
    const yaw = -24 * (Math.PI / 180);
    const claude = cellCenter(U.claude as CellSpot);
    return [
      { at: T("print", 2.02), pose: pose(near, narrow ? 1.6 : 1.25, 0, 78, 38) },
      { at: T("print", 2.25), pose: pose(line, fit, 0, 84, 38) },
      { at: T("print", 2.72), pose: pose(line, fit * 1.06, 0, 84, 38) },
      { at: T("print", 3.0), pose: pick(S(0, P(-2.6, 0.9, -1.0, 8.5, -8, 66), P(-2.6, 0.9, -1.0, 13, -8, 66))) },
      {
        at: T("print", 3.5),
        pose: pick(S(0, P(0.4, Y.k * 0.65, -0.3, 24, -14, 48), P(0.4, Y.k * 0.7, -0.3, 40, -14, 48))),
      },
      { at: T("interlude", 0.5), pose: narrow ? { ...WIDE_N, yaw } : { ...WIDE, yaw } },
      { at: T("launch", -0.2), pose: pick(S(0, P(1.6, Y.u - 0.1, -0.5, 8.0, -8, 18, 36), 1.6)) },
      {
        at: T("launch", 0.35),
        pose: pick(S(0, P(claude[0] - 0.4, claude[1] - 0.1, claude[2], 5.4, -14, 16, 36), 1.6)),
      },
      { at: T("launch", 1.1), pose: pick(S(0, P(3.5, claude[1] - 0.2, -1.0, 7.4, -18, 22, 36), 1.6)) },
      { at: T("launch", 2.0), pose: pick(S(0, { ...WIDE, distance: 21.5, yaw: -18 * (Math.PI / 180) }, WIDE_N)) },
      { at: T("launch", 2.5), pose: pick(S(0, { ...WIDE, distance: 22, yaw: -19 * (Math.PI / 180) }, WIDE_N)) },
    ];
  }

  // ---- drawing helpers --------------------------------------------------------------------------

  private label(id: string, pos: Vec3, text: string, opts: Partial<Label> = {}): void {
    if ((opts.opacity ?? 1) <= 0.01) return;
    this.out.push({ id, pos, text, kind: "note", ...opts });
  }

  private on(id: string, a: number): void {
    this.act.set(id, Math.max(this.act.get(id) ?? 0, a));
  }

  private name(id: string, a: number): void {
    this.named.set(id, Math.max(this.named.get(id) ?? 0, a));
  }

  /** A pulse travelling a route: the trace lit dimly, a bright trail, a head, and gate rings that flash. */
  private signal(
    r: Route,
    t: number,
    o: { shown?: number; base?: number; trail?: number; color?: Rgb; width?: number; head?: number } = {},
  ): void {
    const shown = o.shown ?? 1;
    if (shown <= 0.01) return;
    const style: LineStyle = {
      color: o.color ?? C.white,
      width: o.width ?? 1.5,
      glow: 5,
      level: (o.base ?? 0.12) * shown,
    };
    if (!o.color) style.colors = r.colors;
    if (t > 0 && t < 1.04) {
      style.pulse = {
        at: Math.min(t, 1),
        trail: Math.min(0.7, (o.trail ?? 1.4) / r.length),
        intensity: 5 * shown,
        flare: 2.5,
      };
    }
    this.lines.polyline(r.pts, style);
    if (t > 0 && t < 1) {
      const h = pointAt(r.pts, t);
      const c = o.color ?? planeRgb(h[1]);
      this.points.point(h, {
        color: mixRgb(scaleRgb(c, 2.2), [2, 2, 2], 0.3),
        px: 6 * (o.head ?? 1),
        glow: 2.4,
        intensity: 1.8 * shown,
      });
    }
    for (const g of r.gates) {
      const fl = Math.exp(-((((t - g.t) * r.length) / 0.3) ** 2));
      this.ring(g.p, 0.13, planeRgb(g.p[1]), (0.3 + 2.6 * fl) * shown);
    }
  }

  private ring(p: Vec3, r: number, color: Rgb, level: number): void {
    this.lines.polyline(circle([p[0], p[1] + 0.006, p[2]], r, 28), { color, width: 1.2, glow: 4, level });
  }

  private drawParts(): void {
    const parts: Part[] = [...Object.values(HW), ...Object.values(K)];
    for (const p of parts) {
      const op = this.planeOp[p.plane];
      if (op < 0.05) continue;
      const a = this.act.get(p.id) ?? 0;
      const col = PLANE_RGB[p.plane];
      const style = {
        edge: col,
        edgeIntensity: (0.62 + 3.2 * a) * op,
        edgePx: 1.3,
        fill: scaleRgb(col, (0.022 + 0.16 * a) * op),
      };
      if (p.id === "ram") {
        for (const dz of [-0.2, 0.2]) this.boxes.box([p.x, Y.hw + p.h / 2, p.z + dz], [p.w, p.h, 0.24], style);
      } else {
        this.boxes.box(center(p), [p.w, p.h, p.d], style);
      }
      const n = this.named.get(p.id) ?? 0;
      if (n > 0.01) {
        const right = p.label === "right";
        const at: Vec3 = right ? [p.x + p.w / 2, Y[p.plane] + p.h / 2, p.z] : [p.x, Y[p.plane] + p.h, p.z + p.d / 2];
        this.label(`part-${p.id}`, at, p.name, {
          kind: "name",
          align: right ? "left" : "center",
          dx: right ? 8 : 0,
          dy: right ? 0 : 13,
          color: PLANE_CSS[p.plane],
          opacity: n * op,
        });
      }
    }
  }

  private drawKeyboard(): void {
    const slabStyle = { edge: C.hardware, edgeIntensity: 0.55, edgePx: 1.1, fill: scaleRgb(C.hardware, 0.018) };
    this.boxes.box(
      [KBD.x0 + KBD_W / 2, KBD.slab / 2, KBD.z0 + KBD_D / 2],
      [KBD_W + 0.12, KBD.slab, KBD_D + 0.12],
      slabStyle,
    );
    for (const [i, k] of KEYS.entries()) {
      const enter = k === ENTER;
      const lit = this.keyLit.get(i) ?? 0;
      const down = enter ? this.press : lit;
      const c: Vec3 = [k.c[0], k.c[1] - down * 0.045, k.c[2]];
      const glow = enter ? 0.8 + 1.4 * this.press : 0.3 + 2.2 * lit;
      this.boxes.box(c, k.size, {
        edge: enter ? mixRgb(C.hardware, [1, 1, 1], 0.25) : C.hardware,
        edgeIntensity: glow,
        edgePx: enter ? 1.4 : 1,
        fill: scaleRgb(C.hardware, enter ? 0.03 + 0.12 * this.press : 0.012 + 0.1 * lit),
      });
    }
    // The key matrix: the Enter key's row and column connect while it's down.
    if (this.matrixLit > 0.01) {
      const y = KBD.slab + 0.006;
      const z = KBD.z0 + (ENTER.row + 0.5) * KEY_U;
      const x = KBD.x0 + (ENTER.col + 0.5) * KEY_U;
      const st: LineStyle = {
        color: mixRgb(C.hardware, [1, 1, 1], 0.35),
        width: 1.5,
        glow: 5,
        level: 1.6 * this.matrixLit,
      };
      this.xray.segment([KBD.x0, y, z], [KBD.x0 + KBD_W, y, z], st);
      this.xray.segment([x, y, KBD.z0], [x, y, KBD.z0 + KBD_D], st);
      this.xrayPts.point([x, y, z], { color: [1.2, 1.0, 1.8], px: 7, glow: 2.5, intensity: 1.4 * this.matrixLit });
    }
  }

  private drawStack(): void {
    if (this.planeOp.k < 0.05) return;
    const op = this.planeOp.k;
    const x0 = STACK_X - ARCH.w / 2;
    const x1 = STACK_X + ARCH.w / 2;
    for (const s of STAGES) {
      const a = this.act.get(`stage:${s.id}`) ?? 0;
      const pts = filleted(
        [
          [x0, Y.k, s.z],
          [x0, Y.k + ARCH.h, s.z],
          [x1, Y.k + ARCH.h, s.z],
          [x1, Y.k, s.z],
        ],
        0.12,
        6,
      );
      this.lines.polyline(pts, { color: C.kernel, width: 1.4, glow: 5, level: (0.32 + 2.4 * a) * op });
      const n = this.named.get(`stage:${s.id}`) ?? 0;
      if (n > 0.01) {
        this.label(`stage-${s.id}`, [x0, Y.k + ARCH.h, s.z], s.name, {
          kind: "name",
          align: "right",
          dy: -2,
          color: CSS.kernel,
          opacity: n * op * (this.narrow ? Math.min(1, a * 2) : 0.38 + 0.62 * Math.min(1, a * 2)),
        });
      }
    }
  }

  private drawDisplay(): void {
    const n = this.named.get("display") ?? 0;
    this.boxes.box([DISPLAY.x, 0.025, DISPLAY.z], [DISPLAY.w, 0.05, DISPLAY.d], {
      edge: C.hardware,
      edgeIntensity: 0.9 + 1.5 * (this.act.get("display") ?? 0),
      edgePx: 1.3,
      fill: [0.004, 0.005, 0.01],
    });
    // The terminal window on the desktop.
    const blk = this.screen.block(this.narrow);
    const m = 0.05;
    const wx0 = blk.origin[0] - m;
    const wx1 = blk.origin[0] + blk.w + m - 0.006;
    const wz0 = blk.origin[2] - m - 0.06;
    const wz1 = blk.origin[2] + blk.d + m - 0.006;
    const y = PANEL.y + 0.002;
    this.lines.polyline(
      filleted(
        [
          [wx0, y, wz0],
          [wx1, y, wz0],
          [wx1, y, wz1],
          [wx0, y, wz1],
          [wx0, y, wz0],
          [wx1, y, wz0],
        ],
        0.03,
        4,
      ).slice(0, -4),
      { color: [0.6, 0.66, 0.85], width: 0.9, glow: 2, level: 0.22 },
    );
    if (this.scan >= 0 && this.scan <= 1) {
      const z = PANEL.z0 + this.scan * DISPLAY.d;
      this.lines.segment([PANEL.x0 + 0.02, y + 0.003, z], [PANEL.x1 - 0.02, y + 0.003, z], {
        color: [0.75, 0.85, 1.0],
        width: 1.4,
        glow: 6,
        level: 1.6,
      });
    }
    if (n > 0.01) {
      this.label("display", [DISPLAY.x, 0.05, DISPLAY.z + DISPLAY.d / 2], "display", {
        kind: "name",
        align: "center",
        dy: 13,
        color: CSS.hardware,
        opacity: n,
      });
    }
  }

  private cellName(c: CellDraw, a: number): void {
    const text = c.name ?? CELL_NAMES[c.id] ?? c.id;
    this.label(`cell-${c.id}`, [c.c[0], c.c[1] + c.r, c.c[2]], text, {
      kind: "name",
      align: "center",
      dy: -12,
      color: c.id === "claude" ? CSS.claude : CSS.user,
      opacity: a * c.opacity,
    });
  }

  /** The processes that are always there. */
  private standing(glow: Partial<Record<"compositor" | "terminal" | "bash", number>> = {}, bashFill = 1): void {
    if (this.planeOp.u < 0.05) return;
    const op = this.planeOp.u;
    const seeds = { compositor: 11, terminal: 12, bash: 13 };
    for (const id of ["compositor", "terminal", "bash"] as const) {
      const s = U[id] as CellSpot;
      this.cellList.push({
        id,
        c: cellCenter(s),
        r: s.r,
        color: C.user,
        glow: glow[id] ?? 0,
        opacity: op,
        seed: seeds[id],
        bands: 0,
        fill: id === "bash" ? bashFill : 0.75,
      });
    }
  }

  /** The Enter key's contacts closing: a flash and sparks. */
  private spark(flash: number, u: number): void {
    if (flash <= 0.01 && (u <= 0 || u >= 1)) return;
    const base: Vec3 = [KBD.x0 + (ENTER.col + 0.5) * KEY_U, KBD.slab + 0.01, ENTER.c[2]];
    if (flash > 0.01) this.xrayPts.point(base, { color: [1.6, 1.4, 2.2], px: 16, glow: 3, intensity: 2.4 * flash });
    if (u > 0 && u < 1) {
      const r = rng(5);
      for (let i = 0; i < 12; i++) {
        const a = (r() - 0.5) * Math.PI * 1.3;
        const up = 0.2 + r() * 0.9;
        const sp = 0.12 + r() * 0.2;
        const d = smooth(u) * sp;
        const p = add(base, [Math.sin(a) * d, up * d * 0.7 - 0.25 * u * u * sp, Math.cos(a) * d]);
        this.xrayPts.point(p, { color: [1.4, 1.2, 2.0], px: 2.5, glow: 2, intensity: 1.6 * (1 - u) ** 2 });
      }
    }
  }

  /** The 8-byte HID report riding the USB cable: modifiers, reserved, six key slots (Enter = 0x28). */
  private hidReport(t: number, shown: number, labels: number): Vec3 | null {
    if (shown <= 0.01) return null;
    const r = R.usb;
    const sp = 0.105 / r.length;
    const head = 7 * sp + t;
    let mid: Vec3 | null = null;
    for (let k = 0; k < 8; k++) {
      // Byte 0 (modifiers) at the back of the train, so it reads left to right like the text.
      const u = head - (7 - k) * sp;
      if (u < 0 || u > 1) continue;
      const p = pointAt(r.pts, u);
      p[1] += 0.045;
      if (k === 4) mid = p;
      const key = k === 2;
      this.label(`hid${k}`, p, key ? "28" : "00", {
        kind: "mono",
        align: "center",
        dy: -17,
        color: key ? "#ffffff" : CSS.hardware,
        opacity: labels,
      });
      const col = key ? mixRgb(C.hardware, [1, 1, 1], 0.55) : C.hardware;
      this.bytes.box(p, [0.07, 0.07, 0.07], {
        edge: scaleRgb(col, 1.4),
        edgeIntensity: shown * (key ? 2 : 1.1),
        edgePx: 1,
        fill: scaleRgb(col, key ? 0.55 : 0.22),
        fillIntensity: shown,
      });
    }
    return mid;
  }

  /** Radio waves at the antenna: expanding (out) or contracting (in). */
  private waves(u: number, color: Rgb, inward: boolean): void {
    if (u <= 0 || u >= 1) return;
    const top: Vec3 = [ANTENNA[0], 0.62, ANTENNA[2]];
    for (let k = 0; k < 4; k++) {
      let v = u * 1.4 - k * 0.13;
      if (v <= 0 || v >= 1) continue;
      if (inward) v = 1 - v;
      const rad = 0.12 + v * 1.6;
      const fade = inward ? smooth(1 - v) * smooth(Math.min(1, v * 4)) : (1 - v) ** 1.5;
      this.lines.polyline(circle(top, rad, 48, [1, 0, 0], [0, 0, 1]), {
        color,
        width: 1.3,
        glow: 5,
        level: 1.8 * fade,
      });
      this.lines.polyline(circle([top[0], top[1] - 0.25 * v, top[2]], rad * 0.85, 48, [1, 0, 0], [0, 0, 1]), {
        color,
        width: 1.1,
        glow: 4,
        level: 0.8 * fade,
      });
    }
  }

  private antenna(a: number): void {
    const base: Vec3 = [ANTENNA[0], 0.0, ANTENNA[2]];
    const tip: Vec3 = [ANTENNA[0], 0.62, ANTENNA[2]];
    this.lines.segment(base, tip, { color: C.hardware, width: 1.4, glow: 4, level: 0.5 + 2 * a });
    this.points.point(tip, { color: C.hardware, px: 4, glow: 2, intensity: 0.6 + 2 * a });
  }

  // ---- chapters ---------------------------------------------------------------------------------

  private enter(b: number): void {
    const reveal = ramp(b, 1.55, 2.3);
    this.planeOp.k = reveal;
    this.planeOp.u = reveal;
    this.planeNames = ramp(b, 2.0, 2.4);
    this.standing();
    this.antenna(0);

    // b0: the switch. The key goes down, the contacts close, its row and column connect.
    this.press = ramp(b, -0.42, -0.1);
    this.matrixLit = ramp(b, -0.14, -0.06) * (1 - 0.65 * ramp(b, 0.5, 0.9));
    this.spark(win(b, -0.14, -0.1, -0.04, 0.25), seg(b, -0.12, 0.35));
    // The controller scans the matrix about once a millisecond (the chapter spans 6.2 ms), and
    // debounces: three quick blinks while the contact settles.
    const ms = ((b + 0.5) / 3) * 6.2;
    const col = Math.floor((ms % 1) * 15);
    const sx = KBD.x0 + (col + 0.5) * KEY_U;
    const scanOn = 1 - ramp(b, 1.5, 2.0);
    if (scanOn > 0.01) {
      this.lines.segment([sx, KBD.slab + 0.006, KBD.z0], [sx, KBD.slab + 0.006, KBD.z0 + KBD_D], {
        color: C.hardware,
        width: 1,
        glow: 3,
        level: 0.55 * scanOn,
      });
    }
    const deb = b > -0.1 && b < 0.42 ? 0.5 + 0.5 * Math.cos(seg(b, -0.1, 0.42) * Math.PI * 6) : 0;
    this.on("kbdctl", 0.2 + 0.8 * deb);
    this.name("kbdctl", win(b, -0.2, 0.05, 1.3, 1.7));
    this.label("enter", [ENTER.c[0] + ENTER.size[0] / 2, ENTER.c[1], ENTER.c[2]], "Enter", {
      kind: "name",
      align: "left",
      dx: 6,
      color: CSS.hardware,
      opacity: win(b, -0.6, -0.35, 0.45, 0.75),
    });
    this.label("matrix", [KBD.x0 + (ENTER.col + 0.5) * KEY_U, KBD.slab, KBD.z0 + KBD_D], "row + column connect", {
      align: "center",
      dy: 16,
      opacity: win(b, -0.08, 0.05, 0.5, 0.75),
      color: CSS.hardware,
    });
    this.label("debounce", [HW.kbdctl.x + 0.2, 0.08, HW.kbdctl.z], "scans ~1,000×/s · debounces", {
      kind: "note",
      align: "left",
      dy: -12,
      opacity: win(b, -0.05, 0.1, 0.45, 0.65),
    });

    // b1: USB. The host controller polls; the keyboard answers with its 8-byte report.
    const poll = seg(b, 0.42, 0.66);
    this.signal(R_USB_BACK, poll, { shown: win(b, 0.38, 0.42, 0.66, 0.72), base: 0, trail: 0.5 });
    this.label("poll", [-0.75, 0.06, 1.84], "poll", {
      kind: "mono",
      align: "right",
      opacity: win(b, 0.38, 0.45, 0.68, 0.78),
      color: CSS.hardware,
    });
    const rep = seg(b, 0.72, 1.3);
    this.signal(R.usb, rep, { shown: win(b, 0.6, 0.72, 1.6, 2.2), base: 0.25, trail: 0.6 });
    const o = win(b, 0.62, 0.76, 1.18, 1.28);
    const mid = this.hidReport(rep, win(b, 0.55, 0.7, 1.28, 1.34), o);
    if (mid) this.label("hid-n", mid, "8-byte HID report · Enter is 0x28", { align: "center", dy: 26, opacity: o });
    this.on("xhci", win(b, 0.38, 0.45, 0.6, 0.75) * 0.6 + win(b, 1.2, 1.32, 1.75, 2.1));
    this.name("xhci", win(b, 0.35, 0.6, 2.1, 2.4));

    // b2: the report goes into memory (DMA) and the controller interrupts the CPU. Pull back.
    const dma = seg(b, 1.38, 1.68);
    this.signal(R.dmaX, dma, { shown: win(b, 1.3, 1.38, 2.0, 2.4) });
    this.on("ram", win(b, 1.6, 1.7, 1.95, 2.3));
    this.name("ram", win(b, 1.45, 1.65, 2.1, 2.4));
    this.label("dma", [1.15, 0.05, 0.35], "DMA → memory", {
      kind: "mono",
      align: "right",
      dy: 0,
      opacity: win(b, 1.4, 1.55, 1.95, 2.2),
    });
    const irq = seg(b, 1.62, 1.92);
    this.signal(R.irqX, irq, { shown: win(b, 1.55, 1.62, 2.2, 2.5) });
    this.on("cpu", win(b, 1.88, 1.95, 2.3, 2.6));
    this.name("cpu", win(b, 1.7, 1.9, 2.15, 2.4));
    this.label("irq", [1.45, 0.05, 1.95], "interrupt", {
      kind: "mono",
      align: "center",
      dy: 14,
      opacity: win(b, 1.65, 1.8, 2.1, 2.3),
    });
  }

  private shell(b: number): void {
    this.press = 1;
    this.planeNames = 1 - ramp(b, -0.4, 0.1);
    // b0: interrupt handler → HID driver → KEY_ENTER. b1: compositor → terminal → "\r" → pty. b2: bash.
    const m = R.shell.marks;
    const t = hop(b, [
      [-0.42, 0],
      [0.0, m[1] as number],
      [0.42, m[1] as number],
      [0.82, m[3] as number],
      [1.0, m[4] as number],
      [1.32, m[6] as number],
      [1.6, m[7] as number],
      [2.0, 1],
    ]);
    this.signal(R.shell, t, { base: 0.1 + 0.1 * ramp(b, -0.4, 0) });
    this.on("cpu", 1 - ramp(b, -0.4, 0.0));
    this.on("input", win(b, -0.12, 0.0, 0.55, 0.85));
    this.name("input", win(b, -0.3, -0.05, 1.1, 1.4));
    this.label("key", [K.input.x + K.input.w / 2, Y.k + 0.07, K.input.z], "KEY_ENTER, value 1 · /dev/input/event3", {
      kind: "mono",
      align: "left",
      dx: 8,
      dy: -18,
      color: CSS.kernel,
      opacity: win(b, -0.05, 0.1, 0.65, 0.9),
    });
    const comp = win(b, 0.6, 0.78, 0.95, 1.3);
    const term = win(b, 0.85, 1.0, 1.25, 1.6);
    const pty = win(b, 1.2, 1.32, 1.6, 1.9);
    const bash = ramp(b, 1.85, 2.05);
    this.standing({ compositor: comp, terminal: term, bash });
    this.name("cell:compositor", ramp(b, 0.35, 0.65));
    this.name("cell:terminal", ramp(b, 0.7, 0.95));
    this.name("cell:bash", ramp(b, 1.3, 1.6));
    this.label("focus", cellCenter(U.compositor as CellSpot), "→ the focused window", {
      align: "left",
      dx: 30,
      dy: 14,
      opacity: win(b, 0.6, 0.75, 1.0, 1.25),
    });
    this.on("pty", pty);
    this.name("pty", ramp(b, 1.0, 1.3));
    this.label("cr", [-0.55, (Y.k + Y.u) / 2, 0.55], '"\\r" (0x0D)', {
      kind: "mono",
      align: "right",
      color: CSS.user,
      opacity: win(b, 1.0, 1.15, 1.6, 1.85),
    });
    const bc = cellCenter(U.bash as CellSpot);
    this.label("line", [bc[0], bc[1] + 0.6, bc[2]], "ping google.com", {
      kind: "mono",
      align: "center",
      dy: -24,
      color: CSS.prompt,
      opacity: ramp(b, 1.95, 2.15),
    });
  }

  private fork(b: number): void {
    this.press = 1 - ramp(b, 2.2, 2.5);
    const bashC = cellCenter(U.bash as CellSpot);
    // b0: bash parses the line and searches PATH.
    const parse = win(b, -0.45, -0.25, 0.4, 0.7);
    const waits = ramp(b, 1.9, 2.2);
    this.standing({ bash: Math.max(parse, win(b, 0.45, 0.55, 0.8, 1.1) * 0.7) * (1 - 0.6 * waits) }, 1);
    this.name("cell:bash", 1);
    // Two words; not one of bash's own commands; its cache misses, so it tries each $PATH directory.
    const lookup = [
      "ping │ google.com",
      "cache: no ping yet",
      "/usr/local/sbin/ping  ✗",
      "/usr/local/bin/ping   ✗",
      "/usr/sbin/ping        ✗",
      "/usr/bin/ping         ✓",
    ];
    const anchor: Vec3 = [bashC[0] + 0.62, bashC[1] + 0.25, bashC[2]];
    for (const [i, line] of lookup.entries()) {
      const hit = i === lookup.length - 1;
      this.label(`path${i}`, anchor, line, {
        kind: "mono",
        align: "left",
        dy: i * 17 - 44 + (i > 0 ? 8 : 0),
        color: i === 0 ? CSS.prompt : hit ? CSS.back : CSS.muted,
        opacity: ramp(b, -0.42 + i * 0.1, -0.34 + i * 0.1) * (1 - ramp(b, 0.42, 0.62)),
      });
    }

    // b1: clone(): into the kernel and back; the copy buds off and the neck snaps.
    const down = seg(b, 0.42, 0.66);
    const back = seg(b, 0.66, 0.84);
    this.signal(R.clone, down, { shown: win(b, 0.35, 0.42, 0.7, 0.8) });
    this.signal(R_CLONE_BACK, back, { shown: win(b, 0.62, 0.66, 0.84, 0.95), base: 0 });
    this.on("sched", win(b, 0.58, 0.66, 0.8, 1.0));
    this.name("sched", win(b, 0.45, 0.62, 0.95, 1.2));
    this.label("clone", [0.9, (Y.k + Y.u) / 2, 0.05], "clone()", {
      kind: "mono",
      align: "left",
      color: CSS.kernel,
      opacity: win(b, 0.38, 0.5, 0.85, 1.0),
    });
    const s = seg(b, 0.82, 1.4);
    this.bud(bashC, U.bash?.r ?? 0.5, s, U.child as CellSpot);

    // b2: execve(): the kernel throws the copy's memory away and maps ping's ELF.
    const ex = seg(b, 1.42, 1.62);
    const map = seg(b, 1.66, 1.86);
    this.signal(R.execve, ex, { shown: win(b, 1.36, 1.42, 1.66, 1.75) });
    this.signal(reverse(R.execve), map, { shown: win(b, 1.62, 1.66, 1.86, 1.95), base: 0, color: C.kernel });
    this.on("exec", win(b, 1.58, 1.64, 1.9, 2.2));
    this.name("exec", win(b, 1.45, 1.6, 2.15, 2.4));
    const childC = cellCenter(U.child as CellSpot);
    this.label("execve", [U.child?.x ?? 0, (Y.k + Y.u) / 2, U.child?.z ?? 0], 'execve("/usr/bin/ping")', {
      kind: "mono",
      align: "left",
      color: CSS.kernel,
      opacity: win(b, 1.35, 1.48, 1.75, 1.9),
    });
    const bands = seg(b, 1.62, 2.05);
    const child = this.cellList.find((c) => c.id === "child");
    if (child) {
      child.bands = bands;
      child.glow = Math.max(child.glow, win(b, 1.6, 1.75, 2.0, 2.4));
      child.name = b < 1.92 ? "bash (child)" : "ping";
    }
    this.name("cell:child", ramp(b, 1.0, 1.2) * (1 - win(b, 1.82, 1.9, 1.94, 2.02)));
    this.label("cow", childC, "copy-on-write", {
      align: "left",
      dx: 40,
      dy: 10,
      opacity: win(b, 1.05, 1.2, 1.5, 1.65),
    });
    const so = ramp(b, 2.0, 2.15);
    for (const [i, sgt] of SEGMENTS.entries()) {
      this.label(
        `seg${i}`,
        [childC[0] + (U.child?.r ?? 0.4) * 0.95, childC[1] + sgt.h * (U.child?.r ?? 0.4) * 0.9, childC[2]],
        sgt.name,
        {
          kind: "note",
          align: "left",
          dx: 8,
          color: CSS.user,
          opacity: so,
        },
      );
    }
    this.label("waits", bashC, "waits", { align: "center", dy: 44, opacity: waits * 0.9 });
  }

  /** bash's copy budding off toward `to`; s 0..1. */
  private bud(
    from: Vec3,
    fromR: number,
    s: number,
    to: CellSpot,
    opts: { seed?: number; color?: Rgb } = {},
  ): CellDraw | null {
    if (s <= 0) return null;
    const dest = cellCenter(to);
    const c = lerp3(from, dest, smooth(s));
    const cell: CellDraw = {
      id: "child",
      c,
      r: to.r,
      color: opts.color ?? C.user,
      glow: 0.4 * (1 - s),
      opacity: Math.min(1, s * 4) * this.planeOp.u,
      seed: opts.seed ?? 13,
      bands: 0,
    };
    this.cellList.push(cell);
    const d = Math.hypot(c[0] - from[0], c[1] - from[1], c[2] - from[2]);
    const snap = fromR + to.r + 0.35;
    const k = seg(d, fromR + to.r - 0.25, snap);
    if (d > fromR * 0.6) neck(this.lines, this.dust, from, fromR, c, to.r, this.eye, k, C.user, this.t);
    // The neck snaps: a flash where it parted.
    const fl = d >= snap ? 1 - seg(d, snap, snap + 0.3) : 0;
    if (fl > 0.01) {
      const ax = [(c[0] - from[0]) / d, (c[1] - from[1]) / d, (c[2] - from[2]) / d] as Vec3;
      const gap = (d - fromR - to.r) / 2;
      const at = add(from, [ax[0] * (fromR + gap), ax[1] * (fromR + gap), ax[2] * (fromR + gap)]);
      this.points.point(at, {
        color: scaleRgb(mixRgb(C.user, [1, 1, 1], 0.5), 2),
        px: 9,
        glow: 2.5,
        intensity: 1.6 * fl,
      });
    }
    return cell;
  }

  /** ping (or claude) where it lives, as a finished process. */
  private pingCell(glow = 0, opacity = 1, r?: number): CellDraw {
    const s = U.ping as CellSpot;
    const cell: CellDraw = {
      id: "child",
      c: cellCenter(s, r ?? s.r),
      r: r ?? s.r,
      color: C.user,
      glow,
      opacity: opacity * this.planeOp.u,
      seed: 13,
      bands: 1,
      name: "ping",
    };
    this.cellList.push(cell);
    return cell;
  }

  private packet(b: number, focus: string | null): void {
    this.vis = [1, 1, 0, 0];
    this.standing();
    // ping glides from where it was exec'd to its place above the socket (hidden by the crossfade).
    const glide = ramp(b, -0.5, -0.25);
    const ping = this.pingCell(win(b, -0.3, -0.15, 0.2, 0.45));
    ping.c = lerp3(cellCenter(U.child as CellSpot), ping.c, glide);
    this.name("cell:child", 1);

    // The card: built at ping (b0), dropped through the syscall gate, down the gates (b1, b2), out (b3).
    const q = 0.11;
    const zStops: [number, number][] = [
      [0.6, stageZ("socket")],
      [0.85, stageZ("icmp")],
      [1.05, stageZ("icmp")],
      [1.25, stageZ("ip")],
      [1.62, stageZ("ip")],
      [1.85, stageZ("neigh")],
      [2.32, stageZ("neigh")],
      [2.52, stageZ("qdisc")],
      [2.66, stageZ("qdisc")],
      [2.86, stageZ("driver")],
    ];
    const z = hop(b, zStops);
    const topHigh = Y.u + 1.7;
    const topK = Y.k + 0.9;
    const drop = smooth(seg(b, 0.25, 0.6));
    const sink = smooth(seg(b, 2.92, 3.12));
    const top = topHigh + (topK - topHigh) * drop + (0.42 - topK) * sink;
    const scale = 1 - 0.55 * sink;
    const pitch = q * scale;
    const card: CardState = {
      frame: REQUEST,
      origin: [STACK_X - 8 * pitch, top, z],
      pitch,
      data: seg(b, -0.42, -0.12),
      icmp: seg(b, -0.14, 0.14),
      ip: seg(b, 1.25, 1.58),
      link: seg(b, 1.98, 2.3),
      from: { icmp: [6 * pitch, PING[1] - top, PING[2] - z], ip: [-1.0, 0.7, 0], link: [-1.0, 0.7, 0] },
      tint: null,
      focus,
      flash: { "icmp.id": win(b, 0.82, 0.9, 1.0, 1.12), "icmp.csum": win(b, 0.86, 0.94, 1.02, 1.14) },
      opacity: 1 - ramp(b, 3.12, 3.3),
    };
    this.card = card;

    // The syscall gate in user space, and the stages lighting as the card passes.
    const gateFlash = win(b, 0.32, 0.4, 0.5, 0.62);
    this.slot([STACK_X, Y.u, stageZ("socket")], C.user, 0.35 + 2.5 * gateFlash);
    this.label("sendto", [STACK_X - 1.05, Y.u, stageZ("socket")], "sendto()", {
      kind: "mono",
      align: "right",
      color: CSS.user,
      opacity: win(b, 0.15, 0.3, 0.65, 0.85),
    });
    const at = (a0: number, a1: number): number => win(b, a0, a0 + 0.08, a1, a1 + 0.2);
    this.on("stage:socket", at(0.5, 0.7));
    this.on("stage:icmp", at(0.78, 1.1));
    this.on("stage:ip", at(1.18, 1.65));
    this.on("stage:neigh", at(1.8, 2.35));
    this.on("stage:qdisc", at(2.45, 2.7));
    this.on("stage:driver", at(2.8, 3.05));
    for (const s of STAGES) this.name(`stage:${s.id}`, ramp(b, 0.2, 0.5));
    this.name("route", this.narrow ? 0 : ramp(b, 1.0, 1.3));
    this.name("neigh", this.narrow ? 0 : ramp(b, 1.6, 1.9));
    this.cardNote("icmph", card, 0, "8-byte ICMP header", {
      kind: "note",
      color: CSS.icmp,
      opacity: win(b, -0.1, 0.05, 0.3, 0.45),
    });
    this.cardNote("data", card, 1, "56 bytes of data", {
      kind: "note",
      color: CSS.payload,
      opacity: win(b, -0.35, -0.2, 0.3, 0.45),
    });
    this.cardNote("idcsum", card, 0, "identifier 23582 · checksum", {
      color: CSS.icmp,
      opacity: win(b, 0.82, 0.92, 1.1, 1.25),
    });
    // b1: the routing table: not local, so via the default gateway.
    const lr = seg(b, 1.3, 1.44);
    const lb = seg(b, 1.44, 1.58);
    this.signal(R.lookupRoute, lr, { shown: win(b, 1.25, 1.3, 1.6, 1.8), base: 0.15, color: C.kernel });
    this.signal(reverse(R.lookupRoute), lb, { shown: win(b, 1.4, 1.44, 1.58, 1.7), base: 0, color: C.kernel });
    this.on("route", win(b, 1.38, 1.44, 1.6, 1.8));
    const gw = win(b, 1.35, 1.45, 1.8, 2.0);
    if (this.narrow) this.cardNote("gw", card, 1, "→ default via 192.168.1.1", { color: CSS.kernel, opacity: gw });
    else {
      this.label("gw", [K.route.x, Y.k + 0.12, K.route.z], "default via 192.168.1.1", {
        kind: "mono",
        align: "center",
        dy: -14,
        color: CSS.kernel,
        opacity: gw,
      });
    }
    this.cardNote("iph", card, 0, "IPv4: TTL 64, protocol 1", {
      color: CSS.ip,
      opacity: win(b, 1.4, 1.55, 1.8, 1.95),
    });
    // b2: the neighbour table already knows the router's MAC; the Ethernet header goes on.
    const nr = seg(b, 1.88, 2.0);
    const nb = seg(b, 2.0, 2.12);
    this.signal(R.lookupNeigh, nr, { shown: win(b, 1.84, 1.88, 2.12, 2.3), base: 0.15, color: C.kernel });
    this.signal(reverse(R.lookupNeigh), nb, { shown: win(b, 1.96, 2.0, 2.12, 2.2), base: 0, color: C.kernel });
    this.on("neigh", win(b, 1.94, 2.0, 2.15, 2.35));
    const mac = win(b, 1.92, 2.02, 2.4, 2.6);
    if (this.narrow)
      this.cardNote("mac", card, 1, "192.168.1.1 → 00:00:5e:00:53:01", { color: CSS.kernel, opacity: mac });
    else {
      this.label("mac", [K.neigh.x, Y.k + 0.12, K.neigh.z], "192.168.1.1 → 00:00:5e:00:53:01", {
        kind: "mono",
        align: "center",
        dy: 16,
        color: CSS.kernel,
        opacity: mac,
      });
    }
    this.cardNote("98", card, 0, "+ Ethernet: 98 bytes", {
      color: CSS.link,
      opacity: win(b, 2.2, 2.32, 2.62, 2.8),
    });
    // b3: queueing discipline, Wi-Fi driver, DMA into the NIC's ring buffer, out of the antenna.
    const nicLit = win(b, 3.0, 3.1, 3.3, 3.45);
    this.on("nic", nicLit);
    this.name("nic", ramp(b, 2.8, 3.0));
    const dropTrace = seg(b, 2.9, 3.12);
    if (dropTrace > 0) {
      this.lines.segment([STACK_X, Y.k, stageZ("driver")], [STACK_X, Y.hw + 0.12, stageZ("driver")], {
        color: C.kernel,
        colors: [C.kernel, C.hardware],
        width: 1.4,
        glow: 5,
        level: 0.25 * win(b, 2.85, 2.95, 3.3, 3.45),
        pulse: dropTrace < 1 ? { at: dropTrace, trail: 0.5, intensity: 5, flare: 2 } : undefined,
      });
    }
    this.label("dma", [HW.nic.x, 0.12, HW.nic.z], "the card copies it out (DMA)", {
      kind: "mono",
      align: "left",
      dx: 52,
      dy: -10,
      opacity: win(b, 2.98, 3.08, 3.3, 3.45),
    });
    const out = seg(b, 3.1, 3.22);
    this.signal(R.antennaOut, out, { shown: win(b, 3.05, 3.1, 3.3, 3.45), color: C.hardware });
    this.antenna(win(b, 3.15, 3.2, 3.35, 3.5));
    this.waves(seg(b, 3.18, 3.5), C.out, false);
    this.focusLabel(card, focus);
  }

  /** A horizontal slot in a plane the card drops through (the syscall gate). */
  private slot(p: Vec3, color: Rgb, level: number): void {
    const w = 1.95;
    const d = 0.2;
    const y = p[1] + 0.006;
    const pts = filleted(
      [
        [p[0] - w / 2, y, p[2] - d / 2],
        [p[0] + w / 2, y, p[2] - d / 2],
        [p[0] + w / 2, y, p[2] + d / 2],
        [p[0] - w / 2, y, p[2] + d / 2],
        [p[0] - w / 2, y, p[2] - d / 2],
        [p[0] + w / 2, y, p[2] - d / 2],
      ],
      0.06,
      4,
    ).slice(0, -4);
    this.lines.polyline(pts, { color, width: 1.3, glow: 5, level });
  }

  /** A note beside the card's top-right corner, one line per `line`. */
  private cardNote(id: string, card: CardState, line: number, text: string, opts: Partial<Label>): void {
    if (this.narrow) {
      // Below the card: there's no room beside it on a phone.
      const at: Vec3 = [card.origin[0], card.origin[1] - 7 * card.pitch, card.origin[2]];
      this.label(id, at, text, { kind: "mono", align: "left", dy: 12 + line * 15, ...opts });
      return;
    }
    const at: Vec3 = [card.origin[0] + 16 * card.pitch, card.origin[1], card.origin[2]];
    this.label(id, at, text, { kind: "mono", align: "left", dx: 12, dy: 8 + line * 17, ...opts });
  }

  private focusLabel(card: CardState, focus: string | null): void {
    if (!focus) return;
    const f = card.frame.fields.find((x) => x.id === focus);
    const p = f ? fieldPos(card, focus) : null;
    if (!f || !p) return;
    this.label("focus", p, `${f.name}: ${f.value}`, { kind: "mono", align: "center", dy: -26, color: "#ffffff" });
  }

  private arrive(b: number, focus: string | null): void {
    this.vis = [1, 1, 0, 0];
    this.standing();
    const asleep = win(b, 1.4, 1.6, 1.9, 2.05);
    const wake = win(b, 1.98, 2.08, 2.3, 2.5);
    this.pingCell(wake + 0.15 * asleep);
    this.name("cell:child", 1);
    // b0: the reply comes in on the air; the NIC takes it, DMAs it into memory, raises an interrupt.
    this.waves(seg(b, -0.5, -0.1), C.back, true);
    this.antenna(win(b, -0.3, -0.15, -0.05, 0.1));
    this.on("nic", win(b, -0.15, -0.05, 0.4, 0.6));
    this.name("nic", win(b, -0.5, -0.3, 0.6, 0.85));
    const dma = seg(b, 0.0, 0.28);
    this.signal(R.nicDma, dma, { shown: win(b, -0.05, 0.0, 0.5, 0.75), color: C.back });
    this.on("ram", win(b, 0.22, 0.28, 0.45, 0.7));
    this.name("ram", win(b, 0.1, 0.25, 0.55, 0.8));
    this.label("dma", [3.3, 0.05, 0.4], "DMA → memory", {
      kind: "mono",
      align: "left",
      opacity: win(b, 0.05, 0.15, 0.45, 0.65),
    });
    const irq = seg(b, 0.2, 0.42);
    this.signal(R.nicIrq, irq, { shown: win(b, 0.15, 0.2, 0.6, 0.8), color: C.back });
    this.on("cpu", win(b, 0.38, 0.44, 0.6, 0.85));
    this.name("cpu", win(b, 0.25, 0.4, 0.65, 0.85));
    this.label("irq", [3.0, 0.05, 2.0], "interrupt", {
      kind: "mono",
      align: "left",
      opacity: win(b, 0.22, 0.32, 0.55, 0.7),
    });
    this.label("napi", [STACK_X + ARCH.w / 2, Y.k + ARCH.h, stageZ("driver")], "NAPI polls", {
      kind: "mono",
      align: "left",
      dx: 6,
      color: CSS.kernel,
      opacity: win(b, 0.4, 0.5, 0.8, 0.95),
    });

    // b1: up the stack: Ethernet off, IP (for me? checksum fine), ICMP echo reply id 23582 → the socket.
    const q = 0.11;
    const rise = smooth(seg(b, 0.42, 0.62));
    const toPing = smooth(seg(b, 2.0, 2.25));
    const z = hop(b, [
      [0.62, stageZ("driver")],
      [1.0, stageZ("ip")],
      [1.18, stageZ("ip")],
      [1.38, stageZ("icmp")],
      [1.48, stageZ("icmp")],
      [1.68, stageZ("socket")],
    ]);
    const top0 = 0.82;
    const topK = Y.k + 0.9;
    const top = top0 + (topK - top0) * rise + (Y.u + 0.95 - topK) * toPing;
    const zz = z + (cellCenter(U.ping as CellSpot)[2] - z) * toPing * 0.6;
    const pitch = q * (0.45 + 0.55 * rise) * (1 - 0.5 * toPing);
    const card: CardState = {
      frame: REPLY,
      origin: [STACK_X - 8 * pitch, top, zz],
      pitch,
      data: seg(b, -0.2, 0.05),
      icmp: 1,
      ip: 1 - seg(b, 1.08, 1.3),
      link: 1 - seg(b, 0.62, 0.85),
      from: { link: [-1.4, 0.7, 0.4], ip: [-1.4, 0.7, 0.4], icmp: [-1.2, 0.5, 0] },
      tint: C.back,
      focus,
      flash: {},
      opacity: smooth(seg(b, -0.22, -0.05)) * (1 - ramp(b, 2.12, 2.28)),
    };
    this.card = card;
    const at = (a0: number, a1: number): number => win(b, a0, a0 + 0.08, a1, a1 + 0.2);
    this.on("stage:driver", at(0.5, 0.75));
    this.on("stage:ip", at(0.95, 1.3));
    this.on("stage:icmp", at(1.32, 1.52));
    this.on("stage:socket", at(1.62, 1.95));
    for (const s of STAGES) this.name(`stage:${s.id}`, win(b, 0.4, 0.6, 2.0, 2.3));
    this.cardNote("eth", card, 0, "Ethernet: IPv4 inside", {
      color: CSS.link,
      opacity: win(b, 0.6, 0.7, 0.88, 1.0),
    });
    this.cardNote("forme", card, 0, "IP: for this machine,", { color: CSS.ip, opacity: win(b, 1.0, 1.08, 1.3, 1.42) });
    this.cardNote("forme2", card, 1, "checksum fine", { color: CSS.ip, opacity: win(b, 1.0, 1.08, 1.3, 1.42) });
    this.cardNote("reply", card, 0, "ICMP: echo reply,", { color: CSS.icmp, opacity: win(b, 1.36, 1.44, 1.75, 1.9) });
    this.cardNote("reply2", card, 1, "id 23582 → ping's socket", {
      color: CSS.icmp,
      opacity: win(b, 1.36, 1.44, 1.75, 1.9),
    });

    // b2: ping was asleep in poll(); the scheduler wakes it; RTT 11.8 ms.
    const wk = seg(b, 1.72, 2.02);
    this.signal(R.wake, wk, { shown: win(b, 1.66, 1.72, 2.2, 2.45), color: C.back });
    this.on("sched", win(b, 1.8, 1.86, 2.0, 2.25));
    this.name("sched", win(b, 1.7, 1.85, 2.2, 2.45));
    const pc = cellCenter(U.ping as CellSpot);
    this.label("poll", pc, "asleep in recvmsg()", {
      align: "left",
      dx: 34,
      dy: 4,
      opacity: win(b, 1.35, 1.5, 1.85, 2.0),
    });
    this.label("rtt", pc, "received − sent: 11.8 ms", {
      kind: "mono",
      align: "left",
      dx: 34,
      dy: 4,
      color: CSS.back,
      opacity: ramp(b, 2.15, 2.3),
    });
    this.focusLabel(card, focus);
  }

  private print(b: number): void {
    this.vis = [1, 1, 0, 0];
    // The screen: hidden line 2 until the scanline reveals it.
    if (b > 2.05) {
      this.vis[2] = 1;
      this.reveal = b < 2.72;
      this.scan = b < 2.72 ? seg(b, 2.08, 2.68) : -1;
    }
    this.grid = win(b, 1.8, 1.98, 2.8, 3.1);
    // Dive through the layers onto the screen, and back out.
    const dive = win(b, 1.8, 2.0, 2.75, 3.2);
    this.planeOp.k = 1 - dive;
    this.planeOp.u = 1 - dive;
    const ping = this.pingCell(win(b, -0.4, -0.25, 0.1, 0.3) * 0.8 + win(b, 3.0, 3.15, 3.4, 3.5) * 0.5);
    void ping;
    this.name("cell:child", 1 - dive);
    const pc = cellCenter(U.ping as CellSpot);
    this.label("rdns", [pc[0], pc[1] + (U.ping?.r ?? 0.44), pc[2]], "172.253.124.113 → ys-in-f113.1e100.net", {
      kind: "mono",
      align: "center",
      dy: -34,
      color: CSS.dns,
      opacity: win(b, -0.45, -0.3, 0.0, 0.15),
    });
    // b0: printf → write() → the pty → the terminal emulator.
    const m = R.write.marks;
    const t = hop(b, [
      [0.02, 0],
      [0.22, m[0] as number],
      [0.4, m[2] as number],
      [0.6, 1],
    ]);
    this.signal(R.write, t, { shown: win(b, -0.05, 0.02, 0.9, 1.2) });
    this.label("write", [4.6, (Y.k + Y.u) / 2, -2.4], "write()", {
      kind: "mono",
      align: "left",
      color: CSS.user,
      opacity: win(b, 0.0, 0.1, 0.4, 0.6),
    });
    this.on("pty", win(b, 0.3, 0.36, 0.5, 0.7));
    this.name("pty", win(b, 0.2, 0.35, 0.7, 0.9));
    // b1: the terminal lays out glyphs, renders on the GPU, hands the frame to the compositor.
    const term = win(b, 0.55, 0.65, 1.15, 1.35);
    const comp = win(b, 1.3, 1.4, 1.6, 1.8);
    this.standing({ terminal: term, compositor: comp });
    this.name("cell:terminal", win(b, 0.4, 0.6, 1.5, 1.75) * (1 - dive));
    this.name("cell:compositor", win(b, 1.1, 1.3, 1.65, 1.85) * (1 - dive));
    const tc = cellCenter(U.terminal as CellSpot);
    this.label("glyphs", tc, "glyphs from a font atlas", {
      align: "left",
      dx: 34,
      dy: -10,
      opacity: win(b, 0.6, 0.75, 1.05, 1.25),
    });
    const r1 = seg(b, 0.72, 0.98);
    this.signal(R.render, r1, { shown: win(b, 0.66, 0.72, 1.2, 1.4) });
    this.on("gpu", win(b, 0.92, 1.0, 1.15, 1.35));
    this.name("gpu", win(b, 0.8, 0.95, 1.3, 1.5));
    const r2 = seg(b, 1.12, 1.38);
    this.signal(R.handoff, r2, { shown: win(b, 1.06, 1.12, 1.6, 1.75) });
    this.label("frame", [-2.6, Y.u, 0.8], "the window → compositor", {
      align: "center",
      dy: 16,
      opacity: win(b, 1.12, 1.25, 1.5, 1.65),
    });
    // b2: compositor → DRM/KMS → the display controller → the panel, on the next refresh.
    const sm = R.scanout.marks;
    const so = hop(b, [
      [1.4, 0],
      [1.52, sm[0] as number],
      [1.58, sm[0] as number],
      [1.72, sm[2] as number],
      [1.78, sm[2] as number],
      [1.9, 1],
    ]);
    this.signal(R.scanout, so, { shown: win(b, 1.36, 1.42, 2.0, 2.2) });
    this.on("drm", win(b, 1.5, 1.56, 1.66, 1.85));
    this.name("drm", win(b, 1.45, 1.55, 1.75, 1.9));
    this.on("gpu", win(b, 1.68, 1.74, 1.85, 2.0));
    this.label("dc", [HW.gpu.x, 0.16, HW.gpu.z + HW.gpu.d / 2], "display controller", {
      align: "center",
      dy: 14,
      color: CSS.hardware,
      opacity: win(b, 1.66, 1.74, 1.9, 2.0),
    });
    this.on("display", win(b, 1.85, 1.95, 2.5, 2.8));
    this.name("display", win(b, 1.6, 1.75, 1.88, 1.98) + win(b, 3.0, 3.2, 3.5, 3.6));
    const blk = this.screen.block(this.narrow);
    this.label("refresh", [blk.origin[0], PANEL.y, blk.origin[2] + blk.d], "next refresh: up to 16.7 ms at 60 Hz", {
      kind: "note",
      align: "left",
      dy: 22,
      opacity: win(b, 1.9, 2.0, 2.45, 2.6),
    });
    this.label("scan", [blk.origin[0] + blk.w, PANEL.y, blk.origin[2] - 0.08], "scanout, top to bottom", {
      kind: "note",
      align: "right",
      dy: -14,
      opacity: win(b, 1.95, 2.05, 2.45, 2.6),
    });
    // b3: back out, toward you. ping sleeps a second, then sends icmp_seq=2.
    this.label("seq2", pc, "sleep 1 s → icmp_seq=2", {
      kind: "mono",
      align: "left",
      dx: 34,
      dy: 4,
      color: CSS.out,
      opacity: ramp(b, 3.1, 3.3),
    });
  }

  private interlude(b: number): void {
    this.vis = [1, 1, 1, 0];
    this.planeNames = win(b, -0.4, -0.1, 0.3, 0.5);
    this.standing({}, 1);
    // ping has exited: its cell dissolves.
    const gone = ramp(b, -0.45, -0.05);
    if (gone < 1) {
      const c = this.pingCell(0, 1 - gone);
      c.r = (U.ping?.r ?? 0.44) * (1 - 0.5 * gone);
      c.fill = 1 - gone;
    }
    this.name("cell:bash", 1);
    this.label("idle", cellCenter(U.bash as CellSpot), "after Ctrl-C: waiting for the next line", {
      align: "left",
      dx: 26,
      dy: -4,
      opacity: win(b, -0.2, 0.0, 0.35, 0.5),
    });
  }

  draw(pass: GPURenderPassEncoder): void {
    this.boxes.draw(pass);
    for (const id of PLANES) if (this.planeOp[id] > 0.01) this.planeLines[id].draw(pass);
    this.buses.draw(pass);
    this.matrix.draw(pass);
    this.screen.draw(pass);
    this.lines.draw(pass);
    this.glass.draw(pass, "glass");
    this.glass.draw(pass, "halo");
    this.dust.draw(pass);
    this.bytes.draw(pass);
    this.points.draw(pass);
    this.xray.draw(pass);
    this.xrayPts.draw(pass);
  }

  anchor(name: string): CameraPose | null {
    // Close-up for fly-throughs (story/flights.ts): ping's process, wherever it's drawn this frame (it
    // moves from where it was exec'd to its place above the socket).
    if (name === "ping") {
      const c = this.cellList.find((cell) => cell.id === "child")?.c ?? PING;
      return P(c[0], c[1], c[2], 1.5, -12, 14, 36);
    }
    return null;
  }

  labels(out: Label[]): void {
    out.push(...this.out);
  }

  private launch(b: number): void {
    this.vis = [0, 0, 0, 1];
    const bashC = cellCenter(U.bash as CellSpot);
    // b0: the key matrix, USB, the interrupt, the pty, bash: all as before (a quick replay), then
    // fork and exec again. The child becomes claude: one ~290 MB executable.
    const replay = seg(b, -0.5, -0.3);
    this.signal(R.shell, replay, { shown: win(b, -0.52, -0.5, -0.3, -0.22), base: 0.05 });
    this.standing({ bash: win(b, -0.34, -0.3, -0.2, 0.0) * 0.8 });
    this.name("cell:bash", 1 - ramp(b, 1.5, 1.8));
    const down = seg(b, -0.3, -0.16);
    this.signal(R.clone, down, { shown: win(b, -0.32, -0.3, -0.14, -0.06) });
    this.on("sched", win(b, -0.2, -0.15, -0.05, 0.1));
    const s = seg(b, -0.16, 0.14);
    const spot: CellSpot = { x: U.claude?.x ?? 0, z: U.claude?.z ?? 0, r: U.child?.r ?? 0.44 };
    const child = this.bud(bashC, U.bash?.r ?? 0.5, s, spot);
    const ex = seg(b, 0.1, 0.24);
    this.signal(R.execve2, ex, { shown: win(b, 0.06, 0.1, 0.26, 0.35) });
    this.on("exec", win(b, 0.2, 0.26, 0.4, 0.6));
    const grow = smooth(seg(b, 0.22, 0.6));
    const big = U.claude as CellSpot;
    if (child) {
      child.id = "claude";
      child.bands = seg(b, 0.22, 0.55);
      child.r = spot.r + (big.r - spot.r) * grow;
      child.c = cellCenter(big, child.r);
      child.color = mixRgb(C.user, CLAUDE_RGB, grow);
      child.glow = Math.max(child.glow, win(b, 0.2, 0.35, 0.7, 1.0) * 0.8 + win(b, 1.6, 1.8, 2.3, 2.5) * 0.5);
      child.name = b < 0.3 ? "bash (child)" : "claude";
    }
    this.name("cell:claude", ramp(b, -0.05, 0.1));
    const cc = cellCenter(big);
    const under: Vec3 = [cc[0], Y.u, cc[2] + big.r];
    this.label("exe", under, "one executable, ~290 MB", {
      align: "center",
      dy: 14,
      opacity: win(b, 0.35, 0.5, 0.85, 1.0),
    });
    this.label("bun", under, "TypeScript + the Bun runtime, compiled in", {
      align: "center",
      dy: 30,
      opacity: win(b, 0.42, 0.56, 0.85, 1.0),
    });

    // b1: your setup is read; MCP servers start as child processes, connected by pipes.
    this.label("setup", [cc[0], cc[1] + big.r, cc[2]], "settings · CLAUDE.md · memory · skills", {
      align: "center",
      dy: -32,
      color: CSS.user,
      opacity: win(b, 0.62, 0.78, 1.4, 1.6),
    });
    for (const [i, m] of MCP.entries()) {
      const u = seg(b, 0.66 + i * 0.1, 1.06 + i * 0.1);
      if (u <= 0) continue;
      const dest = cellCenter(m);
      const c = lerp3(cc, dest, smooth(u));
      this.cellList.push({
        id: `mcp${i}`,
        c,
        r: m.r,
        color: C.user,
        glow: 0.3 * (1 - u) + win(b, 1.55, 1.7, 2.3, 2.5) * 0.2,
        opacity: Math.min(1, u * 3) * this.planeOp.u,
        seed: 21 + i,
        bands: 0,
      });
      const pipe = ramp(u, 0.6, 1.0);
      if (pipe > 0.01) {
        this.lines.segment(cc, c, {
          color: C.user,
          width: 0.9,
          glow: 3,
          level: 0.18 * pipe,
          flow: { period: 0.18, speed: 0.25, duty: 0.25, intensity: 1.4 * pipe },
        });
      }
      this.name(`cell:mcp${i}`, ramp(b, 1.0 + i * 0.08, 1.15 + i * 0.08) * (1 - ramp(b, 1.6, 1.8)));
    }
    this.label("pipes", lerp3(cc, cellCenter(MCP[1] as CellSpot), 0.55), "pipes", {
      align: "center",
      dy: 14,
      opacity: win(b, 1.1, 1.25, 1.5, 1.65),
    });

    // b2: raw mode: every key comes straight through; the UI is React rendered to text (Ink).
    const n = 9;
    const r = rng(9);
    for (let k = 0; k < n; k++) {
      const t0 = 1.55 + k * 0.1;
      const key = Math.floor(r() * KEYS.length);
      const kd = win(b, t0 - 0.02, t0, t0 + 0.04, t0 + 0.1);
      if (kd > 0) this.keyLit.set(key, Math.max(this.keyLit.get(key) ?? 0, kd));
      const u = seg(b, t0, t0 + 0.55);
      if (u <= 0 || u >= 1) continue;
      this.signal(R.typing, u, { shown: 1, base: k === 0 ? 0.08 : 0, trail: 0.6, head: 0.8 });
    }
    this.on("cpu", win(b, 1.6, 1.7, 2.2, 2.4) * 0.5);
    this.on("input", win(b, 1.65, 1.75, 2.25, 2.4) * 0.5);
    this.on("pty", win(b, 1.75, 1.85, 2.35, 2.5) * 0.7);
    this.name("pty", win(b, 1.7, 1.85, 2.35, 2.5));
    this.label("raw", [K.pty.x, Y.k, K.pty.z + K.pty.d / 2], "raw mode: each key, as typed", {
      align: "center",
      dy: 30,
      color: CSS.kernel,
      opacity: win(b, 1.65, 1.8, 2.35, 2.5),
    });
    this.label("ink", under, "Ink: React, rendered to rows of text", {
      align: "center",
      dy: 14,
      opacity: win(b, 1.8, 1.95, 2.35, 2.5),
    });
  }
}

const CELL_NAMES: Record<string, string> = {
  compositor: "compositor",
  terminal: "terminal emulator",
  bash: "bash",
  claude: "claude",
  mcp0: "MCP server",
  mcp1: "MCP server",
  mcp2: "MCP server",
};

const factory: SceneFactory = (gfx) => new MachineScene(gfx);
export default factory;
