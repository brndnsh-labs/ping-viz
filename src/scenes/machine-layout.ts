// Where everything sits in the exploded laptop. Three horizontal planes stacked in y (hardware at the
// bottom, kernel, user space on top); x runs left to right, +z is the front. The key event spirals up
// through them: along the hardware plane left to right, back along the kernel plane, then right along
// user space. The network stack is a row of gates in the kernel plane running from the back (socket)
// to the front (Wi-Fi driver), so a packet heading out moves down the screen.
import type { Vec3 } from "../util/math";

export type PlaneId = "hw" | "k" | "u";

export const Y: Record<PlaneId, number> = { hw: 0, k: 2.55, u: 5.1 };
export const PLANES: PlaneId[] = ["hw", "k", "u"];
export const BOUNDS = { x0: -6.6, x1: 6.9, z0: -3.3, z1: 3.4 };

/** A box-shaped component sitting on a plane. */
export interface Part {
  id: string;
  plane: PlaneId;
  x: number;
  z: number;
  /** Full size along x, y, z. */
  w: number;
  h: number;
  d: number;
  name: string;
  /** Where the name goes: under the front edge (default) or beside the right end. */
  label?: "front" | "right";
}

const part = (
  id: string,
  plane: PlaneId,
  x: number,
  z: number,
  w: number,
  h: number,
  d: number,
  name: string,
  label?: "front" | "right",
): Part => ({ id, plane, x, z, w, h, d, name, label });

// ---- hardware ------------------------------------------------------------------------------------

/** Keyboard: 15 units wide, 5 rows (an ANSI-ish layout), back row first. */
export const KEY_U = 0.25;
export const KBD = { x0: -5.75, z0: 1.15, slab: 0.06 };
export const KEY_ROWS: number[][] = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2],
  [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5],
  [1.75, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.25],
  [2.25, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.75],
  [1.25, 1.25, 1.25, 6.25, 1.25, 1.25, 1.25, 1.25],
];
/** Row and index of the Enter key in KEY_ROWS. */
export const ENTER_KEY = { row: 2, index: 12 };

export interface Key {
  row: number;
  index: number;
  /** Matrix column (unit column under the key's centre). */
  col: number;
  c: Vec3;
  size: Vec3;
}

export const KEYS: Key[] = (() => {
  const out: Key[] = [];
  for (const [row, widths] of KEY_ROWS.entries()) {
    let cum = 0;
    for (const [index, w] of widths.entries()) {
      const cx = KBD.x0 + (cum + w / 2) * KEY_U;
      const cz = KBD.z0 + (row + 0.5) * KEY_U;
      out.push({
        row,
        index,
        col: Math.min(14, Math.floor(cum + w / 2)),
        c: [cx, KBD.slab + 0.075, cz],
        size: [w * KEY_U - 0.045, 0.075, KEY_U - 0.045],
      });
      cum += w;
    }
  }
  return out;
})();
export const ENTER = KEYS.find((k) => k.row === ENTER_KEY.row && k.index === ENTER_KEY.index) as Key;
export const KBD_W = 15 * KEY_U;
export const KBD_D = 5 * KEY_U;

export const HW = {
  kbdctl: part("kbdctl", "hw", -1.62, 1.78, 0.34, 0.07, 0.26, "microcontroller"),
  xhci: part("xhci", "hw", 0.45, 1.78, 0.9, 0.14, 0.62, "USB host controller (xHCI)"),
  cpu: part("cpu", "hw", 1.95, 0.85, 1.25, 0.2, 1.25, "CPU"),
  ram: part("ram", "hw", 1.95, -1.3, 1.7, 0.12, 0.72, "RAM"),
  gpu: part("gpu", "hw", -1.25, -1.45, 1.2, 0.16, 0.9, "GPU"),
  nic: part("nic", "hw", 4.6, 2.75, 1.05, 0.12, 0.62, "Wi-Fi card (NIC)"),
};

/** The display panel lies flat; "up" on the screen is -z. */
export const DISPLAY = { x: -4.3, z: -1.6, w: 3.2, d: 2.0 };
export const ANTENNA: Vec3 = [5.85, 0, 2.75];

// ---- kernel --------------------------------------------------------------------------------------

export const K = {
  input: part("input", "k", -3.75, 2.25, 1.6, 0.14, 0.6, "input: HID driver, evdev", "right"),
  pty: part("pty", "k", -0.2, 0.55, 0.95, 0.14, 0.5, "pty"),
  sched: part("sched", "k", 2.85, -2.6, 1.1, 0.14, 0.48, "scheduler"),
  exec: part("exec", "k", 2.35, -0.95, 1.15, 0.14, 0.5, "exec: ELF loader"),
  drm: part("drm", "k", -3.75, 1.05, 1.2, 0.14, 0.5, "DRM/KMS"),
  route: part("route", "k", 6.2, 0.05, 0.85, 0.12, 0.5, "routing table"),
  neigh: part("neigh", "k", 6.2, 0.95, 0.85, 0.12, 0.5, "neighbour table"),
};

/** The network stack: gates the packet passes through, back (socket) to front (Wi-Fi driver). */
export const STACK_X = 4.6;
export const ARCH = { w: 1.95, h: 1.02 };
export const STAGES = [
  { id: "socket", name: "socket", z: -1.75 },
  { id: "icmp", name: "ICMP", z: -0.85 },
  { id: "ip", name: "IP", z: 0.05 },
  { id: "neigh", name: "neighbour (ARP)", z: 0.95 },
  { id: "qdisc", name: "qdisc", z: 1.85 },
  { id: "driver", name: "Wi-Fi driver", z: 2.75 },
] as const;
export type StageId = (typeof STAGES)[number]["id"];
export const stageZ = (id: StageId): number => (STAGES.find((s) => s.id === id) as (typeof STAGES)[number]).z;

// ---- user space ----------------------------------------------------------------------------------

export interface CellSpot {
  x: number;
  z: number;
  r: number;
}

export const U: Record<string, CellSpot> = {
  compositor: { x: -3.75, z: 1.05, r: 0.5 },
  terminal: { x: -1.45, z: 0.55, r: 0.5 },
  bash: { x: 0.9, z: 0.05, r: 0.52 },
  /** Where the child execs (above the ELF loader), then where ping lives (above the socket). */
  child: { x: 2.35, z: -0.95, r: 0.44 },
  ping: { x: STACK_X, z: -2.4, r: 0.44 },
  claude: { x: 2.55, z: -1.15, r: 0.72 },
};

export const MCP: CellSpot[] = [
  { x: 4.65, z: -2.55, r: 0.27 },
  { x: 5.15, z: -1.05, r: 0.27 },
  { x: 4.6, z: 0.35, r: 0.27 },
];

export const cellCenter = (s: CellSpot, r = s.r): Vec3 => [s.x, Y.u + r, s.z];

// ---- helpers -------------------------------------------------------------------------------------

/** Top centre of a part. */
export const top = (p: Part): Vec3 => [p.x, Y[p.plane] + p.h, p.z];
export const center = (p: Part): Vec3 => [p.x, Y[p.plane] + p.h / 2, p.z];
/** A point on a plane's surface (slightly above it, so traces don't z-fight the grid). */
export const on = (plane: PlaneId, x: number, z: number, lift = 0.012): Vec3 => [x, Y[plane] + lift, z];
