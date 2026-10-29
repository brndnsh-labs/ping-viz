// Screenshots of the page in headless Chrome with software WebGPU (SwiftShader), so visuals can be
// checked on a machine without a GPU. Each shot pins the story at a chapter and progress, reads the
// WebGPU frame back (headless Chrome doesn't composite the canvas), lays it under the page, and
// screenshots the whole viewport, text cards and labels included.
//
//   npm run shot -- dns:0.5 internet:0.3            (chapter:progress, any number)
//   npm run shot -- --all                           (every chapter at 0.25, 0.5 and 0.75)
//   npm run shot -- --chapter=dns --steps=6         (a strip through one chapter)
//   npm run shot -- --beats                         (every text card's centre: what a reader sees)
//   npm run shot -- --beats=dns,loop                (the same, for some chapters)
//   npm run shot -- dns:0.5 --width=390 --height=844 --dpr=2     (phone)
//
// Options: --width, --height, --dpr, --dir (default tmp/shots), --param (extra query string),
// --focus=<field id> (as if hovering that field in the text, e.g. ip.ttl), --gl-only (skip the HTML
// overlay). Prints WebGPU/console errors and exits 1 if there were any.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, serveDev } from "./lib/harness.ts";

const args = new Map<string, string>();
const targets: string[] = [];
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1] as string, m[2] ?? "1");
  else targets.push(a);
}
const get = (k: string, d: string): string => args.get(k) ?? d;
const width = Number(get("width", "1280"));
const height = Number(get("height", "800"));
const dpr = Number(get("dpr", "1"));
const dir = get("dir", "tmp/shots");
const overlay = !args.has("gl-only");

mkdirSync(dir, { recursive: true });
const server = await serveDev();
const browser = await launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  const extra = args.get("param");
  await page.goto(`${server.url}/?shot${extra ? `&${extra}` : ""}`);
  await page.waitForFunction(() => window.__ping?.ready === true, undefined, { timeout: 120_000, polling: 250 });
  const gpu = await page.evaluate(() => window.__ping?.gpu);
  if (gpu !== "ok") console.log(`  WebGPU: ${gpu}`);
  const chapters = await page.evaluate(() => window.__ping?.chapters ?? []);
  if (args.has("all")) for (const c of chapters) for (const p of [0.25, 0.5, 0.75]) targets.push(`${c}:${p}`);
  if (args.has("chapter")) {
    const steps = Number(get("steps", "5"));
    for (let i = 0; i < steps; i++) targets.push(`${get("chapter", "intro")}:${((i + 0.5) / steps).toFixed(3)}`);
  }
  if (args.has("beats")) {
    // Card centres depend on the layout (phones stack the text differently), so ask the page.
    const only = get("beats", "1");
    const ids = only === "1" ? chapters : only.split(",");
    for (const c of ids) {
      const cards = await page.evaluate((id) => window.__ping?.cards(id) ?? [], c);
      for (const [k, p] of cards.entries()) targets.push(`${c}:${p.toFixed(4)}:b${k}`);
    }
  }
  if (targets.length === 0) targets.push("intro:0.5");
  for (const t of targets) {
    const [id, ps, tag] = t.split(":");
    const p = Number(ps ?? 0.5);
    const t0 = Date.now();
    await page.evaluate(
      async ([id, p, focus]) => {
        const d = window.__ping;
        if (!d) return;
        d.setFocus((focus as string) || null);
        await d.goto(id as string, p as number);
        const url = await d.capture();
        let img = document.getElementById("__shot") as HTMLImageElement | null;
        if (!img) {
          img = document.createElement("img");
          img.id = "__shot";
          img.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none";
          document.body.appendChild(img);
        }
        img.src = url;
        await img.decode();
      },
      [id, p, args.get("focus") ?? ""] as const,
    );
    const name = `${id}-${tag ?? String(Math.round(p * 100)).padStart(3, "0")}.png`;
    const out = join(dir, name);
    if (overlay) await page.screenshot({ path: out });
    else {
      const url = await page.evaluate(() => (document.getElementById("__shot") as HTMLImageElement).src);
      writeFileSync(out, Buffer.from(url.split(",")[1] as string, "base64"));
    }
    const st = await page.evaluate(() => window.__ping?.state());
    console.log(`${out}  (${((Date.now() - t0) / 1000).toFixed(1)}s)  ${JSON.stringify(st)}`);
  }
  const gpuErrors = await page.evaluate(() => window.__ping?.errors ?? []);
  for (const e of [...gpuErrors, ...errors]) {
    console.log(`  ERROR: ${e}`);
    failed = true;
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
