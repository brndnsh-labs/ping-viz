// The datacenter's floor plan, shared by the scene (CPU) and its shader hooks (GPU): one chip, the
// server it sits in, racks, rows, halls, buildings, a campus. Units are metres; y is up; rack
// fronts face +z. World coordinates put the hero rack's front-bottom-centre at the origin, so the
// close-ups (sub-millimetre detail) keep full float precision.
//
// Instance order is building → hall → block → row → rack → server → chip, with the hero's building
// first: 8 buildings x 2 halls x 640 racks x 64 chips = 655,360 chips.
import type { Vec3 } from "../util/math";

// ---- one rack --------------------------------------------------------------------------------
export const RACK_W = 0.6;
export const RACK_D = 1.1;
export const RACK_H = 2.1;
/** Servers (trays) per rack, the lowest one's board top, and their spacing. */
export const TRAYS = 16;
export const TRAY_Y0 = 0.25;
export const TRAY_PITCH = 0.105;
/** Chips per server (2 x 2 on the board; their status lights sit in a row on the front panel). */
export const SLOTS = 4;
export const LIGHT_DX = 0.12;
export const LIGHT_DY = 0.042;

// ---- a server (tray-local: origin at the board's top centre, front edge toward +z) ----------
export const BOARD_W = 0.54;
export const BOARD_D = 0.68;
/** Board centre behind the rack front (the front panel is flush with the rack face). */
const BOARD_Z = -0.36;
export const PANEL_H = 0.088;
export const CHIP_X = 0.095;
export const CHIP_Z_FRONT = 0.14;
export const CHIP_Z_BACK = -0.07;

function chipLocal(slot: number): Vec3 {
  return [(slot % 2) * 2 * CHIP_X - CHIP_X, 0, slot < 2 ? CHIP_Z_FRONT : CHIP_Z_BACK];
}

// ---- one chip (chip-local: origin at the package's bottom centre) ----------------------------
export const SUB = { w: 0.058, h: 0.0018 };
export const INTERPOSER = { w: 0.046, d: 0.03, h: 0.0005 };
export const DIE = { w: 0.024, h: 0.0007 };
export const DIE_TOP = SUB.h + INTERPOSER.h + DIE.h;
/** HBM stacks: three either side of the die, each a few stacked dies. */
export const HBM = {
  w: 0.0076,
  d: 0.007,
  pitch: 0.0082,
  x: DIE.w / 2 + 0.0012 + 0.0038,
  layers: 4,
  layer: 0.00022,
  gap: 0.00006,
};
/** Multiply-add grids on the die: 2 x 2 of them, N x N cells each. */
export const GRID_N = 32;
export const GRIDS = 4;
export const CELL = 0.0003;
export const GRID_SIDE = GRID_N * CELL;
export const GRID_GAP = 0.0011;
export const GRID_SPAN = 2 * GRID_SIDE + GRID_GAP;

/** Min corner (x, z) of grid g on the die, relative to the die centre. */
export function gridOrigin(g: number): [number, number] {
  return [
    -GRID_SPAN / 2 + (g % 2) * (GRID_SIDE + GRID_GAP),
    -GRID_SPAN / 2 + Math.floor(g / 2) * (GRID_SIDE + GRID_GAP),
  ];
}

// ---- rows, halls, buildings, campus ---------------------------------------------------------
export const RACKS = 20;
export const ROWS = 16;
export const BLOCKS = 2;
export const HALLS = 2;
export const BUILDINGS = 8;
/** Racks per running copy of the model (an illustrative group). */
export const GROUP = 4;
export const ROW_PITCH = 2.6;
/** Centre to centre of the two blocks of rows either side of a hall's main aisle. */
export const BLOCK_PITCH = 15.2;
export const HALL_PITCH = 34.6;
/** Front row's rack faces, in front of the hall centre. */
export const HALL_FRONT = 20.05;
export const HALL_SIZE: [number, number] = [31.6, 45];
export const BLD_PITCH: [number, number] = [106, 90];
export const BLD_SIZE: [number, number] = [70, 52];
export const BLD_H = 11;
/** Buildings stand in this many columns (x), the rows running back from the front (-z). */
export const BLD_COLS = 2;

export const BLD_RACKS = RACKS * ROWS * BLOCKS * HALLS;
export const RACK_COUNT = BLD_RACKS * BUILDINGS;
export const RACK_CHIPS = TRAYS * SLOTS;

export const HERO = { building: 0, hall: 0, block: 0, row: 0, rack: 17, tray: 8, slot: 1, grid: 2 };
export const HERO_RACK =
  (((HERO.building * HALLS + HERO.hall) * BLOCKS + HERO.block) * ROWS + HERO.row) * RACKS + HERO.rack;
export const HERO_GROUP = Math.floor(HERO_RACK / GROUP);

const BLD_ROWS = BUILDINGS / BLD_COLS;

/** Campus position of a building's centre (before the hero offset). Building 0, the hero's, is front left. */
function buildingCampus(bld: number): [number, number] {
  return [
    ((bld % BLD_COLS) - (BLD_COLS - 1) / 2) * BLD_PITCH[0],
    ((BLD_ROWS - 1) / 2 - Math.floor(bld / BLD_COLS)) * BLD_PITCH[1],
  ];
}

function hallCampus(bld: number, hall: number): [number, number] {
  const [bx, bz] = buildingCampus(bld);
  return [bx + (0.5 - hall) * HALL_PITCH, bz];
}

function rackFrontCampus(ri: number): Vec3 {
  const rack = ri % RACKS;
  let r = Math.floor(ri / RACKS);
  const row = r % ROWS;
  r = Math.floor(r / ROWS);
  const blk = r % BLOCKS;
  r = Math.floor(r / BLOCKS);
  const hall = r % HALLS;
  const bld = Math.floor(r / HALLS);
  const [hx, hz] = hallCampus(bld, hall);
  return [hx + (blk - 0.5) * BLOCK_PITCH + (rack - (RACKS - 1) / 2) * RACK_W, 0, hz + HALL_FRONT - row * ROW_PITCH];
}

/** The hero rack's front-bottom-centre on the campus: the world origin. */
export const ORIGIN = rackFrontCampus(HERO_RACK);

const world = (x: number, z: number, y = 0): Vec3 => [x - ORIGIN[0], y, z - ORIGIN[2]];

export function hallCenter(bld: number, hall: number): Vec3 {
  const [x, z] = hallCampus(bld, hall);
  return world(x, z);
}

export function buildingCenter(bld: number): Vec3 {
  const [x, z] = buildingCampus(bld);
  return world(x, z);
}

export function campusPoint(x: number, z: number, y = 0): Vec3 {
  return world(x, z, y);
}

/** Board-top centre of the hero server, pulled `drawer` metres out of its rack. */
export function heroTray(drawer: number): Vec3 {
  return [0, TRAY_Y0 + HERO.tray * TRAY_PITCH, BOARD_Z + drawer];
}

/** Bottom centre of chip `slot`'s package on the hero server. */
export function heroChip(slot: number, drawer: number): Vec3 {
  const t = heroTray(drawer);
  const c = chipLocal(slot);
  return [t[0] + c[0], t[1], t[2] + c[2]];
}
