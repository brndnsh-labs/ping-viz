// One colour language for every scene. Values are linear HDR (the tone mapper rolls off anything
// above ~1); multiply for brighter glows rather than inventing new hues.
import type { Rgb } from "./render/gfx";

export const C = {
  // Where things live (the exploded machine's three planes).
  user: [1.0, 0.56, 0.2] as Rgb, // user space: amber
  kernel: [0.2, 0.72, 1.0] as Rgb, // kernel: cyan
  hardware: [0.58, 0.38, 1.0] as Rgb, // hardware: violet

  // The packet, by layer (headers are added in this order: icmp, ip, link).
  payload: [1.0, 0.86, 0.66] as Rgb, // data: warm white
  icmp: [1.0, 0.46, 0.14] as Rgb, // ICMP header: orange
  ip: [0.3, 0.52, 1.0] as Rgb, // IP header: blue
  link: [0.86, 0.32, 1.0] as Rgb, // Ethernet / Wi-Fi: magenta

  // Direction.
  out: [1.0, 0.62, 0.26] as Rgb, // a request heading out
  back: [0.24, 1.0, 0.7] as Rgb, // the reply coming home: mint

  // Places.
  land: [0.32, 0.42, 0.62] as Rgb, // globe land dots
  city: [0.85, 0.9, 1.0] as Rgb,
  google: [0.9, 0.95, 1.0] as Rgb,
  dns: [0.7, 0.55, 1.0] as Rgb, // DNS servers: lavender

  // Act II.
  claude: [1.0, 0.44, 0.28] as Rgb, // the model's own tokens: coral
  tools: [0.2, 0.9, 0.78] as Rgb, // tool definitions: teal
  system: [0.42, 0.5, 0.95] as Rgb, // system prompt: slate blue
  memory: [0.92, 0.3, 0.5] as Rgb, // CLAUDE.md / memory: wine
  history: [0.36, 0.66, 1.0] as Rgb, // conversation so far: blue
  prompt: [1.0, 0.92, 0.75] as Rgb, // your message: bright warm white
  cache: [0.55, 0.62, 0.75] as Rgb, // served from the prompt cache: steel

  white: [1, 1, 1] as Rgb,
  dim: [0.18, 0.22, 0.3] as Rgb,
} as const;

/** CSS colours for labels that match the scene colours. */
export const CSS = {
  user: "#ffb066",
  kernel: "#6cc8ff",
  hardware: "#b49bff",
  payload: "#ffe2bf",
  icmp: "#ff9a55",
  ip: "#86a8ff",
  link: "#e69bff",
  out: "#ffb877",
  back: "#7dffc6",
  dns: "#c4b0ff",
  claude: "#ff9277",
  tools: "#6ff0d9",
  system: "#9aa6ff",
  memory: "#ff8fae",
  history: "#8fc0ff",
  prompt: "#fff1d6",
  cache: "#a8b4c8",
  muted: "#8a93a1",
} as const;

export const scaleRgb = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];
export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
