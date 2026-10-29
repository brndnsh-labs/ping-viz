# Round Trip (ping-viz)

A WebGPU explainer: what happens when you type `ping google.com` (Act I), then when you send a
prompt in Claude Code (Act II). See README.md for the layout and docs/storyboard.md for the plan.

- `npm run verify` is the gate (typecheck, biome, vitest, build, headless WebGPU smoke test).
- Raw WebGPU + WGSL, no engine. WebGPU baseline only (no optional features): it must run in
  Safari 26 (iPhone 17, M1 Pro / M5 Pro MacBook Pros are the reference devices) and Chrome.
- The storyboard is the contract between prose and scenes: chapter ids, scenes and card counts must
  match across `src/story/chapters.ts`, `content/*.html` and `docs/storyboard.md` (tests check).
  Scenes key their animation to card beats, so changing a chapter's card count means changing its
  scene too.
- Accuracy matters more than anything: every fact in the prose and every scene label should be
  checkable. Anthropic infrastructure: public facts only (see the Sources card); visuals of it are
  illustrations. Packet bytes come from `src/net/packet.ts`, never typed by hand.
- Prose follows ~/blog/voice.md (plain, concrete, no hype, few em dashes, no triads); Brandon edits
  it before it ships.
- This dev box has no GPU. `npm run shot -- <chapter>:<p>` renders frames in headless Chrome with
  SwiftShader (software WebGPU) and writes PNGs to tmp/shots/; real performance can only be judged
  on real hardware.
- WebGPU needs a secure context: view the dev server through localhost (an SSH tunnel), not the
  box's LAN IP.
- `bin/deploy` ships to production (https://ping-viz.brndn.zip). Run it only when asked. It needs
  the nginx server block (brndn-zip) and the Caddy matcher (homelab-maintenance) in place.
