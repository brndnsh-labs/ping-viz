// The far end of the network. Act I: Google's edge answers the ping (ECMP, load balancers, a front
// end that flips one byte). Act II: Anthropic's API front door (TLS ends, who's asking, where to
// run it). Same set, different traffic.
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

const LANES = 8;
const laneZ = (i: number): number => (i - (LANES - 1) / 2) * 1.05;

const ROUTER: Vec3 = [-7.5, 0.6, 0];
const LB_X = -2.4;
const SERVERS = { x0: 1.6, cols: 6, rows: 8, dx: 1.25, dz: 1.0 };
const serverAt = (c: number, r: number): Vec3 => [
  SERVERS.x0 + c * SERVERS.dx,
  0.5,
  (r - (SERVERS.rows - 1) / 2) * SERVERS.dz,
];

// Which lane and server the hashes pick (any fixed choice reads the same).
const LANE = 5;
const TARGET = { c: 3, r: 2 };

// Act II: gates and deployments.
const GATE_X = [-3.2, 0.2];
const DEPLOY = [-3, -1.5, 0, 1.5, 3].map((z, i) => ({ z, i }));
const DEPLOY_X = 6.2;
const CHOSEN = 3;

function path(points: Vec3[]): Vec3[] {
  return filleted(points, 0.6, 6);
}

class EdgeScene implements Scene {
  readonly id = "edge" as const;
  private readonly solid: BoxBatch;
  private readonly lines: LineBatch;
  private readonly points: PointBatch;
  private readonly floor: LineBatch;
  private out: Label[] = [];
  private act1 = true;
  private beat = 0;
  private reply: Vec3 = [-9, 1, -0.7];

  constructor(gfx: Gfx) {
    this.solid = new BoxBatch(gfx, "edge-boxes");
    this.lines = new LineBatch(gfx, "edge-lines");
    this.points = new PointBatch(gfx, "edge-points");
    this.floor = new LineBatch(gfx, "edge-floor");
    // A faint floor grid gives the site some ground.
    for (let x = -10; x <= 10; x += 1) {
      this.floor.segment([x, 0, -6], [x, 0, 6], {
        color: C.dim,
        width: 0.7,
        glow: 0,
        level: x % 5 === 0 ? 0.35 : 0.16,
      });
    }
    for (let z = -6; z <= 6; z += 1) {
      this.floor.segment([-10, 0, z], [10, 0, z], {
        color: C.dim,
        width: 0.7,
        glow: 0,
        level: z % 5 === 0 ? 0.35 : 0.16,
      });
    }
  }

  update(f: SceneFrame): CameraPose {
    this.solid.begin();
    this.lines.begin();
    this.points.begin();
    this.out = [];
    this.lines.time = f.time;
    this.floor.time = f.time;
    this.act1 = f.chapter === "google";
    this.beat = f.beat;
    return fitNarrow(f.chapter === "google" ? this.google(f) : this.frontdoor(f), f);
  }

  anchor(name: string): CameraPose | null {
    // Close-ups for fly-throughs (story/flights.ts): packets arriving at the edge router, the reply
    // leaving along its path home (Act I, end), the deployment the request is routed to.
    if (name === "entry") {
      if (this.act1 && this.beat > 1) return pose(this.reply, 3, -28, 30, 40);
      return this.act1 ? pose(ROUTER, 3, -60, 24, 40) : pose(ROUTER, 3, -72, 18, 40);
    }
    if (name === "backend") return pose([DEPLOY_X + 0.75, 0.9, DEPLOY[CHOSEN]?.z ?? 0], 4, -24, 30, 40);
    return null;
  }

  private label(id: string, pos: Vec3, text: string, opts: Partial<Label> = {}): void {
    this.out.push({ id, pos, text, kind: "note", ...opts });
  }

  private router(color: Rgb, lit: number): void {
    this.solid.box(ROUTER, [1.6, 1.2, 2.2], {
      edge: color,
      edgeIntensity: 0.6 + lit,
      edgePx: 1.6,
      fill: scaleRgb(color, 0.008),
    });
  }

  private head(p: Vec3, color: Rgb, k = 1): void {
    this.points.point(p, { color: scaleRgb(color, 2.2), px: 7 * k, glow: 2.4, intensity: 2 });
  }

  // ---- Act I -------------------------------------------------------------------------------

  private google(f: SceneFrame): CameraPose {
    const b = f.beat;
    const arrive = seg(b, -0.5, -0.05);
    const fan = ramp(b, -0.2, 0.25);
    const toLb = seg(b, 0.1, 0.6);
    const toServer = seg(b, 0.7, 1.4);
    const flip = ramp(b, 1.7, 2.0);
    const back = seg(b, 2.0, 2.55);

    // Backbone in from the left.
    const inbound: Vec3[] = [[-13, 0.6, 0], ROUTER];
    this.lines.polyline(inbound, {
      color: C.out,
      width: 1.6,
      glow: 5,
      level: 0.15,
      pulse: arrive < 1 ? { at: arrive, trail: 0.4, intensity: 5 } : undefined,
    });
    if (arrive > 0 && arrive < 1) this.head(pointAt(inbound, arrive), C.out);
    this.router(C.google, arrive >= 1 ? 0.6 : 0.2);
    this.label("router", [ROUTER[0], 1.6, ROUTER[2]], "edge router", {
      kind: "name",
      align: "center",
      color: CSS.muted,
    });

    // ECMP: equal paths to the load balancer layer; the hash picks one.
    for (let i = 0; i < LANES; i++) {
      const z = laneZ(i);
      const lane = path([ROUTER, [-5.6, 0.6, z * 0.4], [-4.4, 0.6, z], [LB_X, 0.6, z]]);
      const chosen = i === LANE;
      this.lines.polyline(lane, {
        color: chosen ? C.out : C.google,
        width: chosen ? 1.6 : 1,
        glow: chosen ? 5 : 2,
        level: (chosen ? 0.25 : 0.08) * fan,
        pulse: chosen && toLb > 0 && toLb < 1 ? { at: toLb, trail: 0.5, intensity: 5 } : undefined,
      });
      if (chosen && toLb > 0 && toLb < 1) this.head(pointAt(lane, toLb), C.out);
      // Load balancers.
      const lit = chosen ? ramp(b, 0.55, 0.7) * (1 - ramp(b, 1.4, 1.8)) : 0;
      this.solid.box([LB_X, 0.45, z], [0.9, 0.9, 0.8], {
        edge: mixRgb(C.google, C.out, lit),
        edgeIntensity: 0.35 + 0.35 * fan + lit,
        edgePx: 1.3,
        fill: scaleRgb(C.google, 0.006),
      });
    }
    this.label("ecmp", [-5.2, 1.4, laneZ(LANES - 1) + 0.6], "equal-cost paths: hash picks one", {
      opacity: win(b, -0.3, 0.0, 0.8, 1.1),
    });
    this.label("lb", [LB_X, 1.45, laneZ(0) - 0.7], "load balancers (Maglev, for web traffic)", {
      kind: "name",
      align: "center",
      opacity: ramp(b, 0.3, 0.7),
      color: CSS.muted,
    });

    // Front-end servers.
    for (let c = 0; c < SERVERS.cols; c++) {
      for (let r = 0; r < SERVERS.rows; r++) {
        const hit = c === TARGET.c && r === TARGET.r;
        const lit = hit ? ramp(b, 1.3, 1.45) : 0;
        const col = hit ? mixRgb(mixRgb(C.google, C.out, lit), C.back, flip) : C.google;
        this.solid.box(serverAt(c, r), [0.85, 1.0, 0.7], {
          edge: col,
          edgeIntensity: 0.22 + (hit ? lit * 1.4 : 0),
          edgePx: 1.1,
          fill: scaleRgb(C.google, hit ? 0.05 * lit : 0.005),
        });
      }
    }
    this.label("fe", [SERVERS.x0 + SERVERS.dx * 2.5, 1.55, (SERVERS.rows / 2 + 0.3) * SERVERS.dz], "front ends", {
      kind: "name",
      align: "center",
      color: CSS.muted,
    });

    // LB → the answering server.
    const target = serverAt(TARGET.c, TARGET.r);
    const lbOut: Vec3 = [LB_X, 0.6, laneZ(LANE)];
    const toS = cubic(lbOut, [0, 1.6, laneZ(LANE)], [target[0] - 1.6, 1.8, target[2]], [target[0], 1.0, target[2]], 30);
    this.lines.polyline(toS, {
      color: C.out,
      width: 1.5,
      glow: 5,
      level: 0.2 * ramp(b, 0.65, 0.8) * (1 - flip),
      pulse: toServer > 0 && toServer < 1 ? { at: toServer, trail: 0.4, intensity: 5 } : undefined,
    });
    if (toServer > 0 && toServer < 1) this.head(pointAt(toS, toServer), C.out);
    this.label("answer", [target[0], 1.9, target[2]], "answers for 172.253.124.113", {
      kind: "mono",
      align: "center",
      opacity: win(b, 1.3, 1.5, 2.3, 2.6),
      color: CSS.out,
    });

    // The flip: type 8 → 0, a burst, then the reply heads home on a direct path.
    if (flip > 0 && flip < 1) {
      const ring = circle([target[0], 1.0, target[2]], 0.3 + flip * 1.6, 48);
      this.lines.polyline(ring, { color: C.back, width: 1.4, glow: 6, level: 1.6 * (1 - flip) });
    }
    this.label("flip", [target[0] + 0.2, 2.6, target[2]], "type 8 → 0, addresses swapped", {
      kind: "mono",
      align: "center",
      opacity: win(b, 1.75, 1.95, 2.5, 2.8),
      color: CSS.back,
    });
    const home: Vec3[] = cubic(
      [target[0], 1.0, target[2]],
      [target[0] - 2, 2.6, target[2] - 1],
      [-5, 2.2, -1.5],
      [-13, 0.9, -0.6],
      48,
    );
    this.lines.polyline(home, {
      color: C.back,
      width: 1.6,
      glow: 5,
      level: 0.12 * ramp(b, 2.0, 2.1),
      pulse: back > 0 && back < 1 ? { at: back, trail: 0.35, intensity: 5 } : undefined,
    });
    if (back > 0 && back < 1) this.head(pointAt(home, back), C.back);
    this.reply = pointAt(home, 0.8);

    return poseAt(
      [
        { at: -0.5, pose: pose([-6, 0.6, 0], 9, -60, 24, 40) },
        { at: 0.35, pose: pose([-4.2, 0.4, 0], 12, -38, 34, 40) },
        { at: 1.2, pose: pose([1.0, 0.4, 0], 14, -22, 38, 40) },
        { at: 1.9, pose: pose([target[0], 0.8, target[2]], 8, -14, 30, 40) },
        { at: 2.5, pose: pose([0, 0.6, 0], 17, -28, 30, 40) },
      ],
      b,
    );
  }

  // ---- Act II ------------------------------------------------------------------------------

  private frontdoor(f: SceneFrame): CameraPose {
    const b = f.beat;
    // b0: many packets arrive, TLS ends: they merge into one request.
    const arrive = seg(b, -0.5, 0.15);
    const merged = ramp(b, 0.05, 0.3);
    const gate1 = seg(b, 0.6, 1.0);
    const gate2 = seg(b, 1.0, 1.4);
    const route = seg(b, 1.7, 2.3);

    this.router(C.claude, arrive >= 1 ? 0.5 : 0.2);
    this.label("router", [ROUTER[0], 1.6, ROUTER[2]], "Cloudflare: TLS ends here", {
      kind: "name",
      align: "center",
      color: CSS.claude,
      opacity: ramp(b, -0.3, 0.1),
    });

    // Inbound: a stream of ~70 packets (the request body).
    const inbound: Vec3[] = [[-14, 0.6, 0], ROUTER];
    this.lines.polyline(inbound, { color: C.out, width: 1.2, glow: 4, level: 0.12 });
    for (let k = 0; k < 70; k++) {
      const x = arrive * 1.6 - (k / 70) * 0.6;
      if (x <= 0 || x >= 1) continue;
      this.points.point(pointAt(inbound, x), { color: scaleRgb(C.out, 1.6), px: 3.2, glow: 1.4, intensity: 1.3 });
    }

    // The request as one object after TLS: a bright capsule moving right through the gates.
    const track: Vec3[] = [ROUTER, [GATE_X[0] as number, 0.6, 0], [GATE_X[1] as number, 0.6, 0], [3.8, 0.6, 0]];
    const along = merged <= 0 ? 0 : 0.02 + 0.3 * gate1 + 0.36 * gate2 + 0.32 * ramp(b, 1.4, 1.7);
    this.lines.polyline(track, { color: C.claude, width: 1.2, glow: 4, level: 0.1 * merged });
    const req = pointAt(track, along);
    if (merged > 0 && route < 1) {
      this.solid.box(req, [0.9, 0.5, 0.5], {
        edge: C.claude,
        edgeIntensity: 1.6 * merged,
        edgePx: 1.6,
        fill: scaleRgb(C.claude, 0.12 * merged),
      });
      this.label("req", [req[0], 1.25, req[2]], "POST /v1/messages", {
        kind: "mono",
        align: "center",
        opacity: merged * (1 - ramp(b, 1.6, 1.9)),
        color: CSS.claude,
      });
    }

    // Gates: who's asking, and are they within their limits.
    const gates: [number, string, number][] = [
      [GATE_X[0] as number, "credential checked", gate1],
      [GATE_X[1] as number, "rate limits, usage", gate2],
    ];
    for (const [i, [x, text, k]] of gates.entries()) {
      const pass = k >= 1 ? 1 : 0;
      const col = mixRgb(C.google, C.back, pass);
      this.lines.polyline(circle([x, 0.6, 0], 1.0, 64, [0, 1, 0], [0, 0, 1]), {
        color: col,
        width: 1.6,
        glow: 6,
        level: 0.35 + 1.2 * win(k, 0.3, 0.6, 1, 1.2) + 0.4 * pass,
      });
      this.label(`gate${i}`, [x, 1.95, 0], text, {
        kind: "name",
        align: "center",
        opacity: ramp(b, 0.4 + i * 0.4, 0.7 + i * 0.4),
      });
    }

    // Deployments of the model, each a block of servers; the router picks one with room.
    for (const d of DEPLOY) {
      const chosen = d.i === CHOSEN;
      const lit = chosen ? ramp(b, 2.1, 2.35) : 0;
      for (let k = 0; k < 6; k++) {
        const c = k % 3;
        const r = Math.floor(k / 3);
        this.solid.box([DEPLOY_X + c * 0.75, 0.45 + r * 0.95, d.z], [0.6, 0.8, 1.0], {
          edge: mixRgb(C.dim, C.claude, 0.35 + 0.65 * lit),
          edgeIntensity: 0.45 + lit * 1.2,
          edgePx: 1.1,
          fill: scaleRgb(C.claude, chosen ? 0.04 * lit : 0.005),
        });
      }
      const p = path([
        [3.8, 0.6, 0],
        [4.8, 0.6, d.z * 0.6],
        [5.6, 0.6, d.z],
        [DEPLOY_X - 0.4, 0.6, d.z],
      ]);
      this.lines.polyline(p, {
        color: chosen ? C.claude : C.dim,
        width: chosen ? 1.5 : 1,
        glow: chosen ? 5 : 2,
        level: (chosen ? 0.3 : 0.12) * ramp(b, 1.5, 1.8),
        pulse: chosen && route > 0 && route < 1 ? { at: route, trail: 0.5, intensity: 5 } : undefined,
      });
      if (chosen && route > 0 && route < 1) this.head(pointAt(p, route), C.claude);
      // A short queue at each deployment: some busy, the chosen one has room.
      const queued = chosen ? 1 : 3 + ((d.i * 7) % 4);
      for (let q = 0; q < queued; q++) {
        this.points.point([DEPLOY_X - 0.9 - q * 0.32, 0.6, d.z], {
          color: C.out,
          px: 4,
          glow: 1.2,
          intensity: ramp(b, 1.5, 1.9) * 0.9,
        });
      }
    }
    this.label("deploy", [DEPLOY_X + 0.75, 2.4, DEPLOY[CHOSEN]?.z ?? 0], "a deployment with room", {
      kind: "name",
      align: "center",
      opacity: ramp(b, 1.7, 2.1),
      color: CSS.claude,
    });
    this.label("queues", [DEPLOY_X - 1.6, 1.3, DEPLOY[0]?.z ?? 0], "queues", { opacity: ramp(b, 1.6, 2.0) });

    return poseAt(
      [
        { at: -0.5, pose: pose([-7, 0.6, 0], 9, -72, 18, 40) },
        { at: 0.6, pose: pose([-2.6, 0.6, 0], 11, -50, 22, 40) },
        { at: 1.5, pose: pose([1.2, 0.6, 0], 12, -36, 26, 40) },
        { at: 2.5, pose: pose([4.2, 0.6, 0], 15, -24, 34, 40) },
      ],
      b,
    );
  }

  draw(pass: GPURenderPassEncoder): void {
    this.solid.draw(pass);
    this.floor.draw(pass);
    this.lines.draw(pass);
    this.points.draw(pass);
  }

  labels(out: Label[]): void {
    out.push(...this.out);
  }
}

const factory: SceneFactory = (gfx) => new EdgeScene(gfx);
export default factory;
