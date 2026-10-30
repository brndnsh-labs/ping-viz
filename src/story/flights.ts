// Fly-throughs between scenes. Instead of a plain crossfade, the outgoing camera dives into a point
// (an anchor the scene names, such as ping's process) and the incoming camera comes out of the
// matching point in the next scene (home, on the globe). The two zooms meet at the cut, so it reads
// as one move.

/** Anchor names for one scene change, keyed by `${last chapter of the old scene}>${first of the new}`. */
export interface Flight {
  /** Anchor in the outgoing scene to dive into. */
  exit: string;
  /** Anchor in the incoming scene to come out of. */
  entry: string;
}

export const FLIGHTS: Record<string, Flight> = {
  // Act I
  // From the house on the globe down to the key you just pressed.
  "intro>enter": { exit: "home", entry: "enter-key" },
  // The DNS question leaves ping's process for the world, and the answer comes back to it.
  "fork>dns": { exit: "ping", entry: "home" },
  "dns>packet": { exit: "home", entry: "ping" },
  // Out through the Wi-Fi antenna, into the room.
  "packet>wifi": { exit: "antenna", entry: "laptop" },
  // Down the fiber from the router, out onto the map at home.
  "router>internet": { exit: "fiber", entry: "home" },
  // Into Google's front end at Atlanta, and back out.
  "internet>google": { exit: "google", entry: "entry" },
  "google>return": { exit: "entry", entry: "google" },
  // Home, then in through the antenna.
  "return>arrive": { exit: "home", entry: "antenna" },
  // Act II
  // Claude Code's process, then the request it builds.
  "launch>prompt": { exit: "claude", entry: "request" },
  // The finished request leaves home.
  "prompt>wire": { exit: "request", entry: "home" },
  // Into the API's address on the map, then through the front door.
  "wire>frontdoor": { exit: "api", entry: "entry" },
  "frontdoor>datacenter": { exit: "backend", entry: "entry" },
  // Into one chip, where the model runs.
  "datacenter>prefill": { exit: "chip", entry: "input" },
  // The reply leaves the model and heads home.
  "decode>stream": { exit: "output", entry: "datacenter" },
  "stream>loop": { exit: "home", entry: "lap" },
  "loop>scale": { exit: "lap", entry: "home" },
};

export function flightFor(fromId: string, toId: string): Flight | null {
  return FLIGHTS[`${fromId}>${toId}`] ?? null;
}

/** Where the cut falls in the transition (0..1), and how wide the dissolve around it is. */
const CUT = 0.5;
const DISSOLVE = 0.12;

/**
 * How far each camera is into its zoom (0 = the scene's own pose, 1 = the anchor close-up) and the
 * incoming scene's weight, at transition progress t. The outgoing zoom speeds up into the cut and the
 * incoming one starts at that same speed, so the motion doesn't stall at the join.
 */
export function flightCurves(t: number): { out: number; in: number; weight: number } {
  const x = Math.min(1, Math.max(0, t));
  const out = x >= CUT ? 1 : (x / CUT) ** 2;
  const inn = x <= CUT ? 1 : ((1 - x) / (1 - CUT)) ** 2;
  const d = Math.min(1, Math.max(0, (x - (CUT - DISSOLVE)) / (2 * DISSOLVE)));
  return { out, in: inn, weight: d * d * (3 - 2 * d) };
}
