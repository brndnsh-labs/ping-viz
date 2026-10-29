// A stand-in for scenes that aren't built yet. It exercises every primitive, so it doubles as a
// renderer test card.
import { C } from "../config";
import { BoxBatch } from "../render/boxes";
import { pose } from "../render/camera";
import { LineBatch } from "../render/lines";
import { PointBatch } from "../render/points";
import { circle } from "../render/shapes";
import { SphereBatch } from "../render/spheres";
import type { Vec3 } from "../util/math";
import type { Label, Scene, SceneFactory, SceneId } from "./scene";

export function placeholder(id: SceneId): SceneFactory {
  return (gfx) => {
    const lines = new LineBatch(gfx, `${id}-lines`);
    const points = new PointBatch(gfx, `${id}-points`);
    const boxes = new BoxBatch(gfx, `${id}-boxes`);
    const spheres = new SphereBatch(gfx, `${id}-spheres`);
    let chapter = "";
    const scene: Scene = {
      id,
      update(f) {
        chapter = f.chapter;
        lines.begin();
        points.begin();
        boxes.begin();
        spheres.begin();
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2 + f.time * 0.15;
          boxes.box([Math.cos(a) * 3.2, -0.2, Math.sin(a) * 3.2], [0.7, 0.45, 0.7], {
            edge: i % 3 === 0 ? C.user : i % 3 === 1 ? C.kernel : C.hardware,
            edgePx: 1.5,
            yaw: -a,
          });
        }
        spheres.sphere([0, 0, 0], 1.1, {
          fill: [0.02, 0.03, 0.06],
          rim: C.kernel,
          rimPower: 3,
          halo: C.kernel,
          haloWidth: 0.25,
        });
        lines.polyline(circle([0, -0.2, 0], 3.2, 96), {
          color: C.user,
          width: 1.5,
          glow: 6,
          level: 0.15,
          pulse: { at: (f.p * 2) % 1, trail: 0.3, intensity: 6 },
        });
        lines.polyline(circle([0, 0, 0], 2.0, 96, [1, 0, 0], [0, 1, 0]), {
          color: C.back,
          width: 1,
          glow: 4,
          level: 0.2,
          flow: { period: 0.4, speed: 0.6, duty: 0.25, intensity: 2 },
        });
        for (let i = 0; i < 400; i++) {
          const y = 1 - (i / 399) * 2;
          const r = Math.sqrt(1 - y * y);
          const t = i * 2.399963;
          const p: Vec3 = [Math.cos(t) * r * 1.6, y * 1.6, Math.sin(t) * r * 1.6];
          points.point(p, { color: C.hardware, px: 2.5, intensity: 0.8, glow: 1 });
        }
        lines.time = f.time;
        return pose([0, 0, 0], 9.5, 20 + f.local * 40, 22, 40);
      },
      draw(pass) {
        boxes.draw(pass);
        spheres.draw(pass, "solid");
        spheres.draw(pass, "halo");
        lines.draw(pass);
        points.draw(pass);
      },
      labels(out: Label[]) {
        out.push({ id: "title", pos: [0, 1.9, 0], text: `${id} · ${chapter}`, kind: "big", align: "center" });
      },
    };
    return scene;
  };
}
