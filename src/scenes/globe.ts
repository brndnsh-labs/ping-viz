// The planet: a dot-matrix Earth for every chapter that happens between buildings.
//
// Act I: DNS (about 2,000 root server instances, then the queries that actually happen, which stay
// close to home because of anycast), the trip to Google over the ISP's network, and the reply.
// Act II: the request to the API, the token stream coming back, and everyone else doing the same.
import { C, CSS, scaleRgb } from "../config";
import { arc, landDots, ll } from "../geo/geo";
import { METROS, P, type Place } from "../geo/places";
import { type CameraPose, eyeOf, fitNarrow, type PoseKey, pose, poseAt } from "../render/camera";
import type { Gfx, Rgb } from "../render/gfx";
import { LineBatch } from "../render/lines";
import { PointBatch } from "../render/points";
import { pathLength, pointAt } from "../render/shapes";
import { SphereBatch } from "../render/spheres";
import { piecewise, ramp, seg, smooth, window as win } from "../util/ease";
import { DEG, length, type Vec3 } from "../util/math";
import type { Label, Scene, SceneFactory, SceneFrame } from "./scene";

const SURFACE = 1.0015;

/** Deterministic pseudo-random numbers for scattering (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = (p: Place, r = SURFACE): Vec3 => ll(p.lat, p.lon, r);
const pl = (p: Place): [number, number] => [p.lat, p.lon];

/** A multi-hop path along the surface: one polyline, plus where each hop sits along it (0..1). */
interface Route {
  points: Vec3[];
  marks: number[];
  length: number;
}

function route(stops: Place[], lift = 0.006): Route {
  const points: Vec3[] = [];
  const lens: number[] = [0];
  for (let i = 1; i < stops.length; i++) {
    const seg = arc(pl(stops[i - 1] as Place), pl(stops[i] as Place), 20, lift, SURFACE);
    if (i > 1) seg.shift();
    points.push(...seg);
    lens.push(pathLength(points));
  }
  const length = pathLength(points);
  return { points, marks: lens.map((l) => l / length), length };
}

// Act I's illustrative route, and a different way back (paths needn't be symmetric).
const OUT = route([P.home, P.ispHub, P.charlotte, P.atlanta, P.googleAtl]);
const BACK = route([P.googleAtl, P.atlanta, P.greenville, P.ispHub, P.home]);

// DNS: the ISP's recursive resolver (Charlotte) asks anycast servers that are all, as it happens,
// close by. The query leaves home for the resolver first.
const RESOLVER = P.charlotte;
const ROOT_NEAR: Place = { name: "a root server", lat: 33.76, lon: -84.4 };
const TLD_NEAR: Place = { name: "a .com server", lat: 33.65, lon: -84.2 };
const GNS_NEAR: Place = { name: "ns1.google.com", lat: 33.85, lon: -84.5 };

// Act II: the API's front door and a datacenter. Both locations are illustrative.
const API: Place = { name: "api.anthropic.com", lat: 39.0, lon: -77.4 };
const DC: Place = { name: "a datacenter", lat: 41.7, lon: -86.5 };
const WIRE = route([P.home, P.ispHub, P.charlotte, API], 0.03);
const STREAM = route([DC, API, P.charlotte, P.ispHub, P.home], 0.03);

/** Close enough that the ~500 km route fills the frame. */
const ROUTE_VIEW: CameraPose = pose(ll(34.55, -82.6, 1), 0.16, -82.6, 34.55 - 40, 38);
const ATL_VIEW: CameraPose = pose(ll(34.0, -83.6, 1), 0.13, -83.6, 34.0 - 42, 38);
const CONTINENT: CameraPose = pose([0, 0, 0], 2.15, -88, 32, 40);
const WORLD: CameraPose = pose([0, 0, 0], 3.1, -70, 24, 40);
const EAST: CameraPose = pose(ll(37.5, -82, 1), 0.85, -82, 37.5 - 26, 40);

class GlobeScene implements Scene {
  readonly id = "globe" as const;
  private readonly earth: SphereBatch;
  private readonly land: PointBatch;
  private readonly fine: PointBatch;
  private readonly metros: PointBatch;
  private readonly roots: PointBatch;
  private readonly googleNet: LineBatch;
  private readonly users: LineBatch;
  private readonly lines: LineBatch;
  private readonly points: PointBatch;
  private out: Label[] = [];
  private rootsOn = 0;
  private googleOn = 0;
  private usersOn = 0;
  private fineOn = 0;

  constructor(gfx: Gfx) {
    this.earth = new SphereBatch(gfx, "globe-earth");
    this.earth.sphere([0, 0, 0], 1, {
      fill: [0.005, 0.008, 0.018],
      rim: [0.1, 0.22, 0.5],
      rimPower: 4,
      halo: [0.06, 0.16, 0.45],
      haloWidth: 0.07,
    });

    this.land = new PointBatch(gfx, "globe-land");
    for (const d of landDots(0.3)) {
      this.land.point(ll(d.lat, d.lon, 1.001), { color: C.land, size: 0.0028, minPx: 1, glow: 0.35, intensity: 0.42 });
    }
    this.land.maxPx = 2.6;
    // Denser dots around the route, faded in for the close-up shots.
    this.fine = new PointBatch(gfx, "globe-fine");
    for (const d of landDots(0.1, [31.0, -89.0, 39.0, -76.5])) {
      const fall = Math.hypot((d.lat - 35) / 3.8, (d.lon + 82.6) / 6.0);
      if (fall > 1) continue;
      this.fine.point(ll(d.lat, d.lon, 1.0011), {
        color: C.land,
        size: 0.001,
        minPx: 0.9,
        glow: 0.3,
        intensity: 0.32 * (1 - smooth(Math.max(0, (fall - 0.45) / 0.55))),
      });
    }
    this.fine.maxPx = 2;

    this.metros = new PointBatch(gfx, "globe-metros");
    for (const [, lat, lon, w] of METROS) {
      this.metros.point(ll(lat, lon, 1.002), {
        color: [1, 0.85, 0.6],
        size: 0.006 + w * 0.0006,
        minPx: 1.5,
        glow: 1.4,
        intensity: 0.6,
      });
    }
    this.metros.maxPx = 5;

    // About 2,000 root server instances (root-servers.org listed 2,016 in March 2026), scattered
    // around metros by weight. Positions are a picture, not a map of the real sites.
    this.roots = new PointBatch(
      gfx,
      "globe-roots",
      {},
      {
        key: "roots",
        wgsl: `fn getPoint(i: u32) -> PointInst {
  var p = pts[i];
  let tw = 0.55 + 0.45 * sin(batch.misc.y * (1.3 + hash1(i) * 2.0) + hash1(i ^ 7u) * 6.2832);
  p.color.a *= tw;
  return p;
}`,
      },
    );
    const r = rng(7);
    const total = METROS.reduce((s, m) => s + m[3], 0);
    for (const [, lat, lon, w] of METROS) {
      const n = Math.round((w / total) * 2016);
      for (let k = 0; k < n; k++) {
        const a = r() * Math.PI * 2;
        const d = Math.sqrt(-2 * Math.log(Math.max(1e-6, r()))) * 1.6;
        const la = lat + Math.sin(a) * d;
        const lo = lon + (Math.cos(a) * d) / Math.max(0.3, Math.cos(lat * DEG));
        this.roots.point(ll(la, lo, 1.003), { color: C.dns, size: 0.0045, minPx: 1.6, glow: 1.2, intensity: 1.2 });
      }
    }
    this.roots.procedural = this.roots.count;
    this.roots.maxPx = 4;

    // Google's network: a backbone between big metros (illustrative).
    this.googleNet = new LineBatch(gfx, "globe-google");
    const gsites = METROS.filter((m) => m[3] >= 4);
    const edges = new Set<string>();
    for (const [i, a] of gsites.entries()) {
      const near = gsites
        .map((b, j) => ({ b, j, d: Math.hypot(b[1] - a[1], (b[2] - a[2]) * Math.cos(a[1] * DEG)) }))
        .filter((x) => x.j !== i)
        .sort((x, y) => x.d - y.d)
        .slice(0, 3);
      for (const { b, j } of near) {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (edges.has(key)) continue;
        edges.add(key);
        this.googleNet.polyline(arc([a[1], a[2]], [b[1], b[2]], 40, -0.1, 1.003), {
          color: C.google,
          width: 1,
          glow: 3,
          level: 0.25,
          flow: { period: 0.05, speed: 0.04, duty: 0.2, intensity: 1.2 },
        });
      }
    }

    // Everyone else (finale): arcs from scattered users to a few datacenter regions.
    this.users = new LineBatch(gfx, "globe-users");
    const dcs: [number, number][] = [
      [41.7, -86.5],
      [33.4, -84.7],
      [45.6, -121.2],
      [32.8, -96.8],
      [39.0, -77.5],
      [50.1, 8.7],
      [53.3, -6.3],
      [1.35, 103.8],
      [35.7, 139.7],
      [-33.9, 151.2],
      [-23.5, -46.6],
    ];
    const ur = rng(11);
    for (let k = 0; k < 520; k++) {
      let pick = ur() * total;
      let m = METROS[0] as (typeof METROS)[number];
      for (const x of METROS) {
        pick -= x[3];
        if (pick <= 0) {
          m = x;
          break;
        }
      }
      const la = m[1] + (ur() - 0.5) * 6;
      const lo = m[2] + (ur() - 0.5) * 8;
      const dc = dcs.reduce((best, d) =>
        Math.hypot(d[0] - la, (d[1] - lo) * 0.7) < Math.hypot(best[0] - la, (best[1] - lo) * 0.7) ? d : best,
      );
      this.users.polyline(arc([la, lo], dc, 28, -0.16, 1.002), {
        color: k % 3 === 0 ? C.claude : C.out,
        width: 0.9,
        glow: 3,
        level: 0.08,
        flow: { period: 0.12 + ur() * 0.1, speed: 0.08 + ur() * 0.05, duty: 0.12, intensity: 2.2 },
      });
    }

    this.lines = new LineBatch(gfx, "globe-lines");
    this.points = new PointBatch(gfx, "globe-points");
  }

  update(f: SceneFrame): CameraPose {
    this.lines.begin();
    this.points.begin();
    this.out = [];
    this.rootsOn = 0;
    this.googleOn = 0;
    this.usersOn = 0;
    this.fineOn = 0;
    const b = f.beat;
    let cam: CameraPose;
    switch (f.chapter) {
      case "intro":
        cam = this.intro(f);
        break;
      case "dns":
        cam = this.dns(b, f);
        break;
      case "internet":
        cam = this.internet(b, f);
        break;
      case "return":
        cam = this.returnTrip(b, f);
        break;
      case "wire":
        cam = this.wire(b, f);
        break;
      case "stream":
        cam = this.stream(b, f);
        break;
      default:
        cam = this.finale(f);
    }
    // Phones: pull back so the route, and the planet, fit the width above the text.
    cam = fitNarrow(cam, f);
    // The fine dots are for close-ups. From higher up they read as a lighter patch with edges, and the
    // ordinary dots are dense enough anyway, so they also fade with altitude.
    this.fineOn *= 1 - ramp(length(eyeOf(cam)) - 1, 0.25, 0.5);
    this.roots.time = f.time;
    this.googleNet.time = f.time;
    this.users.time = f.time;
    this.lines.time = f.time;
    return cam;
  }

  // ---- shared pieces -----------------------------------------------------------------------

  private node(p: Place, color: Rgb, k = 1, px = 6): void {
    this.points.point(at(p, 1.003), { color, px: px * (0.75 + 0.5 * k), glow: 1.8, intensity: 0.5 + 1.5 * k });
  }

  private label(id: string, p: Place | Vec3, text: string, opts: Partial<Label> = {}): void {
    const pos = Array.isArray(p) ? (p as Vec3) : at(p as Place, 1.004);
    this.out.push({ id, pos, text, kind: "note", ...opts });
  }

  /** A packet riding a route: a lit trail on the path and a bright head. */
  private packet(r: Route, t: number, color: Rgb, opts: { trail?: number; base?: number; width?: number } = {}): void {
    this.lines.polyline(r.points, {
      color,
      width: opts.width ?? 1.6,
      glow: 5,
      level: opts.base ?? 0.12,
      pulse:
        t > 0 && t < 1.02 ? { at: Math.min(t, 1), trail: opts.trail ?? 0.18, intensity: 5, flare: 2.5 } : undefined,
    });
    if (t > 0 && t < 1) {
      this.points.point(pointAt(r.points, t), { color: scaleRgb(color, 2.2), px: 6, glow: 2.5, intensity: 2 });
    }
  }

  /** A query (out and back) between two places: goes during [t0, t1], answers during [t1, t2]. */
  private exchange(id: string, a: Place, b: Place, x: number, t0: number, t1: number, t2: number, color: Rgb): void {
    const there = arc(pl(a), pl(b), 24, -0.18, SURFACE);
    const back = [...there].reverse();
    const go = seg(x, t0, t1);
    const ret = seg(x, t1, t2);
    const shown = win(x, t0 - 0.15, t0, t2, t2 + 0.6);
    if (shown <= 0) return;
    this.lines.polyline(there, {
      color,
      width: 1.3,
      glow: 4,
      level: 0.12 * shown,
      pulse: go > 0 && go < 1 ? { at: go, trail: 0.35, intensity: 5, flare: 2 } : undefined,
    });
    if (ret > 0 && ret < 1) {
      this.lines.polyline(back, {
        color: C.back,
        width: 1.3,
        glow: 4,
        level: 0,
        pulse: { at: ret, trail: 0.35, intensity: 5, flare: 2 },
      });
    }
    if (go > 0 && go < 1)
      this.points.point(pointAt(there, go), { color: scaleRgb(color, 2), px: 5, glow: 2, intensity: 2 });
    if (ret > 0 && ret < 1)
      this.points.point(pointAt(back, ret), { color: scaleRgb(C.back, 2), px: 5, glow: 2, intensity: 2 });
    this.node(b, color, go >= 1 ? 1 - ret * 0.5 : 0.3);
    void id;
  }

  // ---- chapters ----------------------------------------------------------------------------

  private intro(f: SceneFrame): CameraPose {
    // A single ping going back and forth, on a loop, while the planet turns.
    const t = (f.time * 0.22) % 1;
    const go = seg(t, 0.05, 0.45);
    const back = seg(t, 0.55, 0.95);
    this.packet(OUT, go, C.out, { base: 0.06 });
    if (back > 0) this.packet(BACK, back, C.back, { base: 0 });
    this.node(P.home, C.city, 0.6);
    this.node(P.googleAtl, C.city, 0.4);
    const spin = f.reducedMotion ? 0 : f.time * 1.2;
    return pose([0, 0, 0], 3.0 - f.p * 0.25, -80 + spin, 22 + f.p * 6, 40);
  }

  private dns(b: number, f: SceneFrame): CameraPose {
    // b0 ask the local resolver, b1 the root, b2 .com, b3 google.com's own servers, answer.
    this.fineOn = 1 - win(b, 0.4, 0.75, 1.25, 1.6);
    this.rootsOn = win(b, 0.35, 0.8, 1.3, 1.75) * 1 + ramp(b, 1.6, 2.2) * 0.25;
    this.node(P.home, C.city, 0.8);
    this.label("home", P.home, "you", { kind: "name", color: CSS.out, dx: 6 });
    // home → resolver (and the final answer back)
    this.exchange("res", P.home, RESOLVER, b, -0.3, 0.2, 3.2, C.dns);
    this.label("resolver", RESOLVER, "your ISP's resolver", { color: CSS.dns, opacity: ramp(b, -0.2, 0.2) });
    this.exchange("root", RESOLVER, ROOT_NEAR, b, 1.0, 1.25, 1.5, C.dns);
    this.label("root", ROOT_NEAR, "root: try .com's servers", {
      kind: "mono",
      align: "right",
      opacity: win(b, 1.1, 1.3, 1.6, 1.9),
      color: CSS.dns,
    });
    this.exchange("tld", RESOLVER, TLD_NEAR, b, 1.75, 2.0, 2.25, C.dns);
    this.label("tld", TLD_NEAR, ".com: ask ns1.google.com", {
      kind: "mono",
      align: "right",
      dy: 16,
      opacity: win(b, 1.85, 2.05, 2.35, 2.6),
      color: CSS.dns,
    });
    this.exchange("gns", RESOLVER, GNS_NEAR, b, 2.5, 2.75, 3.0, C.dns);
    this.label("gns", GNS_NEAR, "google.com: 172.253.124.113", {
      kind: "mono",
      align: "right",
      dy: -16,
      opacity: win(b, 2.6, 2.85, 3.3, 3.6),
      color: CSS.back,
    });
    this.label("answer", P.home, "172.253.124.113", {
      kind: "mono",
      dy: 18,
      opacity: ramp(b, 3.1, 3.3),
      color: CSS.back,
    });
    this.label("roots", ll(62, -102, 1.08), "about 2,000 root server instances", {
      kind: "big",
      align: "center",
      opacity: win(b, 0.55, 0.85, 1.25, 1.5),
    });
    const keys: PoseKey[] = [
      { at: -0.5, pose: { ...ROUTE_VIEW, distance: 0.2 } },
      { at: 0.3, pose: ROUTE_VIEW },
      // Pull straight up off the surface before swinging out to the whole planet.
      { at: 0.62, pose: pose(ll(35, -84, 1), 1.0, -84, 35 - 14, 40) },
      { at: 0.95, pose: { ...WORLD, yaw: -60 * DEG, pitch: 28 * DEG, distance: 2.9 } },
      { at: 1.35, pose: CONTINENT },
      { at: 1.62, pose: pose(ll(34.5, -83.5, 1), 0.8, -83.5, 34.5 - 22, 38) },
      { at: 1.85, pose: ATL_VIEW },
      { at: 3.5, pose: { ...ROUTE_VIEW, distance: 0.18 } },
    ];
    void f;
    return poseAt(keys, b);
  }

  private internet(b: number, f: SceneFrame): CameraPose {
    // b0 out of the house to the ISP's core; b1 the routing decision (BGP); b2 into Google.
    this.fineOn = 1;
    const t = piecewise(b, [
      [-0.5, 0],
      [0.2, OUT.marks[2] as number],
      [1.0, OUT.marks[2] as number],
      [1.8, OUT.marks[3] as number],
      [2.4, 1],
    ]);
    this.googleOn = win(b, 0.6, 1.0, 1.5, 2.0);
    this.packet(OUT, t, C.out);
    const hops: [Place, string, string][] = [
      [P.home, "your router", "1"],
      [P.ispHub, "ISP hub, Asheville", "2-3"],
      [P.charlotte, "ISP core, Charlotte", "4-6"],
      [P.atlanta, "Atlanta: handoff to Google (AS15169)", "7"],
      [P.googleAtl, "Google front end", "8-11"],
    ];
    const close = 1 - win(b, 0.45, 0.75, 1.45, 1.75);
    // The house and the hub are 9 km apart, Atlanta and Google's front end 1 km: their labels fan out
    // (the house's to the left) and the Atlanta pair sits below the point, clear of the card on the
    // left and of the path, which arrives from the upper right.
    const align: ("left" | "right")[] = ["right", "left", "left", "left", "left"];
    const dy = [0, 0, 0, 16, 32];
    for (const [k, [place, name]] of hops.entries()) {
      const reached = t >= (OUT.marks[k] as number) - 1e-4;
      this.node(place, reached ? C.out : C.dim, reached ? 0.7 : 0.2, 5);
      this.label(`hop${k}`, place, name, {
        opacity: (reached ? 1 : 0.35) * close,
        align: align[k],
        dy: dy[k],
        color: reached ? CSS.out : CSS.muted,
      });
    }
    this.label("bgp", ll(39.5, -84, 1.02), "routes to 172.253.124.113 learned via BGP", {
      kind: "big",
      align: "center",
      opacity: win(b, 0.65, 0.95, 1.4, 1.7),
    });
    const keys: PoseKey[] = [
      { at: -0.5, pose: { ...ROUTE_VIEW, distance: 0.12 } },
      { at: 0.4, pose: ROUTE_VIEW },
      { at: 0.7, pose: pose(ll(35, -83, 1), 0.9, -83, 35 - 16, 40) },
      { at: 1.0, pose: { ...CONTINENT, distance: 2.4 } },
      { at: 1.35, pose: pose(ll(34.6, -83, 1), 0.8, -83, 34.6 - 22, 40) },
      { at: 1.7, pose: ROUTE_VIEW },
      { at: 2.5, pose: ATL_VIEW },
    ];
    void f;
    return poseAt(keys, b);
  }

  private returnTrip(b: number, f: SceneFrame): CameraPose {
    this.fineOn = 1;
    const t = seg(b, -0.3, 1.2);
    this.lines.polyline(OUT.points, { color: C.out, width: 1, glow: 3, level: 0.06 });
    this.packet(BACK, t, C.back);
    this.node(P.googleAtl, C.google, 0.6, 5);
    this.node(P.home, t >= 1 ? C.back : C.city, t >= 1 ? 1 : 0.5);
    this.label("g", P.googleAtl, "Google front end", { align: "right", dy: 16 });
    this.label("gv", P.greenville, "back via Greenville", { opacity: ramp(b, 0.2, 0.5), color: CSS.back });
    this.label("home", P.home, "you", { kind: "name", color: CSS.back, opacity: ramp(b, 0.6, 1.0) });
    void f;
    return poseAt(
      [
        { at: -0.5, pose: ATL_VIEW },
        { at: 1.5, pose: { ...ROUTE_VIEW, distance: 0.19 } },
      ],
      b,
    );
  }

  private wire(b: number, f: SceneFrame): CameraPose {
    // b0 handshakes (short pulses back and forth), b1 the request body (a stream of packets), b2 arrival.
    this.fineOn = 1 - ramp(b, 0.2, 0.8);
    this.node(P.home, C.city, 0.8);
    this.node(API, C.claude, 0.4 + 0.6 * ramp(b, 1.4, 1.8));
    this.label("home", P.home, "you", { kind: "name", color: CSS.out });
    this.label("api", API, "api.anthropic.com · 160.79.104.10", { kind: "mono", color: CSS.claude, dy: -12 });
    this.lines.polyline(WIRE.points, { color: C.out, width: 1.2, glow: 4, level: 0.08 });
    // Handshakes: TCP (SYN, SYN-ACK, ACK) then TLS (hello, hello + certificate, finished).
    const hs = seg(b, -0.4, 0.5) * 4;
    const leg = Math.floor(hs);
    const u = hs - leg;
    if (hs > 0 && hs < 4) {
      const forward = leg % 2 === 0;
      const pts = forward ? WIRE.points : [...WIRE.points].reverse();
      this.lines.polyline(pts, {
        color: forward ? C.out : C.back,
        width: 1.5,
        glow: 5,
        level: 0,
        pulse: { at: u, trail: 0.25, intensity: 5 },
      });
      this.points.point(pointAt(pts, u), {
        color: scaleRgb(forward ? C.out : C.back, 2),
        px: 6,
        glow: 2,
        intensity: 2,
      });
    }
    // The body: ~100 KB in ~70 segments, ramping up as TCP's congestion window grows.
    const body = seg(b, 0.6, 1.7);
    if (body > 0 && body < 1.25) {
      for (let k = 0; k < 70; k++) {
        const start = (k / 70) ** 0.6 * 0.75;
        const x = (body * 1.25 - start) / 0.25;
        if (x <= 0 || x >= 1) continue;
        this.points.point(pointAt(WIRE.points, x), { color: scaleRgb(C.out, 1.6), px: 3.5, glow: 1.5, intensity: 1.4 });
      }
    }
    this.label("tls", ll(37.6, -80.6, 1.03), "TCP + TLS handshakes", {
      kind: "big",
      align: "center",
      opacity: win(b, -0.3, 0, 0.4, 0.6),
    });
    this.label("body", ll(37.6, -80.6, 1.03), "the request: ~100 KB in ~70 packets", {
      kind: "big",
      align: "center",
      opacity: win(b, 0.7, 0.95, 1.6, 1.9),
    });
    void f;
    return poseAt(
      [
        { at: -0.5, pose: { ...ROUTE_VIEW, distance: 0.3 } },
        { at: 0.6, pose: EAST },
        { at: 2.5, pose: { ...EAST, distance: 0.75, yaw: -80 * DEG } },
      ],
      b,
    );
  }

  private stream(b: number, f: SceneFrame): CameraPose {
    // Tokens flow from the datacenter, through the API, home: a steady dribble of tiny packets.
    this.node(DC, C.claude, 1, 8);
    this.node(API, C.claude, 0.6);
    this.node(P.home, C.city, 0.8);
    // The event label floats just right of the datacenter, so its own label goes to the left.
    this.label("dc", DC, "a datacenter", { color: CSS.claude, align: "right" });
    this.label("api", API, "api.anthropic.com", { kind: "mono", color: CSS.claude, dy: -12 });
    this.label("home", P.home, "you", { kind: "name", color: CSS.back });
    this.lines.polyline(STREAM.points, { color: C.claude, width: 1.2, glow: 4, level: 0.1 });
    const flow = ramp(b, -0.5, 0.2);
    const n = 46;
    for (let k = 0; k < n; k++) {
      const x = (f.time * 0.12 + k / n) % 1;
      const ping = k % 15 === 7;
      this.points.point(pointAt(STREAM.points, x), {
        color: ping ? [1, 1, 1] : scaleRgb(C.claude, 1.5),
        px: ping ? 6 : 3.5,
        glow: 1.6,
        intensity: flow * (ping ? 2.2 * ramp(b, 0.6, 1.0) : 1.3),
      });
    }
    this.label("sse", ll(41, -82.5, 1.04), "event: content_block_delta", {
      kind: "mono",
      align: "center",
      dy: -14,
      opacity: win(b, -0.2, 0.2, 1.5, 1.9),
      color: CSS.claude,
    });
    this.label("ping", ll(39.7, -82.0, 1.04), "event: ping", {
      kind: "mono",
      align: "center",
      opacity: win(b, 0.7, 1.0, 1.6, 1.9),
    });
    return poseAt(
      [
        {
          at: -0.5,
          pose: { ...EAST, distance: 0.95, target: ll(38.5, -83, 1), yaw: -83 * DEG, pitch: (38.5 - 24) * DEG },
        },
        { at: 2.5, pose: { ...EAST, distance: 0.8, target: ll(37.5, -82, 1), yaw: -80 * DEG } },
      ],
      b,
    );
  }

  private finale(f: SceneFrame): CameraPose {
    const scale = f.chapter === "scale";
    this.usersOn = scale ? ramp(f.beat, -0.4, 0.6) : 0.5 + 0.5 * (1 - ramp(f.p, 0.6, 1));
    if (!scale) {
      // The outro: one ping, still going.
      const t = (f.time * 0.22) % 1;
      this.packet(OUT, seg(t, 0.05, 0.45), C.out, { base: 0.04 });
      const back = seg(t, 0.55, 0.95);
      if (back > 0) this.packet(BACK, back, C.back, { base: 0 });
    }
    const spin = f.reducedMotion ? 0 : f.time * 1.5;
    if (scale) {
      return poseAt(
        [
          { at: -0.5, pose: { ...EAST, distance: 1.2 } },
          { at: 1.5, pose: { ...WORLD, distance: 3.3, yaw: (-75 + spin) * DEG } },
        ],
        f.beat,
      );
    }
    return pose([0, 0, 0], 3.3 + f.p * 0.4, -75 + spin, 20, 40);
  }

  draw(pass: GPURenderPassEncoder): void {
    this.earth.draw(pass, "solid");
    this.land.draw(pass);
    if (this.fineOn > 0.01) {
      this.fine.opacity = this.fineOn;
      this.fine.draw(pass);
    }
    this.metros.opacity = 0.5;
    this.metros.draw(pass);
    if (this.rootsOn > 0.01) {
      this.roots.opacity = this.rootsOn;
      this.roots.draw(pass);
    }
    if (this.googleOn > 0.01) {
      this.googleNet.opacity = this.googleOn;
      this.googleNet.draw(pass);
    }
    if (this.usersOn > 0.01) {
      this.users.opacity = this.usersOn;
      this.users.draw(pass);
    }
    this.lines.draw(pass);
    this.points.draw(pass);
    this.earth.draw(pass, "halo");
  }

  anchor(name: string): CameraPose | null {
    // Close-up for fly-throughs (story/flights.ts): looking down on home from about 150 km.
    if (name === "home") return pose(ll(P.home.lat, P.home.lon, 1), 0.024, P.home.lon, P.home.lat - 20, 40);
    return null;
  }

  labels(out: Label[]): void {
    out.push(...this.out);
  }
}

const globeScene: SceneFactory = (gfx) => new GlobeScene(gfx);
export default globeScene;
