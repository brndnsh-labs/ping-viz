# Round Trip

What happens when you type `ping google.com` and press Enter, drawn in WebGPU: one ping from the
key switch closing to the reply reaching your eyes, with a clock showing real elapsed time. Then
the same question for a prompt to Claude Code. Lives at https://ping-viz.brndn.zip.

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
npm run verify     # typecheck, biome, vitest, build, headless smoke test
```

WebGPU only runs in a secure context: use `localhost` (an SSH tunnel such as
`ssh -L 5173:localhost:5173 <dev box>` if the dev server is remote), not a LAN IP. It needs
Safari 26+, Chrome or Edge. Without WebGPU the text still reads; the pictures are off.

`?play` arms autoplay (the page scrolls itself at reading pace; see `src/ui/autoplay.ts`): the
play button is highlighted and the first tap, click, Enter or Space starts it. URL parameters for
development: `?at=dns:0.5` (jump to a chapter and progress), `?only=globe`
(load one scene, the rest are placeholders), `?scale=0.7` (fixed render scale), `?msaa=1`,
`?dpr=1`, `?shot` (capture mode, used by the scripts).

## How it works

- **Story** (`src/story/`, `content/*.html`, `docs/storyboard.md`): 25 chapters in four parts. The
  prose lives in `content/` (one file per act, inlined into index.html at build time). Each chapter
  is a section of text cards; scroll position becomes a story position (chapter + progress), and
  card positions become "beats" so each scene's animation lines up with the text. The storyboard
  is the plan both follow; `tests/story.test.ts` keeps chapters, sections and card counts in sync.
- **Scenes** (`src/scenes/`): eight "sets" (globe, machine, lan, edge, datacenter, model, context,
  loop), each serving one or more chapters. A scene gets the chapter, progress and beat, and returns
  a camera pose, draw calls and HTML labels. Adjacent chapters on different scenes crossfade. See
  `docs/scene-guide.md`.
- **Rendering** (`src/render/`): raw WebGPU + WGSL. Instanced primitives (mitred glowing polylines
  with travelling pulses, points with size caps and custom WGSL instance hooks for procedural sets,
  edge-lit boxes, ray-traced sphere impostors) into two linear-HDR scene slots with 4× MSAA, so two
  scenes can crossfade with their own cameras; then bloom, AgX tone mapping, vignette, grain.
- **The packet** (`src/net/packet.ts`): the real 98 bytes of the echo request, the post-NAT copy and
  the reply, with valid checksums (tests check them). The hexdump in the text and the 3D packet
  both come from it.
- **The globe** (`src/geo/`): land dots from Natural Earth (public domain), rasterised by
  `npm run land` into a 19 KB run-length mask.
- **Facts** (`docs/fact-check.md`): every claim in the prose and labels, with its source.
- **Analytics** (`src/analytics.ts`): self-hosted, cookieless Umami at umami.brndn.zip. Pageviews,
  one `chapter` event per chapter reached, `autoplay` (with its speed) the first time a reader starts
  autoplay, and `no-webgpu` when the page falls back to text. Only ping-viz.brndn.zip reports (the
  tag's `data-domains`), so dev and screenshots stay silent.

## Checking visuals without a GPU

```sh
npm run shot -- dns:0.5 packet:0.6              # chapter:progress, PNGs in tmp/shots/
npm run shot -- --chapter=datacenter --steps=8  # a strip through one chapter
npm run shot -- --all                           # every chapter at 25/50/75%
npm run shot -- loop:0.5 --width=390 --height=844 --dpr=2   # phone
```

Headless Chrome runs WebGPU in software (SwiftShader): slow but faithful. The WebGPU canvas isn't
composited headless, so the script reads the frame back and lays it under the page before
screenshotting, which keeps the text cards and labels in the picture.

## Hosting

Static files in `dist/`, served from the pelican box by nginx (by Host header) behind the Caddy
edge, like murmur. `bin/deploy` verifies, builds, rsyncs and checks the live site.
