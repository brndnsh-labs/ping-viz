# Writing a scene

A scene is a "set" that serves one or more chapters (see `docs/storyboard.md`). It lives in
`src/scenes/<id>.ts`, default-exports a `SceneFactory`, and implements `Scene`
(`src/scenes/scene.ts`):

```ts
const factory: SceneFactory = (gfx) => new MyScene(gfx);
export default factory;

class MyScene implements Scene {
  readonly id = "lan" as const;
  update(f: SceneFrame): CameraPose { /* rebuild dynamic batches, return the camera */ }
  draw(pass: GPURenderPassEncoder): void { /* opaque first, then additive */ }
  labels(out: Label[]): void { /* HTML labels for this frame */ }
}
```

`SceneFrame` tells you the chapter, `p` (0..1 through it), `beat` (card units: card k's centre is
k; edges are -0.5 and cards-0.5), `local` (index of the chapter among this scene's chapters + p:
keyframe the camera on it and consecutive chapters stay continuous), `time` (wall clock, ambient
motion only), `narrow` (phone layout), `focus` (what the reader hovers in the text, e.g. a packet
field id like `"ip.ttl"`), `reducedMotion`. Everything the story shows must be a function of
`beat`/`p` so scrolling backwards works.

## Primitives (src/render)

All batches: `begin()` clears, add instances, `draw(pass)`. Properties: `opacity`, `time` (drives
flowing dashes / your hooks), `highlight`, `user` (32 floats for custom hooks). Rebuild dynamic
batches every frame in `update` (fine up to a few thousand instances); fill big static sets once in
the constructor and animate them with `opacity`/`time`/`user`.

- **LineBatch** (`lines.ts`): `polyline(points, style)`, `segment(a, b, style)`. Style: `color`,
  `colors` (per-vertex gradient), `level` (base brightness; 0 = only pulse/flow visible), `width` and
  `glow` in CSS px, `opacity`, `pulse: { at, trail, intensity, flare }` (fractions of the line's
  length: a travelling bright spot), `flow: { period, speed, duty, intensity }` (moving dashes in
  scene units, animated by the batch's `time`). Mitred joins, round free ends, additive,
  depth-tested.
- **PointBatch** (`points.ts`): `point(pos, { color, intensity, size (world diameter) | px, minPx,
  glow, shape: soft|disc|ring })`; `maxPx` caps the drawn size (dots stay dots up close). Custom
  instance source: pass `{ key, wgsl }` defining `fn getPoint(i: u32) -> PointInst` (see
  points.wgsl) and set `procedural` to the count: for tens or hundreds of thousands of instances
  placed and animated on the GPU.
- **BoxBatch** (`boxes.ts`): `box(center, size, { edge, edgeIntensity, edgePx, fill, fillIntensity,
  yaw })`: dark faces with glowing px-width edges. Opaque by default (writes depth); pass
  `{ blend: "add", depthWrite: false }` to the constructor for holograms. Custom hook:
  `fn getBox(i: u32) -> BoxInst`.
- **SphereBatch** (`spheres.ts`): ray-traced impostors. `sphere(c, r, { fill, rim, rimPower, halo,
  haloWidth })`; `draw(pass, "solid" | "halo" | "glass")`.
- **shapes.ts**: `circle`, `quad`, `cubic`, `bridge` (lifted arc), `filleted` (rounded-corner paths,
  circuit-trace style), `pathLength`, `pointAt(points, t)`, `slice`.
- **camera.ts**: `pose(target, distance, yawDeg, pitchDeg, fov)`; yaw 0 puts the eye on +z looking
  toward -z, pitch looks down. `poseAt(keys, x)` is a Catmull-Rom path through `{ at, pose }` keys;
  `lerpPose`. Near/far planes follow the distance (near = distance × 0.004), so huge zooms work.
- **util/ease.ts**: `seg(x, a, b)` (0..1 ramp), `ramp` (smoothed), `window(x, a, b, c, d)`
  (rise-hold-fall), `piecewise(x, pts)`, `smooth`, `easeInOut`, ...
- **config.ts**: the palette. `C.*` are linear HDR colours for primitives, `CSS.*` match them for
  labels. Use `scaleRgb` for brighter versions rather than new hues.
- **net/packet.ts**: the real bytes (`REQUEST`, `AFTER_NAT`, `REPLY`), with `fields` (id, layer,
  offset, length, value) for drawing and highlighting the packet.

Draw order inside `draw`: opaque geometry (boxes, solid spheres) first, then additive (lines,
points, glass/halo spheres).

Units are yours: pick them so the subject is roughly 10 units across and the camera ~10-20 away.
The renderer shifts the lens so the subject sits right of the text on desktop and above it on
phones: frame your subject centred. The field of view is vertical, so a portrait phone sees well
under half as much across as a desktop: when `narrow`, pull the camera back. `fitNarrow(pose, f)`
in render/camera.ts does it by aspect (globe, house, edge, loop); model and datacenter keep a
multiplier per shot, machine and context their own phone layouts.

## Labels

`labels(out)` pushes `{ id, pos, text, kind, align, dx, dy, opacity, color }`. Kinds: `name`
(components), `note` (secondary), `mono` (addresses, values, code), `big` (an occasional caption).
Keep them short and few, fade them with the beat they belong to, and make sure what they say matches
the storyboard and the text. Don't invent facts.

## Checking your work

```sh
npx tsc --noEmit 2>&1 | grep src/scenes/<id>          # your files only
npx biome check --write src/scenes/<id>.ts
npm run shot -- <chapter>:0.3 <chapter>:0.6 --param=only=<id> --dir=tmp/shots/<id>
npm run shot -- --chapter=<chapter> --steps=6 --param=only=<id> --dir=tmp/shots/<id>
npm run shot -- <chapter>:0.5 --width=390 --height=844 --dpr=2 --param=only=<id> --dir=tmp/shots/<id>
```

Shots render with software WebGPU (SwiftShader): 10-60 s each, and the whole page (text cards,
labels, HUD) is in the PNG. `--param=only=<id>` loads only your scene, so other unfinished scenes
can't break your run. Look at the PNGs (they're the only way to see the result), be critical, and
iterate: composition, legibility at phone size, the text cards not covering the subject, motion that
reads from beat to beat.

Performance target: 60 fps on an M1 MacBook Pro and an iPhone 17. No optional WebGPU features.
