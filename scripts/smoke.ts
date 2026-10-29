// Smoke test of the production build: open dist/ in headless Chrome (software WebGPU), visit one
// chapter of every scene, and check that each frame has real content and nothing errored.
//
//   npm run build && npm run smoke
import { launch, serveBuild } from "./lib/harness.ts";

// One stop per scene (and the intro), mid-chapter.
const STOPS = [
  "intro:0.5",
  "shell:0.5",
  "dns:0.6",
  "wifi:0.5",
  "google:0.5",
  "prompt:0.5",
  "datacenter:0.5",
  "prefill:0.5",
  "loop:0.5",
];

const failures: string[] = [];
const server = await serveBuild();
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on("console", (m) => {
    if (m.type() === "error") failures.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => failures.push(`page: ${String(e)}`));
  await page.goto(`${server.url}/?shot`);
  await page.waitForFunction(() => window.__ping?.ready === true, undefined, { timeout: 180_000, polling: 250 });
  const gpu = await page.evaluate(() => window.__ping?.gpu);
  if (gpu !== "ok") failures.push(`WebGPU didn't start: ${gpu}`);
  for (const stop of STOPS) {
    const [id, p] = stop.split(":") as [string, string];
    const stats = await page.evaluate(
      async ([id, p]) => {
        const d = window.__ping;
        if (!d) return null;
        await d.goto(id as string, Number(p));
        const url = await d.capture();
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d") as CanvasRenderingContext2D;
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, c.width, c.height).data;
        let sum = 0;
        let sum2 = 0;
        let lit = 0;
        const n = px.length / 4;
        for (let i = 0; i < px.length; i += 4) {
          const l = 0.2126 * (px[i] as number) + 0.7152 * (px[i + 1] as number) + 0.0722 * (px[i + 2] as number);
          sum += l;
          sum2 += l * l;
          if (l > 60) lit++;
        }
        const mean = sum / n;
        return {
          mean,
          std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)),
          lit: lit / n,
          slots: d.state()?.slots ?? [],
        };
      },
      [id, p] as const,
    );
    if (!stats) {
      failures.push(`${stop}: no debug hooks`);
      continue;
    }
    console.log(
      `${stop.padEnd(16)} mean ${stats.mean.toFixed(1)}  std ${stats.std.toFixed(1)}  lit ${(stats.lit * 100).toFixed(1)}%  ${stats.slots.join("+")}`,
    );
    if (stats.std < 3 || stats.lit < 0.001) failures.push(`${stop}: frame looks empty (std ${stats.std.toFixed(1)})`);
  }
  const gpuErrors = await page.evaluate(() => window.__ping?.errors ?? []);
  for (const e of gpuErrors) failures.push(`webgpu: ${e}`);
} catch (e) {
  failures.push(String(e));
} finally {
  await browser.close();
  await server.close();
}

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("smoke: ok");
