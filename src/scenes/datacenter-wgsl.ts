// Shader hooks for the datacenter: everything numerous is placed and animated on the GPU from the
// instance index (see datacenter-layout.ts for the plan). Four sets:
//   racks   every rack on the campus as a box (culled once it's a couple of px tall)
//   lights  one light per chip on its server's front panel, merging into fewer lights far away
//   cells   the multiply-add grids on the four dies of the hero server
//   dashes  numbers flowing through those grids (systolic: inputs rightward, sums downward)
import { C } from "../config";
import type { Rgb } from "../render/gfx";
import * as L from "./datacenter-layout";

const f = (x: number): string => {
  const s = String(x);
  return /[.eE]/.test(s) ? s : `${s}.0`;
};
const v3 = (c: readonly number[]): string => `vec3f(${f(c[0] ?? 0)}, ${f(c[1] ?? 0)}, ${f(c[2] ?? 0)})`;
const rgb = (c: Rgb, k = 1): string => v3([c[0] * k, c[1] * k, c[2] * k]);

/** Systolic timing: cycles per wall-clock second, burst period and length (in cycles). */
export const SYSTOLIC = { cps: 14, period: 40, burst: 3 };
/** World diameter of one chip light (about its spacing, so far-away lights add up to an even glow). */
const LIGHT_SIZE = 0.1;
/**
 * Light levels of detail by a rack's height on screen (CSS px): per chip above chipHi (the hero's
 * building only), four per rack in between, one per rack below rackLo.
 */
const LOD = { chipLo: 10, chipHi: 18, rackHi: 6, rackLo: 3 };
/** Instance ranges of the lights batch. */
export const LIGHTS = { chips: L.BLD_RACKS * L.RACK_CHIPS, quads: L.RACK_COUNT * 4, racks: L.RACK_COUNT };

const LAYOUT = /* wgsl */ `
const DC_RACKS = ${L.RACKS}u;
const DC_ROWS = ${L.ROWS}u;
const DC_BLOCKS = ${L.BLOCKS}u;
const DC_HALLS = ${L.HALLS}u;
const DC_BLD_COLS = ${L.BLD_COLS}u;
const DC_TRAYS = ${L.TRAYS}u;
const DC_SLOTS = ${L.SLOTS}u;
const DC_GROUP = ${L.GROUP}u;
const DC_HERO_RACK = ${L.HERO_RACK}u;
const DC_HERO_GROUP = ${L.HERO_GROUP}u;
const DC_HERO_TRAY = ${L.HERO.tray}u;
const DC_ORIGIN = ${v3(L.ORIGIN)};
const DC_RACK_W = ${f(L.RACK_W)};
const DC_RACK_D = ${f(L.RACK_D)};
const DC_RACK_H = ${f(L.RACK_H)};
const DC_TRAY_Y0 = ${f(L.TRAY_Y0)};
const DC_TRAY_PITCH = ${f(L.TRAY_PITCH)};
const DC_LIGHT_DX = ${f(L.LIGHT_DX)};
const DC_LIGHT_DY = ${f(L.LIGHT_DY)};
const DC_ROW_PITCH = ${f(L.ROW_PITCH)};
const DC_BLOCK_PITCH = ${f(L.BLOCK_PITCH)};
const DC_HALL_PITCH = ${f(L.HALL_PITCH)};
const DC_HALL_FRONT = ${f(L.HALL_FRONT)};
const DC_BLD_X = ${f(L.BLD_PITCH[0])};
const DC_BLD_Z = ${f(L.BLD_PITCH[1])};

// Front-bottom-centre of rack ri, in world space (the hero rack is the origin).
fn dcRackFront(ri: u32) -> vec3f {
  let rack = ri % DC_RACKS;
  var r = ri / DC_RACKS;
  let row = r % DC_ROWS;
  r = r / DC_ROWS;
  let blk = r % DC_BLOCKS;
  r = r / DC_BLOCKS;
  let hall = r % DC_HALLS;
  let bld = r / DC_HALLS;
  let hx = (f32(bld % DC_BLD_COLS) - ${f((L.BLD_COLS - 1) / 2)}) * DC_BLD_X + (0.5 - f32(hall)) * DC_HALL_PITCH - DC_ORIGIN.x;
  let hz = (${f((L.BUILDINGS / L.BLD_COLS - 1) / 2)} - f32(bld / DC_BLD_COLS)) * DC_BLD_Z + DC_HALL_FRONT - DC_ORIGIN.z;
  let x = hx + (f32(blk) - 0.5) * DC_BLOCK_PITCH + (f32(rack) - ${f((L.RACKS - 1) / 2)}) * DC_RACK_W;
  return vec3f(x, 0.0, hz - f32(row) * DC_ROW_PITCH);
}

// How busy a model copy (a group of racks) is at position u along it (0..1): a wave sweeping
// through the group in pipeline order, each group on its own clock; now and then one idles.
fn dcWave(g: u32, u: f32, t: f32) -> f32 {
  let h0 = hash1(g * 2654435761u + 17u);
  let h1 = hash1(g * 40503u + 911u);
  let x = t / (1.7 + 1.9 * h0) + h1 * 7.0;
  let cyc = u32(floor(x));
  var busy = select(0.0, 1.0, hash1(cyc * 747796405u + g * 2891336453u) > 0.22);
  if (g == DC_HERO_GROUP) {
    busy = 1.0;
  }
  let d = (fract(x) * 1.7 - 0.35) - u;
  let a = select(exp(d * 40.0), exp(-d * 7.0), d >= 0.0);
  return a * busy;
}
`;

/** Every rack on the campus. user[0]: x = draw the hero rack too, y = edge intensity. */
export const racksWgsl = /* wgsl */ `${LAYOUT}
fn getBox(i: u32) -> BoxInst {
  var b: BoxInst;
  b.edge = vec4f(0.0);
  b.fill = vec4f(0.0);
  b.yaw = 0.0;
  b.edgePx = 1.0;
  if (i == DC_HERO_RACK && batch.user[0].x < 0.5) {
    return b;
  }
  let c = dcRackFront(i) + vec3f(0.0, DC_RACK_H * 0.5, -DC_RACK_D * 0.5);
  let px = DC_RACK_H * cam.pxPerUnit / max(viewDepth(c), cam.near) / cam.pxScale;
  // A rack a few px tall is a speck (its lights carry it from here). Tiny boxes with edges on can
  // also shade to NaN in boxes.wgsl (the edge glow), which the bloom smears into a black patch:
  // drop them, and skip the edge maths until the edges can show.
  if (px < 6.0) {
    return b;
  }
  b.edgePx = select(0.0, 1.0, px > 7.0);
  b.center = c;
  b.half = vec3f(DC_RACK_W * 0.5 - 0.004, DC_RACK_H * 0.5, DC_RACK_D * 0.5);
  b.edge = vec4f(${rgb(C.hardware)}, batch.user[0].y * smoothstep(6.0, 18.0, px));
  b.fill = vec4f(0.0045, 0.0045, 0.0085, 1.0);
  return b;
}
`;

/**
 * The chips' lights, on their servers' front panels, in three levels of detail with the same total
 * light per rack: one per chip (the hero's building only), four per rack, one per rack. Instances:
 * [0, LIGHTS.chips) chips, then LIGHTS.quads, then LIGHTS.racks. user[1]: x = the hero server's
 * drawer offset, y = intensity, z = glow, w = min px. user[2].x: the hero group's highlight.
 */
export const lightsWgsl = /* wgsl */ `${LAYOUT}
const DC_LIGHT_SIZE = ${f(LIGHT_SIZE)};
const DC_CHIP_LIGHTS = ${LIGHTS.chips}u;
const DC_QUAD_LIGHTS = ${LIGHTS.quads}u;
const DC_BLD_RACKS = ${L.BLD_RACKS}u;

fn dcLightColor(a: f32) -> vec3f {
  return mix(${rgb([1.0, 0.74, 0.5], 0.2)}, ${rgb(C.claude, 1.5)}, a);
}

fn getPoint(i: u32) -> PointInst {
  var p: PointInst;
  p.color = vec4f(0.0);
  p.px = 0.0;
  p.shape = 0.0;
  p.glow = batch.user[1].z;
  p.minPx = batch.user[1].w;
  var level = 0u;
  var ri = 0u;
  var sub = 0u;
  if (i < DC_CHIP_LIGHTS) {
    ri = i / (DC_SLOTS * DC_TRAYS);
    sub = i % (DC_SLOTS * DC_TRAYS);
  } else if (i < DC_CHIP_LIGHTS + DC_QUAD_LIGHTS) {
    level = 1u;
    ri = (i - DC_CHIP_LIGHTS) / 4u;
    sub = (i - DC_CHIP_LIGHTS) % 4u;
  } else {
    level = 2u;
    ri = i - DC_CHIP_LIGHTS - DC_QUAD_LIGHTS;
  }
  let front = dcRackFront(ri);
  let rackPx = DC_RACK_H * cam.pxPerUnit / max(viewDepth(front + vec3f(0.0, DC_RACK_H * 0.5, 0.0)), cam.near) / cam.pxScale;
  // Reversed smoothstep edges are undefined on Metal and SPIR-V, so flip the result instead.
  let wRack = 1.0 - smoothstep(${f(LOD.rackLo)}, ${f(LOD.rackHi)}, rackPx);
  let wChip = select(0.0, smoothstep(${f(LOD.chipLo)}, ${f(LOD.chipHi)}, rackPx), ri < DC_BLD_RACKS);
  var w = 1.0 - wRack - wChip;
  if (level == 0u) {
    w = wChip;
  } else if (level == 2u) {
    w = wRack;
  }
  if (w <= 0.001) {
    return p;
  }
  let t = batch.misc.y;
  let g = ri / DC_GROUP;
  let k = ri % DC_GROUP;
  var pos = front;
  var u = (f32(k) + 0.5) / f32(DC_GROUP);
  if (level == 0u) {
    let slot = sub % DC_SLOTS;
    let tray = sub / DC_SLOTS;
    pos += vec3f((f32(slot) - 1.5) * DC_LIGHT_DX, DC_TRAY_Y0 + f32(tray) * DC_TRAY_PITCH + DC_LIGHT_DY, 0.0);
    if (ri == DC_HERO_RACK && tray == DC_HERO_TRAY) {
      pos.z += batch.user[1].x;
    }
    u = (f32(k * DC_SLOTS + slot) + 0.5) / f32(DC_GROUP * DC_SLOTS) - f32(tray) * 0.012;
    p.size = DC_LIGHT_SIZE;
  } else {
    // Merged lights sit on the rack's top: from a distance the rows hide each other's fronts (as
    // they would), but the tops stay in view. They carry about the share of light the fronts show.
    let z = select(-0.5 * DC_RACK_D, -(f32(sub) + 0.5) * 0.25 * DC_RACK_D, level == 1u);
    pos += vec3f(0.0, DC_RACK_H, z);
    p.size = DC_LIGHT_SIZE * select(8.0, 4.0, level == 1u);
    w *= 0.7;
  }
  // Stand off the surface by more as depth precision coarsens with distance.
  let off = 0.008 + viewDepth(pos) * 4e-5;
  if (level == 0u) {
    pos.z += off;
  } else {
    pos.y += off;
  }
  var a = dcWave(g, u, t);
  if (g == DC_HERO_GROUP) {
    // The copy we point at: lit a little throughout while it's outlined.
    a = max(a, batch.user[2].x);
  }
  p.pos = pos;
  p.color = vec4f(dcLightColor(a), w * batch.user[1].y);
  return p;
}
`;

const CHIPS = /* wgsl */ `
const DC_N = ${L.GRID_N}u;
const DC_CELL = ${f(L.CELL)};
// Height of the cells above the die: they're flat tiles (zero thickness, so no sliver side faces).
const DC_CELL_H = 0.00002;
const DC_GRID_SIDE = ${f(L.GRID_SIDE)};
const DC_GRID_STEP = ${f(L.GRID_SIDE + L.GRID_GAP)};
const DC_GRID_SPAN = ${f(L.GRID_SPAN)};
const DC_DIE_TOP = ${f(L.DIE_TOP)};
const DC_CHIP_X = ${f(L.CHIP_X)};
const DC_CHIP_ZF = ${f(L.CHIP_Z_FRONT)};
const DC_CHIP_ZB = ${f(L.CHIP_Z_BACK)};
const DC_CPS = ${f(SYSTOLIC.cps)};
const DC_P = ${f(SYSTOLIC.period)};
const DC_K = ${f(SYSTOLIC.burst)};

// Min corner of grid g on chip c's die (user[0].xyz is the hero server's board-top centre).
fn dcGridOrigin(c: u32, g: u32) -> vec3f {
  let x = f32(c % 2u) * 2.0 - 1.0;
  let z = select(DC_CHIP_ZB, DC_CHIP_ZF, c < 2u);
  let o = batch.user[0].xyz + vec3f(x * DC_CHIP_X, DC_DIE_TOP, z);
  return o + vec3f(-DC_GRID_SPAN * 0.5 + f32(g % 2u) * DC_GRID_STEP, 0.0, -DC_GRID_SPAN * 0.5 + f32(g / 2u) * DC_GRID_STEP);
}

// The grid's clock in cycles (each grid a little out of step with the others).
fn dcCycles(c: u32, g: u32) -> f32 {
  return batch.misc.y * DC_CPS + f32(c) * 17.0 + f32(g) * 7.0;
}
`;

/**
 * The multiply-add cells (4 chips x 4 grids x 32 x 32). A burst of input vectors enters every
 * DC_P cycles; cell (r, c) works on vector v at cycle v + r + c, so the work moves as a diagonal
 * wave.
 */
export const cellsWgsl = /* wgsl */ `${CHIPS}
fn dcMac(t: f32, r: u32, c: u32) -> f32 {
  let ph = t - f32(r + c);
  let m = ph - floor(ph / DC_P) * DC_P;
  let on = smoothstep(-0.6, 0.4, m) * (1.0 - smoothstep(DC_K - 0.6, DC_K + 0.4, m));
  let after = select(0.0, exp(-(m - DC_K) / 3.0), m > DC_K);
  return max(on, after * 0.4);
}

fn getBox(i: u32) -> BoxInst {
  var b: BoxInst;
  b.edge = vec4f(0.0);
  b.fill = vec4f(0.0);
  b.yaw = 0.0;
  b.edgePx = 1.0;
  let per = DC_N * DC_N;
  let chip = i / (per * 4u);
  let g = (i / per) % 4u;
  let r = (i / DC_N) % DC_N;
  let c = i % DC_N;
  let p = dcGridOrigin(chip, g) + vec3f((f32(c) + 0.5) * DC_CELL, DC_CELL_H, (f32(r) + 0.5) * DC_CELL);
  let px = DC_CELL * cam.pxPerUnit / max(viewDepth(p), cam.near) / cam.pxScale;
  if (px < 1.0) {
    return b;
  }
  let a = dcMac(dcCycles(chip, g), r, c);
  b.center = p;
  b.half = vec3f(DC_CELL * 0.4, 0.0, DC_CELL * 0.4);
  b.edgePx = select(0.0, 1.0, px > 3.0);
  b.edge = vec4f(${rgb(C.hardware)}, (0.16 + 0.5 * a) * smoothstep(3.0, 10.0, px));
  b.fill = vec4f(mix(vec3f(0.008, 0.006, 0.018), ${rgb(C.claude, 0.95)}, a), 1.0);
  return b;
}
`;

/**
 * The numbers moving through the grids, as small glowing dashes (additive): inputs (warm white)
 * enter each row from the left and move right; partial sums (coral) move down each column,
 * growing, and leave at the bottom.
 */
export const dashesWgsl = /* wgsl */ `${CHIPS}
const DC_KI = ${SYSTOLIC.burst}u;
const DC_J = ${SYSTOLIC.burst * 3}u;

fn getBox(i: u32) -> BoxInst {
  var b: BoxInst;
  b.edge = vec4f(0.0);
  b.fill = vec4f(0.0);
  b.yaw = 0.0;
  b.edgePx = 0.0;
  let perGrid = 2u * DC_N * DC_J;
  let chip = i / (perGrid * 4u);
  let g = (i / perGrid) % 4u;
  let rem = i % perGrid;
  let dir = rem / (DC_N * DC_J);
  let lane = (rem / DC_J) % DC_N;
  let j = rem % DC_J;
  let o = dcGridOrigin(chip, g);
  let px = DC_CELL * cam.pxPerUnit / max(viewDepth(o), cam.near) / cam.pxScale;
  if (px < 2.5) {
    return b;
  }
  let tl = dcCycles(chip, g) - f32(lane);
  let n = floor((tl + 3.0) / DC_P) - f32(j / DC_KI);
  let s = tl - (n * DC_P + f32(j % DC_KI));
  let n32 = f32(DC_N);
  let y = DC_CELL_H + DC_CELL * 0.05;
  var k = 0.0;
  if (dir == 0u) {
    k = smoothstep(-3.0, -1.5, s) * (1.0 - smoothstep(n32 - 1.0, n32, s));
    b.center = o + vec3f((s + 0.5) * DC_CELL, y, (f32(lane) + 0.5 - 0.2) * DC_CELL);
    b.half = vec3f(DC_CELL * 0.3, DC_CELL * 0.03, DC_CELL * 0.085);
    b.fill = vec4f(${rgb([1.0, 0.86, 0.66], 2.6)}, k);
  } else {
    k = smoothstep(-0.5, 0.5, s) * (1.0 - smoothstep(n32 + 1.0, n32 + 3.0, s)) * (0.5 + 0.8 * clamp(s / n32, 0.0, 1.0));
    b.center = o + vec3f((f32(lane) + 0.5 + 0.2) * DC_CELL, y, (s + 0.5) * DC_CELL);
    b.half = vec3f(DC_CELL * 0.085, DC_CELL * 0.03, DC_CELL * 0.3);
    b.fill = vec4f(${rgb(C.claude, 3.4)}, k);
  }
  b.fill.a *= smoothstep(2.5, 5.0, px);
  if (k <= 0.0) {
    b.fill.a = 0.0;
  }
  return b;
}
`;
