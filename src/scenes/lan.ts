// The house: Wi-Fi from the laptop to the router, NAT, then light out to the street, where a passive
// optical splitter shares one fiber between neighbours who take turns.
import { C, CSS, mixRgb, scaleRgb } from "../config";
import { BoxBatch } from "../render/boxes";
import { type CameraPose, fitNarrow, pose, poseAt } from "../render/camera";
import type { Gfx, Rgb } from "../render/gfx";
import { LineBatch } from "../render/lines";
import { PointBatch } from "../render/points";
import { circle, cubic, filleted, pointAt } from "../render/shapes";
import { ramp, seg, window as win } from "../util/ease";
import type { Vec3 } from "../util/math";
import type { Label, Scene, SceneFactory, SceneFrame } from "./scene";

const LAPTOP: Vec3 = [-3.6, 0.45, -2.0];
const PHONE: Vec3 = [-3.2, 0.3, 2.4];
const TV: Vec3 = [3.4, 0.9, 3.7];
const SPEAKER: Vec3 = [-5.2, 0.35, 0.6];
const ROUTER: Vec3 = [1.6, 0.55, -1.6];
const ONT: Vec3 = [5.75, 0.7, -2.6];
const SPLITTER: Vec3 = [13, 0.3, -6];
const OLT: Vec3 = [34, 0.3, -6];

// Walls of the floor plan (outer shell and rooms), drawn at floor and at wall-top height.
const WALLS: Vec3[][] = [
  [
    [-6, 0, -4],
    [6, 0, -4],
    [6, 0, 4],
    [-6, 0, 4],
    [-6, 0, -4],
  ],
  [
    [-1, 0, -4],
    [-1, 0, -1.6],
  ],
  [
    [-1, 0, -0.4],
    [-1, 0, 4],
  ],
  [
    [-6, 0, 0],
    [-2.4, 0, 0],
  ],
  [
    [-1.4, 0, 0],
    [-1, 0, 0],
  ],
  [
    [-1, 0, 0.6],
    [2.2, 0, 0.6],
  ],
  [
    [3.4, 0, 0.6],
    [6, 0, 0.6],
  ],
];
const WALL_H = 0.7;

// The fiber: out of the ONT, under the yard, to the splitter at the street, then the trunk.
const DROP = filleted(
  [
    [ONT[0] + 0.15, 0.6, ONT[2]],
    [7.2, 0.05, ONT[2]],
    [10, 0.05, ONT[2]],
    [11.5, 0.05, SPLITTER[2]],
    [SPLITTER[0] - 0.5, 0.3, SPLITTER[2]],
  ],
  0.8,
  8,
);
const TRUNK: Vec3[] = [[SPLITTER[0] + 0.5, 0.3, SPLITTER[2]], OLT];
const NEIGHBOURS: Vec3[] = [
  [11, 0, -12],
  [15.5, 0, -12],
  [17, 0, -2.5],
];

class LanScene implements Scene {
  readonly id = "lan" as const;
  private readonly boxes: BoxBatch;
  private readonly lines: LineBatch;
  private readonly points: PointBatch;
  private readonly house: LineBatch;
  private readonly qam: PointBatch;
  private out: Label[] = [];
  private qamOn = 0;

  constructor(gfx: Gfx) {
    this.boxes = new BoxBatch(gfx, "lan-boxes");
    this.lines = new LineBatch(gfx, "lan-lines");
    this.points = new PointBatch(gfx, "lan-points");
    this.house = new LineBatch(gfx, "lan-house");
    for (const w of WALLS) {
      this.house.polyline(w, { color: C.dim, width: 1.1, glow: 2, level: 0.75 });
      this.house.polyline(
        w.map((p) => [p[0], WALL_H, p[2]] as Vec3),
        { color: C.dim, width: 0.9, glow: 1, level: 0.3 },
      );
      for (const p of w) this.house.segment(p, [p[0], WALL_H, p[2]], { color: C.dim, width: 0.9, glow: 1, level: 0.3 });
    }
    // Neighbouring houses (just outlines) with their own drops into the splitter.
    for (const n of NEIGHBOURS) {
      const sq: Vec3[] = [
        [n[0] - 2, 0, n[2] - 1.5],
        [n[0] + 2, 0, n[2] - 1.5],
        [n[0] + 2, 0, n[2] + 1.5],
        [n[0] - 2, 0, n[2] + 1.5],
        [n[0] - 2, 0, n[2] - 1.5],
      ];
      this.house.polyline(sq, { color: C.dim, width: 1, glow: 2, level: 0.8 });
    }
    // 1024-QAM: a 32 × 32 grid of possible symbol points, on a plane floating above the laptop.
    this.qam = new PointBatch(gfx, "lan-qam");
    for (let i = 0; i < 32; i++) {
      for (let j = 0; j < 32; j++) {
        this.qam.point(this.qamPoint(i, j), { color: C.link, px: 2, glow: 0.6, intensity: 0.35 });
      }
    }
  }

  private qamPoint(i: number, j: number): Vec3 {
    const s = 0.075;
    return [LAPTOP[0] - 1.2 + (i - 15.5) * s, 3.4 + (j - 15.5) * s, LAPTOP[2] - 0.4];
  }

  private label(id: string, pos: Vec3, text: string, opts: Partial<Label> = {}): void {
    this.out.push({ id, pos, text, kind: "note", ...opts });
  }

  private device(p: Vec3, size: Vec3, color: Rgb, lit: number): void {
    this.boxes.box(p, size, { edge: color, edgeIntensity: 0.45 + lit, edgePx: 1.4, fill: scaleRgb(color, 0.008) });
  }

  /** A radio burst: rings expanding from p, `t` 0..1 through it. */
  private burst(p: Vec3, t: number, color: Rgb, reach = 7, rings = 4): void {
    if (t <= 0 || t >= 1) return;
    for (let k = 0; k < rings; k++) {
      const r = (t * 1.6 - k * 0.18) * reach;
      if (r <= 0.05 || r > reach) continue;
      const fade = 1 - r / reach;
      this.lines.polyline(circle([p[0], 0.06, p[2]], r, 96), { color, width: 1.4, glow: 5, level: 1.6 * fade });
      // A faint upper ring hints at the wave being a shell, not a puddle.
      this.lines.polyline(circle([p[0], p[1] + r * 0.45, p[2]], r * 0.89, 96), {
        color,
        width: 1,
        glow: 3,
        level: 0.5 * fade,
      });
    }
  }

  /** A packet as a short bar of coloured segments: [colour, relative length][]. */
  private frame(at: Vec3, parts: [Rgb, number][], scramble = 0, time = 0): void {
    const total = parts.reduce((s, p) => s + p[1], 0);
    const w = 1.8;
    let x = at[0] - w / 2;
    for (const [i, [col, len]] of parts.entries()) {
      const l = (len / total) * w;
      const flicker = scramble > 0 && i > 0 ? 0.5 + 0.5 * Math.sin(time * 23 + i * 9.1) : 1;
      this.boxes.box([x + l / 2, at[1], at[2]], [l * 0.94, 0.16, 0.16], {
        edge: col,
        edgeIntensity: 1.3 * (1 - scramble * (1 - flicker)),
        edgePx: 1.2,
        fill: scaleRgb(col, 0.08),
      });
      x += l;
    }
  }

  update(f: SceneFrame): CameraPose {
    this.boxes.begin();
    this.lines.begin();
    this.points.begin();
    this.out = [];
    this.lines.time = f.time;
    this.qamOn = 0;
    const cam = fitNarrow(f.chapter === "wifi" ? this.wifi(f) : this.router(f), f);
    // Furniture the reader should recognise.
    this.label("laptop", [LAPTOP[0], LAPTOP[1] + 0.55, LAPTOP[2]], "laptop", {
      kind: "name",
      align: "center",
      color: CSS.user,
    });
    this.label("router", [ROUTER[0], ROUTER[1] + 0.65, ROUTER[2]], "router", {
      kind: "name",
      align: "center",
      color: CSS.hardware,
    });
    return cam;
  }

  anchor(name: string): CameraPose | null {
    // Close-ups for fly-throughs (story/flights.ts): the laptop's lid, where the antenna is; the trunk fiber.
    if (name === "laptop") return pose([LAPTOP[0], 0.75, LAPTOP[2] - 0.2], 1.4, -10, 22, 40);
    if (name === "fiber") return pose([26, 0.3, -6], 2.5, -14, 18, 40);
    return null;
  }

  private furniture(laptopLit: number, phoneLit: number, routerLit: number): void {
    this.device(LAPTOP, [0.9, 0.08, 0.6], C.user, laptopLit);
    this.device([LAPTOP[0], LAPTOP[1] + 0.28, LAPTOP[2] - 0.29], [0.9, 0.55, 0.04], C.user, laptopLit);
    this.device(PHONE, [0.22, 0.04, 0.42], C.city, phoneLit);
    this.device(TV, [1.8, 1.0, 0.08], C.dim, 0.1);
    this.device(SPEAKER, [0.3, 0.45, 0.3], C.dim, 0.1);
    this.device(ROUTER, [0.9, 0.22, 0.6], C.hardware, routerLit);
    for (const dx of [-0.3, 0.3]) {
      this.lines.segment(
        [ROUTER[0] + dx, ROUTER[1] + 0.1, ROUTER[2] - 0.25],
        [ROUTER[0] + dx, ROUTER[1] + 0.75, ROUTER[2] - 0.3],
        {
          color: C.hardware,
          width: 1.2,
          glow: 3,
          level: 0.5 + routerLit,
        },
      );
    }
    this.device(ONT, [0.2, 0.5, 0.36], C.hardware, 0.2);
  }

  // ---- wifi --------------------------------------------------------------------------------

  private wifi(f: SceneFrame): CameraPose {
    const b = f.beat;
    // b0: the Ethernet header becomes an 802.11 header; the payload is encrypted.
    const swap = ramp(b, -0.3, 0.1);
    const crypt = ramp(b, 0.15, 0.45);
    // b1: the phone talks first; the laptop waits out a random backoff.
    const phoneTx = seg(b, 0.55, 1.05);
    const backoff = seg(b, 1.05, 1.5);
    // b2: on the air, then the router's acknowledgement.
    const tx = seg(b, 1.55, 2.15);
    const ack = seg(b, 2.2, 2.45);

    this.furniture(
      0.3 + 0.6 * win(b, -0.5, -0.2, 2.1, 2.3),
      phoneTx > 0 && phoneTx < 1 ? 1 : 0.15,
      tx >= 1 ? 0.9 : 0.25,
    );

    // The frame, floating over the laptop until it's sent.
    if (tx <= 0.05) {
      const at: Vec3 = [LAPTOP[0], 1.6, LAPTOP[2]];
      const link: Rgb = mixRgb(C.link, scaleRgb(C.link, 1.4), swap);
      this.frame(
        at,
        [
          [link, 14 + swap * 18],
          [C.ip, 20],
          [C.icmp, 8],
          [C.payload, 56],
        ],
        crypt,
        f.time,
      );
      this.label("hdr", [at[0] - 0.9, at[1] + 0.32, at[2]], swap < 0.5 ? "Ethernet header" : "802.11 header", {
        kind: "mono",
        color: CSS.link,
        opacity: win(b, -0.5, -0.3, 0.6, 0.9),
      });
      this.label("aes", [at[0] + 0.5, at[1] - 0.34, at[2]], "encrypted (AES)", {
        kind: "mono",
        align: "center",
        opacity: win(b, 0.2, 0.4, 0.9, 1.2),
      });
    }

    // Listening: inward rings around the laptop while the channel is busy.
    if (phoneTx > 0 && backoff < 1) {
      const listen = (f.time * 1.2) % 1;
      this.lines.polyline(circle([LAPTOP[0], 0.06, LAPTOP[2]], 1.2 * (1 - listen), 48), {
        color: C.user,
        width: 1,
        glow: 3,
        level: 0.8 * listen,
      });
    }
    this.burst(PHONE, phoneTx, C.city, 9);
    this.label("phone", [PHONE[0], 0.9, PHONE[2]], "the phone goes first", {
      align: "center",
      opacity: win(b, 0.55, 0.7, 1.0, 1.15),
    });
    if (backoff > 0 && backoff < 1) {
      const slots = 5 - Math.floor(backoff * 5);
      this.label("backoff", [LAPTOP[0], 1.5, LAPTOP[2]], `backoff: ${slots} slot${slots === 1 ? "" : "s"}`, {
        kind: "mono",
        align: "center",
        color: CSS.user,
      });
    }

    // On the air.
    this.burst(LAPTOP, tx, C.out, 9, 5);
    if (tx > 0 && tx < 1) {
      const head = pointAt([LAPTOP, ROUTER], Math.min(1, tx * 1.4));
      this.points.point(head, { color: scaleRgb(C.out, 2), px: 6, glow: 2, intensity: 1.8 });
    }
    if (ack > 0 && ack < 1) this.burst(ROUTER, ack, C.back, 7, 2);
    this.label("ack", [ROUTER[0], 1.4, ROUTER[2]], "ACK", {
      kind: "mono",
      align: "center",
      color: CSS.back,
      opacity: win(b, 2.2, 2.3, 2.5, 2.6),
    });

    // The constellation: 1024 possible points, a few lighting as symbols go out.
    this.qamOn = win(b, 1.45, 1.7, 2.3, 2.5);
    if (this.qamOn > 0.01) {
      const n = 14;
      for (let k = 0; k < n; k++) {
        const on = tx * n * 1.2 - k;
        if (on < 0 || on > 3) continue;
        const i = (k * 13 + 7) % 32;
        const j = (k * 21 + 3) % 32;
        this.points.point(this.qamPoint(i, j), {
          color: scaleRgb(C.out, 2),
          px: 6,
          glow: 2,
          intensity: (1 - on / 3) * 2 * this.qamOn,
        });
      }
      this.label("qam", [LAPTOP[0] - 1.2, 4.75, LAPTOP[2] - 0.4], "1024-QAM: each point is 10 bits", {
        kind: "mono",
        align: "center",
        opacity: this.qamOn,
      });
    }

    return poseAt(
      [
        { at: -0.5, pose: pose([LAPTOP[0], 1.2, LAPTOP[2]], 4.2, -10, 22, 40) },
        { at: 0.4, pose: pose([LAPTOP[0] + 0.2, 1.3, LAPTOP[2]], 4.8, 8, 20, 40) },
        { at: 1.0, pose: pose([-1, 0.4, 0.3], 15, -8, 52, 40) },
        { at: 1.7, pose: pose([-1.6, 2.2, -1.3], 10, -18, 30, 40) },
        { at: 2.5, pose: pose([-0.6, 1.0, -1.2], 11, -6, 34, 40) },
      ],
      b,
    );
  }

  // ---- router ------------------------------------------------------------------------------

  private router(f: SceneFrame): CameraPose {
    const b = f.beat;
    const unwrap = ramp(b, -0.4, 0.1);
    const nat = ramp(b, 0.75, 1.15);
    const ttl = ramp(b, 1.15, 1.3);
    const toOnt = seg(b, 1.5, 1.75);
    const drop = seg(b, 1.75, 2.1);
    const trunk = seg(b, 2.25, 2.6);

    this.furniture(0.15, 0.1, 0.5 + 0.6 * win(b, -0.5, -0.3, 1.4, 1.6));

    // The packet at the router: the 802.11 header comes off, then the IP header is rewritten.
    const card: Vec3 = [ROUTER[0], 2.3, ROUTER[2]];
    if (toOnt <= 0.02) {
      this.frame(card, [
        [C.link, 32 * (1 - unwrap) + 0.001],
        [C.ip, 20],
        [C.icmp, 8],
        [C.payload, 56],
      ]);
      // The IP header, enlarged: 20 byte cells; source (12-15) and TTL (8) change.
      const natShow = win(b, 0.4, 0.7, 1.4, 1.6);
      if (natShow > 0.01) {
        for (let i = 0; i < 20; i++) {
          const src = i >= 12 && i <= 15;
          const isTtl = i === 8;
          const csum = i === 10 || i === 11;
          const changed = (src && nat > 0.5) || (isTtl && ttl > 0.5) || (csum && ttl > 0.5);
          const col = changed ? mixRgb(C.ip, C.back, 0.85) : C.ip;
          const flash = (src ? win(nat, 0.3, 0.5, 0.6, 1) : 0) + (isTtl || csum ? win(ttl, 0.2, 0.5, 0.6, 1) : 0);
          this.boxes.box(
            [card[0] - 1.9 + (i % 10) * 0.42, card[1] + 1.25 - Math.floor(i / 10) * 0.42, card[2]],
            [0.34, 0.34, 0.1],
            {
              edge: col,
              edgeIntensity: (0.7 + 1.5 * flash) * natShow,
              edgePx: 1.2,
              fill: scaleRgb(col, 0.05 * natShow),
            },
          );
        }
        this.label(
          "src",
          [card[0] - 0.01, card[1] + 0.5, card[2]],
          nat < 0.5 ? "source 192.168.1.23" : "source 203.0.113.7",
          {
            kind: "mono",
            color: nat < 0.5 ? CSS.ip : CSS.back,
            opacity: natShow,
          },
        );
        this.label("ttl", [card[0] - 1.9 + 8 * 0.42, card[1] + 1.65, card[2]], ttl < 0.5 ? "TTL 64" : "TTL 63", {
          kind: "mono",
          color: ttl < 0.5 ? CSS.ip : CSS.back,
          opacity: natShow,
        });
        this.label("table", [card[0] + 2.4, card[1] + 0.9, card[2]], "NAT: ICMP id 23582 ↔ 192.168.1.23", {
          kind: "mono",
          opacity: ramp(b, 0.9, 1.2) * natShow,
        });
      }
      this.label("wan", [card[0], card[1] - 0.45, card[2]], "to 172.253.124.113: not in the house → out", {
        kind: "mono",
        align: "center",
        opacity: win(b, -0.3, 0, 0.45, 0.65),
      });
    }

    // Router → ONT (the box on the wall), then light down the drop fiber to the street.
    const inside: Vec3[] = [
      [ROUTER[0] + 0.45, ROUTER[1], ROUTER[2]],
      [ONT[0] - 0.12, ONT[1], ONT[2]],
    ];
    this.lines.polyline(inside, {
      color: C.hardware,
      width: 1.2,
      glow: 3,
      level: 0.3,
      pulse: toOnt > 0 && toOnt < 1 ? { at: toOnt, trail: 0.5, intensity: 5 } : undefined,
    });
    this.lines.polyline(DROP, {
      color: C.out,
      width: 1.3,
      glow: 4,
      level: 0.12,
      pulse: drop > 0 && drop < 1 ? { at: drop, trail: 0.3, intensity: 5 } : undefined,
    });
    if (drop > 0 && drop < 1)
      this.points.point(pointAt(DROP, drop), { color: scaleRgb(C.out, 2), px: 6, glow: 2, intensity: 2 });
    this.label("ont", [ONT[0] + 0.3, ONT[1] + 0.55, ONT[2]], "fiber terminal", { opacity: ramp(b, 1.3, 1.6) });

    // The splitter at the street: neighbours share the fiber and take turns (time slots).
    this.boxes.box(SPLITTER, [1.0, 0.45, 0.7], {
      edge: C.hardware,
      edgeIntensity: 0.8,
      edgePx: 1.3,
      fill: scaleRgb(C.hardware, 0.01),
    });
    const slot = ramp(b, 1.9, 2.2);
    const cols: Rgb[] = [C.dns, C.tools, C.memory];
    for (const [k, n] of NEIGHBOURS.entries()) {
      const p = cubic(
        [n[0], 0.05, n[2] + (n[2] < SPLITTER[2] ? 1.5 : -1.5)],
        [n[0], 0.05, SPLITTER[2] + (n[2] < SPLITTER[2] ? -2 : 2)],
        [SPLITTER[0] + 1, 0.3, SPLITTER[2]],
        [SPLITTER[0] + (k - 1) * 0.2, 0.3, SPLITTER[2] + (n[2] < SPLITTER[2] ? -0.35 : 0.35)],
        24,
      );
      // Each neighbour's upstream burst lands in its own slot.
      const phase = (f.time * 0.6 + k / 4) % 1;
      this.lines.polyline(p, {
        color: cols[k] as Rgb,
        width: 1,
        glow: 3,
        level: 0.12,
        pulse: { at: phase, trail: 0.2, intensity: 2.5 * slot },
      });
    }
    this.lines.polyline(TRUNK, {
      color: C.out,
      width: 1.6,
      glow: 5,
      level: 0.15,
      flow: { period: 1.2, speed: 2.4, duty: 0.12, intensity: 1.6 * slot },
      pulse: trunk > 0 && trunk < 1 ? { at: trunk, trail: 0.15, intensity: 6 } : undefined,
    });
    this.label("splitter", [SPLITTER[0], SPLITTER[1] + 0.7, SPLITTER[2]], "splitter: one fiber, many homes", {
      kind: "name",
      align: "center",
      opacity: ramp(b, 1.85, 2.15),
    });
    this.label("slots", [SPLITTER[0] + 6, 0.9, SPLITTER[2]], "upstream in turns: each home gets time slots", {
      align: "center",
      opacity: ramp(b, 2.0, 2.3),
    });
    this.label("light", [24, 0.8, SPLITTER[2]], "light in glass: ~200 km per millisecond", {
      kind: "mono",
      align: "center",
      color: CSS.out,
      opacity: ramp(b, 2.3, 2.5),
    });

    return poseAt(
      [
        { at: -0.5, pose: pose([ROUTER[0], 1.6, ROUTER[2]], 6.5, -4, 18, 40) },
        { at: 1.0, pose: pose([ROUTER[0] + 0.4, 2.6, ROUTER[2]], 7.5, 6, 14, 40) },
        { at: 1.65, pose: pose([5.5, 0.6, -2.5], 9, -40, 30, 40) },
        { at: 2.2, pose: pose([12, 0.4, -6], 15, -30, 34, 40) },
        { at: 2.5, pose: pose([19, 0.4, -6], 15, -14, 18, 40) },
      ],
      b,
    );
  }

  draw(pass: GPURenderPassEncoder): void {
    this.boxes.draw(pass);
    this.house.draw(pass);
    if (this.qamOn > 0.01) {
      this.qam.opacity = this.qamOn;
      this.qam.draw(pass);
    }
    this.lines.draw(pass);
    this.points.draw(pass);
  }

  labels(out: Label[]): void {
    out.push(...this.out);
  }
}

const factory: SceneFactory = (gfx) => new LanScene(gfx);
export default factory;
