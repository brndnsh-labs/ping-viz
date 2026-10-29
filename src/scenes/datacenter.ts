// The datacenter: one continuous zoom out, powers of ten, from the multiply-add units on one chip to
// a campus of hundreds of thousands of chips.
//
// b0 one chip: a die ringed by stacks of HBM; on the die, grids of multiply-add units with numbers
//    moving through them in diagonal waves (inputs rightward, partial sums downward).
// b1 one server: four chips on a board, joined by fast links (pulled out of its rack like a drawer).
// b2 racks, rows, a hall: the server slides home; every chip is a light on its server's front, and
//    each running copy of the model (a group of racks) lights up in waves, independently.
// b3 a campus: eight buildings of lights, a substation feeding them.
//
// Everything numerous is placed on the GPU from the instance index (datacenter-wgsl.ts); the floor
// plan is in datacenter-layout.ts. The camera interpolates distance in log space, so each power of
// ten takes about the same scroll.
import { C, CSS } from "../config";
import { BoxBatch, type BoxStyle } from "../render/boxes";
import type { CameraPose } from "../render/camera";
import type { Gfx, Rgb } from "../render/gfx";
import { LineBatch } from "../render/lines";
import { PointBatch } from "../render/points";
import { ramp, window as win } from "../util/ease";
import { DEG, type Vec3 } from "../util/math";
import * as L from "./datacenter-layout";
import { cellsWgsl, dashesWgsl, LIGHTS, lightsWgsl, racksWgsl, SYSTOLIC } from "./datacenter-wgsl";
import type { Label, Scene, SceneFactory, SceneFrame } from "./scene";

const VIOLET = C.hardware;
const AMBER = C.out;
const DARK: Rgb = [0.0045, 0.0045, 0.0085];
const BOARD: Rgb = [0.005, 0.006, 0.012];
const SILICON: Rgb = [0.008, 0.007, 0.016];
const HBM_FILL: Rgb = [0.012, 0.01, 0.026];
/** The numbers themselves (your prompt's, on their way through): warm white. */
const WARM: Rgb = [1.0, 0.86, 0.66];

/** How far the hero server is pulled out of its rack while we look at it. */
const DRAWER = 0.62;

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// ---- camera ------------------------------------------------------------------------------------

/** Monotone cubic through (xs, ys): Fritsch–Butland tangents, so no overshoot between keys. */
class Curve {
  private readonly xs: readonly number[];
  private readonly ys: readonly number[];
  private readonly m: number[];

  constructor(xs: readonly number[], ys: readonly number[]) {
    this.xs = xs;
    this.ys = ys;
    const n = xs.length;
    const d: number[] = [];
    for (let k = 0; k < n - 1; k++) {
      d.push(((ys[k + 1] as number) - (ys[k] as number)) / ((xs[k + 1] as number) - (xs[k] as number)));
    }
    this.m = xs.map((_, k) => {
      if (k === 0) return d[0] as number;
      if (k === n - 1) return d[n - 2] as number;
      const d0 = d[k - 1] as number;
      const d1 = d[k] as number;
      if (d0 * d1 <= 0) return 0;
      const h0 = (xs[k] as number) - (xs[k - 1] as number);
      const h1 = (xs[k + 1] as number) - (xs[k] as number);
      return (3 * (h0 + h1)) / ((2 * h1 + h0) / d0 + (h1 + 2 * h0) / d1);
    });
  }

  at(x: number): number {
    const { xs, ys, m } = this;
    const n = xs.length;
    if (x <= (xs[0] as number)) return ys[0] as number;
    if (x >= (xs[n - 1] as number)) return ys[n - 1] as number;
    let k = 0;
    while (k < n - 2 && x > (xs[k + 1] as number)) k++;
    const x0 = xs[k] as number;
    const h = (xs[k + 1] as number) - x0;
    const t = (x - x0) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * (ys[k] as number) +
      (t3 - 2 * t2 + t) * h * (m[k] as number) +
      (-2 * t3 + 3 * t2) * (ys[k + 1] as number) +
      (t3 - t2) * h * (m[k + 1] as number)
    );
  }
}

interface Shot {
  at: number;
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
  /** Distance multiplier on phones (a portrait screen is much narrower than the subject). */
  narrow: number;
}

/**
 * A zoom through shots of increasing distance. Distance follows the beat in log space (an even pace
 * per power of ten); the target follows the distance itself, so it drifts toward the next subject
 * in proportion to how far out we are and the last subject never leaves the frame abruptly.
 */
class Zoom {
  private readonly logD: Curve;
  private readonly target: [Curve, Curve, Curve];
  private readonly yaw: Curve;
  private readonly pitch: Curve;
  private readonly narrow: Curve;

  constructor(shots: readonly Shot[]) {
    const at = shots.map((s) => s.at);
    const ds = shots.map((s) => s.distance);
    this.logD = new Curve(at, ds.map(Math.log));
    const axis = (k: number): Curve =>
      new Curve(
        ds,
        shots.map((s) => s.target[k] as number),
      );
    this.target = [axis(0), axis(1), axis(2)];
    this.yaw = new Curve(
      at,
      shots.map((s) => s.yaw),
    );
    this.pitch = new Curve(
      at,
      shots.map((s) => s.pitch),
    );
    this.narrow = new Curve(
      at,
      shots.map((s) => s.narrow),
    );
  }

  pose(b: number, narrow: boolean): CameraPose {
    const d = Math.exp(this.logD.at(b));
    const [tx, ty, tz] = this.target;
    return {
      target: [tx.at(d), ty.at(d), tz.at(d)],
      distance: d * (narrow ? this.narrow.at(b) : 1),
      yaw: this.yaw.at(b) * DEG,
      pitch: this.pitch.at(b) * DEG,
      fov: 40,
    };
  }
}

const HERO_CHIP = L.heroChip(L.HERO.slot, DRAWER);
const HERO_GRID: Vec3 = (() => {
  const [gx, gz] = L.gridOrigin(L.HERO.grid);
  return add3(HERO_CHIP, [gx + L.GRID_SIDE / 2, L.DIE_TOP, gz + L.GRID_SIDE / 2]);
})();
const HERO_TRAY = L.heroTray(DRAWER);
const HALL = L.hallCenter(L.HERO.building, L.HERO.hall);
const CAMPUS = L.campusPoint(22, -40);
const SUBSTATION = L.campusPoint(150, 0);
/** The hero's model copy: the group of racks around the hero rack (x range, rack-face units). */
const GROUP_X0 = (Math.floor(L.HERO.rack / L.GROUP) * L.GROUP - L.HERO.rack) * L.RACK_W - L.RACK_W / 2;
const GROUP_W = L.GROUP * L.RACK_W;

// Keys a half-beat apart, each about 4x the last: the same scroll per power of ten.
const ZOOM = new Zoom([
  { at: -0.5, target: HERO_GRID, distance: 0.016, yaw: 24, pitch: 62, narrow: 1.3 },
  { at: 0, target: add3(HERO_CHIP, [-0.002, L.DIE_TOP, 0.002]), distance: 0.088, yaw: 18, pitch: 55, narrow: 2.1 },
  { at: 0.5, target: add3(HERO_CHIP, [-0.02, 0, -0.025]), distance: 0.25, yaw: 14, pitch: 50, narrow: 2.0 },
  { at: 1, target: add3(HERO_TRAY, [0, 0, 0.04]), distance: 0.95, yaw: 10, pitch: 46, narrow: 2.0 },
  { at: 1.5, target: [0.25, 1.15, -0.2], distance: 4.6, yaw: 4, pitch: 32, narrow: 1.6 },
  { at: 2, target: [1.6, 1.0, -5.5], distance: 21, yaw: -8, pitch: 33, narrow: 1.5 },
  { at: 2.5, target: add3(HALL, [0, 2, 0]), distance: 82, yaw: -16, pitch: 36, narrow: 1.5 },
  { at: 3, target: CAMPUS, distance: 480, yaw: -22, pitch: 38, narrow: 2.4 },
  { at: 3.5, target: CAMPUS, distance: 600, yaw: -27, pitch: 40, narrow: 2.4 },
]);

// ---- the scene -----------------------------------------------------------------------------------

class DatacenterScene implements Scene {
  readonly id = "datacenter" as const;
  /** Static: the ground, hall floors, cooling, the substation. */
  private readonly ground: BoxBatch;
  /** Static, additive: building outlines. */
  private readonly shells: BoxBatch;
  private readonly racks: BoxBatch;
  /** Per frame: the hero rack and its server. */
  private readonly near: BoxBatch;
  private readonly cells: BoxBatch;
  private readonly dashes: BoxBatch;
  /** Per frame, additive: the outline around one model copy. */
  private readonly glass: BoxBatch;
  private readonly lines: LineBatch;
  /** Static: feeders from the substation. */
  private readonly power: LineBatch;
  /** Static: the campus roads, faint. */
  private readonly roads: LineBatch;
  private readonly lights: PointBatch;
  private out: Label[] = [];
  private chipsOn = false;
  private shellsOn = 0;
  private powerOn = 0;

  constructor(gfx: Gfx) {
    const add = { blend: "add", depthWrite: false } as const;
    this.ground = new BoxBatch(gfx, "dc-ground");
    this.shells = new BoxBatch(gfx, "dc-shells", add);
    this.power = new LineBatch(gfx, "dc-power");
    this.roads = new LineBatch(gfx, "dc-roads");
    this.buildSite();
    this.racks = new BoxBatch(gfx, "dc-racks", {}, { key: "dc-racks", wgsl: racksWgsl });
    this.near = new BoxBatch(gfx, "dc-near");
    this.cells = new BoxBatch(gfx, "dc-cells", {}, { key: "dc-cells", wgsl: cellsWgsl });
    this.dashes = new BoxBatch(gfx, "dc-dashes", add, { key: "dc-dashes", wgsl: dashesWgsl });
    this.glass = new BoxBatch(gfx, "dc-glass", add);
    this.lines = new LineBatch(gfx, "dc-lines");
    this.lights = new PointBatch(gfx, "dc-lights", {}, { key: "dc-lights", wgsl: lightsWgsl });
    this.lights.procedural = LIGHTS.chips + LIGHTS.quads + LIGHTS.racks;
    this.racks.procedural = L.RACK_COUNT;
  }

  /** The static campus: ground, hall floors, building outlines, cooling rows, the substation. */
  private buildSite(): void {
    const g = this.ground;
    g.box(add3(CAMPUS, [0, -0.85, 0]), [4000, 1, 4000], { edge: VIOLET, edgePx: 0, fill: [0.0016, 0.002, 0.0038] });
    for (let b = 0; b < L.BUILDINGS; b++) {
      const bc = L.buildingCenter(b);
      for (let h = 0; h < L.HALLS; h++) {
        g.box(add3(L.hallCenter(b, h), [0, -0.15, 0]), [L.HALL_SIZE[0], 0.3, L.HALL_SIZE[1]], {
          edge: VIOLET,
          edgeIntensity: 0.18,
          edgePx: 1,
          fill: [0.0035, 0.004, 0.0075],
        });
      }
      this.shells.box(add3(bc, [0, L.BLD_H / 2, 0]), [L.BLD_SIZE[0], L.BLD_H, L.BLD_SIZE[1]], {
        edge: VIOLET,
        edgeIntensity: 0.3,
        edgePx: 1,
        fill: [0, 0, 0],
        fillIntensity: 0,
      });
      // Cooling: a row of heat-rejection units along the back of each roof.
      for (let k = 0; k < 9; k++) {
        g.box(add3(bc, [(k - 4) * 7.4, L.BLD_H + 0.8, -L.BLD_SIZE[1] / 2 + 4]), [4.6, 1.6, 3], {
          edge: [0.5, 0.6, 0.8],
          edgeIntensity: 0.06,
          edgePx: 1,
          fill: [0.002, 0.0022, 0.004],
        });
      }
      // A feeder from the substation.
      const end = add3(bc, [L.BLD_SIZE[0] / 2, 9, 0]);
      const feeder: Vec3[] = [
        add3(SUBSTATION, [-24, 9, 0]),
        [end[0] + 14, 9, SUBSTATION[2]],
        [end[0] + 14, 9, end[2]],
        end,
      ];
      this.power.polyline(feeder, {
        color: AMBER,
        width: 1,
        glow: 3,
        level: 0.1,
        flow: { period: 22, speed: 30, duty: 0.12, intensity: 1.4 },
      });
    }
    // Roads: a loop around the campus, a spine between the columns, cross streets between the rows.
    const road = { color: [0.42, 0.5, 0.72] as Rgb, width: 1.2, glow: 2, level: 0.16 };
    const y = -0.3;
    this.roads.polyline(
      [
        L.campusPoint(-104, 178, y),
        L.campusPoint(104, 178, y),
        L.campusPoint(104, -178, y),
        L.campusPoint(-104, -178, y),
        L.campusPoint(-104, 178, y),
      ],
      road,
    );
    this.roads.segment(L.campusPoint(0, 178, y), L.campusPoint(0, -178, y), road);
    for (const z of [90, -90]) this.roads.segment(L.campusPoint(-104, z, y), L.campusPoint(104, z, y), road);
    this.roads.segment(L.campusPoint(-104, 0, y), L.campusPoint(122, 0, y), road);
    // The substation: a yard of transformers.
    g.box(add3(SUBSTATION, [0, -0.1, 0]), [56, 0.2, 76], {
      edge: AMBER,
      edgeIntensity: 0.2,
      edgePx: 1,
      fill: [0.004, 0.0035, 0.0035],
    });
    for (let k = 0; k < 8; k++) {
      g.box(add3(SUBSTATION, [(k % 2) * 22 - 11, 2.8, Math.floor(k / 2) * 16 - 24]), [9, 5.6, 7], {
        edge: AMBER,
        edgeIntensity: 0.3,
        edgePx: 1,
        fill: DARK,
      });
    }
  }

  update(f: SceneFrame): CameraPose {
    const b = f.beat;
    const t = f.reducedMotion ? 4 : f.time;
    this.out = [];
    const drawer = DRAWER * (1 - ramp(b, 1.22, 1.72));
    const cam = ZOOM.pose(b, f.narrow);

    this.buildNear(b, drawer, cam.distance);
    // The grids on the dies, while they're big enough to see.
    this.chipsOn = b < 1.0;
    const tray = L.heroTray(drawer);
    for (const batch of [this.cells, this.dashes]) {
      batch.user.set(tray, 0);
      batch.time = t;
    }
    this.cells.procedural = this.chipsOn ? L.SLOTS * L.GRIDS * L.GRID_N * L.GRID_N : 0;
    this.dashes.procedural = this.chipsOn ? L.SLOTS * L.GRIDS * 2 * L.GRID_N * SYSTOLIC.burst * 3 : 0;

    this.racks.user.set([b > 2.2 ? 1 : 0, 0.32], 0);
    this.lights.user.set([drawer, 1, 0.8, 1.25, 0.32 * win(b, 1.75, 2.0, 2.5, 2.8)], 4);
    this.lights.maxPx = 3.2;
    this.lights.time = t;

    this.shellsOn = ramp(b, 2.2, 2.7);
    this.shells.opacity = this.shellsOn;
    this.powerOn = ramp(b, 2.6, 3.0);
    this.power.opacity = this.powerOn;
    this.power.time = t;
    this.roads.opacity = this.shellsOn;

    this.glass.begin();
    const group = win(b, 1.7, 2.0, 2.55, 2.85);
    if (group > 0.01) {
      this.glass.box(
        [GROUP_X0 + GROUP_W / 2, L.RACK_H / 2, -L.RACK_D / 2],
        [GROUP_W + 0.08, L.RACK_H + 0.08, L.RACK_D + 0.08],
        {
          edge: C.claude,
          edgeIntensity: 2 * group,
          edgePx: 1.5,
          fill: [0, 0, 0],
          fillIntensity: 0,
        },
      );
    }

    this.lines.begin();
    this.lines.time = t;
    if (b < 1.75) this.links(drawer, 1 - ramp(b, 1.3, 1.7));
    const feed = 1 - ramp(b, 0.2, 0.5);
    if (feed > 0.01) this.feeds(L.heroChip(L.HERO.slot, drawer), feed);

    this.labelsFor(b, drawer, f.narrow);
    return cam;
  }

  // ---- the hero rack and server ------------------------------------------------------------

  private buildNear(b: number, drawer: number, dist: number): void {
    const n = this.near;
    n.begin();
    const rack: BoxStyle = { edge: VIOLET, edgeIntensity: 0.32, edgePx: 1, fill: DARK };
    const W = L.RACK_W - 0.008;
    const D = L.RACK_D;
    const H = L.RACK_H;
    const top = L.TRAY_Y0 + L.HERO.tray * L.TRAY_PITCH;
    const t = L.heroTray(drawer);
    const at = (x: number, y: number, z: number): Vec3 => [t[0] + x, t[1] + y, t[2] + z];
    const panelZ = L.BOARD_D / 2 + 0.01;
    if (b > 2.2) return;
    // The hero rack, with a slot its server slides out of, closed by the server's front panel
    // (from b2.2 the rack is drawn like every other one). The slot's posts are thin: no edge maths
    // once they're sub-pixel (see the note on tiny boxes in datacenter-wgsl.ts).
    const s0 = top - 0.008;
    const s1 = top + L.PANEL_H - 0.004;
    n.box([0, s0 / 2, -D / 2], [W, s0, D], rack);
    n.box([0, (s1 + H) / 2, -D / 2], [W, H - s1, D], rack);
    const post: BoxStyle = { ...rack, edgePx: dist < 8 ? 1 : 0 };
    for (const sx of [-1, 1]) n.box([sx * (W / 2 - 0.01), (s0 + s1) / 2, -D / 2], [0.02, s1 - s0, D], post);
    n.box([0, (s0 + s1) / 2, -D + 0.01], [W - 0.04, s1 - s0, 0.02], rack);
    n.box(at(0, L.PANEL_H / 2 - 0.006, panelZ), [W - 0.044, L.PANEL_H, 0.02], rack);
    if (b > 1.8) return;

    // The rest of the server: a board on rails, four accelerators, ports, the host, power supplies.
    n.box(at(0, -0.003, 0), [L.BOARD_W, 0.006, L.BOARD_D], {
      edge: VIOLET,
      edgeIntensity: 0.45,
      edgePx: 1,
      fill: BOARD,
    });
    for (const sx of [-1, 1]) {
      n.box(at(sx * (L.BOARD_W / 2 - 0.006), 0.02, 0), [0.008, 0.04, L.BOARD_D], {
        edge: VIOLET,
        edgeIntensity: 0.3,
        fill: DARK,
      });
    }
    // Network ports behind the panel, the host computer and its memory at the back, power supplies.
    const faint: BoxStyle = { edge: VIOLET, edgeIntensity: 0.2, edgePx: 1, fill: DARK };
    for (let s = 0; s < L.SLOTS; s++) {
      n.box(at((s - 1.5) * L.LIGHT_DX + 0.034, 0.008, panelZ - 0.035), [0.022, 0.016, 0.05], faint);
    }
    n.box(at(0, 0.003, -0.215), [0.046, 0.006, 0.046], faint);
    for (let k = 0; k < 8; k++) {
      const x = (k < 4 ? -1 : 1) * (0.042 + (k % 4) * 0.011);
      n.box(at(x, 0.016, -0.215), [0.0035, 0.032, 0.12], { ...faint, edgeIntensity: 0.14 });
    }
    n.box(at(0.19, 0.022, -0.27), [0.1, 0.044, 0.11], faint);
    n.box(at(-0.19, 0.022, -0.27), [0.1, 0.044, 0.11], faint);

    // Detail fades with distance (the layers of the HBM stacks, the power stages).
    const close = 1 - ramp(Math.log(dist), Math.log(0.25), Math.log(0.6));
    // The die glows with its grids' average activity once the grids are too small to see.
    const glow = ramp(Math.log(dist), Math.log(0.14), Math.log(0.4));
    for (let s = 0; s < L.SLOTS; s++) this.chip(L.heroChip(s, drawer), close, glow);
  }

  /** One accelerator package: substrate, interposer, the die, six HBM stacks, power stages. */
  private chip(base: Vec3, close: number, glow: number): void {
    const n = this.near;
    const at = (x: number, y: number, z: number): Vec3 => [base[0] + x, base[1] + y, base[2] + z];
    const { SUB, INTERPOSER, DIE, HBM } = L;
    n.box(at(0, SUB.h / 2, 0), [SUB.w, SUB.h, SUB.w], { edge: VIOLET, edgeIntensity: 0.5, edgePx: 1, fill: SILICON });
    // (No edges once it's thinner than a pixel: see the note on tiny boxes in datacenter-wgsl.ts.)
    n.box(at(0, SUB.h + INTERPOSER.h / 2, 0), [INTERPOSER.w, INTERPOSER.h, INTERPOSER.d], {
      edge: VIOLET,
      edgeIntensity: 0.28,
      edgePx: close > 0.5 ? 1 : 0,
      fill: [0.01, 0.009, 0.018],
    });
    const k = 0.5 * glow;
    const dieFill: Rgb = [0.01 + k * C.claude[0], 0.008 + k * C.claude[1], 0.02 + k * C.claude[2]];
    n.box(at(0, SUB.h + INTERPOSER.h + DIE.h / 2, 0), [DIE.w, DIE.h, DIE.w], {
      edge: VIOLET,
      edgeIntensity: 1.2,
      edgePx: 1.2,
      fill: dieFill,
    });
    const y0 = SUB.h + INTERPOSER.h;
    const stack = HBM.layers * (HBM.layer + HBM.gap);
    const hbm: BoxStyle = { edge: VIOLET, edgeIntensity: 0.8, edgePx: 1, fill: HBM_FILL };
    for (const sx of [-1, 1]) {
      for (let j = -1; j <= 1; j++) {
        if (close > 0.5) {
          for (let l = 0; l < HBM.layers; l++) {
            const y = y0 + l * (HBM.layer + HBM.gap) + HBM.layer / 2;
            n.box(at(sx * HBM.x, y, j * HBM.pitch), [HBM.w, HBM.layer, HBM.d], hbm);
          }
        } else {
          n.box(at(sx * HBM.x, y0 + stack / 2, j * HBM.pitch), [HBM.w, stack, HBM.d], hbm);
        }
      }
    }
    if (close > 0.01) {
      for (let p = 0; p < 6; p++) {
        n.box(at((p - 2.5) * 0.0075, 0.0012, -SUB.w / 2 - 0.007), [0.0055, 0.0024, 0.0065], {
          edge: VIOLET,
          edgeIntensity: 0.3 * close,
          edgePx: 1,
          fill: DARK,
        });
      }
    }
  }

  /** Memory feeding the die: short traces across the interposer from each HBM stack, data flowing in. */
  private feeds(base: Vec3, k: number): void {
    const { HBM, DIE, SUB, INTERPOSER } = L;
    const y = base[1] + SUB.h + INTERPOSER.h + 0.00004;
    for (const sx of [-1, 1]) {
      for (let j = -1; j <= 1; j++) {
        for (let w = -2; w <= 2; w++) {
          const z = base[2] + j * HBM.pitch + w * HBM.d * 0.18;
          const from: Vec3 = [base[0] + sx * (HBM.x - HBM.w / 2), y, z];
          const to: Vec3 = [base[0] + (sx * DIE.w) / 2, y, z];
          this.lines.segment(from, to, {
            color: WARM,
            width: 1,
            glow: 3,
            level: 0.12,
            opacity: k,
            flow: { period: 0.0005, speed: 0.0016, duty: 0.3, intensity: 2.4 },
          });
        }
      }
    }
  }

  /** The chip-to-chip links on the hero server: a violet bundle each, with coral traffic both ways. */
  private links(drawer: number, k: number): void {
    if (k <= 0.01) return;
    const y = 0.0015;
    const half = L.SUB.w / 2;
    const bundle = (a: Vec3, b: Vec3, off: Vec3): void => {
      for (let i = -1; i <= 1; i++) {
        const p: Vec3 = [a[0] + off[0] * i, a[1] + y, a[2] + off[2] * i];
        const q: Vec3 = [b[0] + off[0] * i, b[1] + y, b[2] + off[2] * i];
        this.lines.segment(p, q, { color: VIOLET, width: 1, glow: 3, level: 0.22 * k });
        this.lines.segment(i === 0 ? q : p, i === 0 ? p : q, {
          color: C.claude,
          width: 1.2,
          glow: 4,
          level: 0,
          opacity: k,
          flow: { period: 0.024, speed: 0.07, duty: 0.18, intensity: 2.2 },
        });
      }
    };
    const [c0, c1, c2, c3] = [0, 1, 2, 3].map((s) => L.heroChip(s, drawer)) as [Vec3, Vec3, Vec3, Vec3];
    bundle(add3(c0, [half, 0, 0]), add3(c1, [-half, 0, 0]), [0, 0, 0.009]);
    bundle(add3(c2, [half, 0, 0]), add3(c3, [-half, 0, 0]), [0, 0, 0.009]);
    bundle(add3(c0, [0, 0, -half]), add3(c2, [0, 0, half]), [0.009, 0, 0]);
    bundle(add3(c1, [0, 0, -half]), add3(c3, [0, 0, half]), [0.009, 0, 0]);
    // Out to the network ports: links to the chips in other servers.
    const t = L.heroTray(drawer);
    for (const chip of [c0, c1])
      bundle(add3(chip, [0, 0, half]), [chip[0], chip[1], t[2] + L.BOARD_D / 2 - 0.06], [0.009, 0, 0]);
  }

  // ---- labels ----------------------------------------------------------------------------------

  private label(id: string, pos: Vec3, text: string, opts: Partial<Label> = {}): void {
    this.out.push({ id, pos, text, kind: "note", ...opts });
  }

  private labelsFor(b: number, drawer: number, narrow: boolean): void {
    const chip = L.heroChip(L.HERO.slot, drawer);
    const [gx, gz] = L.gridOrigin(L.HERO.grid);
    this.label("mac", add3(chip, [gx + L.GRID_SIDE / 2, L.DIE_TOP, gz + L.GRID_SIDE]), "multiply-and-add units", {
      align: "center",
      dy: 16,
      color: CSS.claude,
      opacity: win(b, -0.6, -0.45, 0.2, 0.4),
    });
    const hbmTop = L.SUB.h + L.INTERPOSER.h + L.HBM.layers * (L.HBM.layer + L.HBM.gap);
    this.label("hbm", add3(chip, [L.HBM.x, hbmTop, L.HBM.pitch + L.HBM.d / 2]), "high-bandwidth memory", {
      align: narrow ? "right" : "center",
      dy: 16,
      color: CSS.hardware,
      opacity: win(b, -0.25, -0.05, 0.3, 0.5),
    });
    this.label("chip", add3(chip, [0, 0, L.SUB.w / 2]), "one accelerator chip", {
      kind: "name",
      align: "center",
      dy: 18,
      color: CSS.hardware,
      opacity: win(b, 0.25, 0.45, 0.75, 0.95),
    });
    const tray = L.heroTray(drawer);
    // Below the server's front panel; on phones, where the text covers that, above its back edge.
    const serverAt: Vec3 = narrow ? [0, 0.05, -L.BOARD_D / 2] : [0, -0.006, L.BOARD_D / 2 + 0.02];
    this.label("server", add3(tray, serverAt), "one server", {
      kind: "name",
      align: "center",
      dy: narrow ? -14 : 16,
      color: CSS.hardware,
      opacity: win(b, 0.7, 0.9, 1.3, 1.5),
    });
    this.label("links", add3(L.heroChip(0, drawer), [L.CHIP_X, 0.002, 0]), "chip-to-chip links", {
      align: "center",
      dy: -14,
      color: CSS.claude,
      opacity: win(b, 0.75, 0.95, 1.2, 1.4),
    });
    this.label("rack", [L.RACK_W / 2, L.RACK_H, -L.RACK_D / 2], "a rack: dozens of chips", {
      kind: "name",
      color: CSS.hardware,
      opacity: win(b, 1.35, 1.55, 1.75, 1.9),
    });
    this.label("copy", [GROUP_X0 + GROUP_W / 2, L.RACK_H + 0.1, -L.RACK_D / 2], "one copy of the model", {
      align: "center",
      dy: -12,
      color: CSS.claude,
      opacity: win(b, 1.85, 2.0, 2.5, 2.75),
    });
    this.label("hall", add3(HALL, [0, 3, -L.HALL_SIZE[1] / 2]), "a hall: tens of thousands", {
      kind: "name",
      align: "center",
      dy: -14,
      color: CSS.hardware,
      opacity: win(b, 2.2, 2.45, 2.8, 3.0),
    });
    this.label("campus", add3(CAMPUS, [0, 60, -60]), "a campus: hundreds of thousands", {
      kind: "big",
      align: "center",
      opacity: ramp(b, 2.75, 3.0),
    });
    this.label("power", add3(SUBSTATION, [0, 8, 0]), "power", {
      align: "center",
      dy: -12,
      color: CSS.out,
      opacity: ramp(b, 2.8, 3.1),
    });
  }

  // ---- draw ------------------------------------------------------------------------------------

  draw(pass: GPURenderPassEncoder): void {
    this.ground.draw(pass);
    this.racks.draw(pass);
    this.near.draw(pass);
    if (this.chipsOn) this.cells.draw(pass);
    if (this.shellsOn > 0.01) this.shells.draw(pass);
    this.glass.draw(pass);
    if (this.chipsOn) this.dashes.draw(pass);
    if (this.shellsOn > 0.01) this.roads.draw(pass);
    if (this.powerOn > 0.01) this.power.draw(pass);
    this.lines.draw(pass);
    this.lights.draw(pass);
  }

  labels(out: Label[]): void {
    out.push(...this.out);
  }
}

const datacenterScene: SceneFactory = (gfx) => new DatacenterScene(gfx);
export default datacenterScene;
