// Every scene is its own module, loaded on its own: one that fails to load or build falls back to a
// placeholder instead of taking the page down. `?only=<scene>` loads just that one (the rest are
// placeholders), which keeps work on one scene independent of the others.
import type { Gfx } from "../render/gfx";
import { placeholder } from "./placeholder";
import type { Scene, SceneFactory, SceneId } from "./scene";

const MODULES: Record<SceneId, () => Promise<{ default: SceneFactory }>> = {
  globe: () => import("./globe"),
  machine: () => import("./machine"),
  lan: () => import("./lan"),
  edge: () => import("./edge"),
  datacenter: () => import("./datacenter"),
  model: () => import("./model"),
  context: () => import("./context"),
  loop: () => import("./loop"),
};

export const SCENE_IDS = Object.keys(MODULES) as SceneId[];

export async function createScenes(gfx: Gfx, only: SceneId | null = null): Promise<Map<SceneId, Scene>> {
  const out = new Map<SceneId, Scene>();
  await Promise.all(
    SCENE_IDS.map(async (id) => {
      let make: SceneFactory = placeholder(id);
      if (only === null || only === id) {
        try {
          make = (await MODULES[id]()).default;
        } catch (e) {
          console.error(`ping-viz: scene "${id}" failed to load`, e);
        }
      }
      try {
        out.set(id, make(gfx));
      } catch (e) {
        console.error(`ping-viz: scene "${id}" failed to build`, e);
        out.set(id, placeholder(id)(gfx));
      }
    }),
  );
  return out;
}
