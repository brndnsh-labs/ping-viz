// Shared pieces for the headless-browser scripts (shot, smoke).
import { type Browser, chromium } from "playwright";
import { createServer, preview } from "vite";

// Software WebGPU that can also present to a canvas (--disable-vulkan-surface hangs presentation).
export const WEBGPU_FLAGS = [
  "--enable-unsafe-webgpu",
  "--enable-unsafe-swiftshader",
  "--use-webgpu-adapter=swiftshader",
  "--enable-features=Vulkan",
  "--use-angle=swiftshader",
];

/** What the page exposes on `window.__ping` (see src/main.ts). */
export interface PingDebug {
  ready: boolean;
  errors: string[];
  gpu: string;
  capture: () => Promise<string>;
  goto: (id: string, p: number) => Promise<void>;
  frames: (n: number) => Promise<void>;
  state: () => { chapter: string; p: number; slots: string[] } | null;
  chapters: string[];
  cards: (id: string) => number[];
  setFocus: (focus: string | null) => void;
}

declare global {
  interface Window {
    __ping?: PingDebug;
  }
}

export interface Served {
  url: string;
  close: () => Promise<void>;
}

/** The dev server (source, with HMR off) on a free port. */
export async function serveDev(): Promise<Served> {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1", hmr: false }, logLevel: "error" });
  await server.listen();
  const a = server.httpServer?.address();
  const port = typeof a === "object" && a ? a.port : 5173;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** The production build in dist/ on a free port. */
export async function serveBuild(): Promise<Served> {
  const server = await preview({ preview: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
  const a = server.httpServer.address();
  const port = typeof a === "object" && a ? a.port : 4173;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

export function launch(): Promise<Browser> {
  return chromium.launch({
    executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
    headless: true,
    args: WEBGPU_FLAGS,
  });
}

/** Decode a PNG data URL to bytes. */
export const dataUrlBytes = (url: string): Buffer => Buffer.from(url.split(",")[1] as string, "base64");
