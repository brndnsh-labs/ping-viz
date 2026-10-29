// HTML labels pinned to 3D points. Elements are pooled by id; each frame a scene's labels are
// projected with that scene's camera and faded with its crossfade weight.
import { type CameraState, projectToScreen } from "../render/camera";
import type { Label } from "../scenes/scene";

interface Entry {
  el: HTMLDivElement;
  text: string;
  cls: string;
  color: string;
  used: boolean;
  shown: boolean;
  /** Rendered width in CSS px, measured again whenever the text or class changes (-1: stale). */
  w: number;
}

/** How close to the viewport's side a label may get, in CSS px. */
const EDGE = 8;

export class LabelLayer {
  private readonly root: HTMLElement;
  private readonly entries = new Map<string, Entry>();
  /** The gap between an anchor and a left/right-aligned label (0.45rem, see .label in style.css). */
  private readonly gap: number;

  constructor(root: HTMLElement) {
    this.root = root;
    this.gap = 0.45 * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
  }

  begin(): void {
    for (const e of this.entries.values()) e.used = false;
  }

  place(prefix: string, labels: readonly Label[], cam: CameraState, weight: number): void {
    if (weight <= 0.01) return;
    const [vw, vh] = cam.viewport;
    for (const l of labels) {
      const op = (l.opacity ?? 1) * weight;
      if (op <= 0.02) continue;
      const s = projectToScreen(cam, l.pos);
      if (!s) continue;
      const x = s.x + (l.dx ?? 0);
      const y = s.y + (l.dy ?? 0);
      if (x < -200 || x > vw + 200 || y < -60 || y > vh + 60) continue;
      const key = `${prefix}:${l.id}`;
      let e = this.entries.get(key);
      if (!e) {
        const el = document.createElement("div");
        el.className = "label";
        this.root.appendChild(el);
        e = { el, text: "", cls: "", color: "", used: false, shown: true, w: -1 };
        this.entries.set(key, e);
      }
      e.used = true;
      if (e.text !== l.text) {
        e.el.textContent = l.text;
        e.text = l.text;
        e.w = -1;
      }
      const align = l.align ?? "left";
      const cls = `label ${l.kind ?? "name"} ${align}`;
      if (e.cls !== cls) {
        e.el.className = cls;
        e.cls = cls;
        e.w = -1;
      }
      if (!e.shown) {
        e.el.hidden = false;
        e.shown = true;
      }
      const color = l.color ?? "";
      if (e.color !== color) {
        e.el.style.color = color;
        e.color = color;
      }
      // A label whose point is on screen stays whole: near a side (phones, mostly) it slides inward.
      let sx = x;
      if (x >= 0 && x <= vw) {
        if (e.w <= 0) e.w = e.el.offsetWidth;
        const left = align === "left" ? x + this.gap : align === "right" ? x - this.gap - e.w : x - e.w / 2;
        const room = vw - EDGE - e.w;
        sx = x + (room < EDGE ? EDGE : Math.min(Math.max(left, EDGE), room)) - left;
      }
      e.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      e.el.style.opacity = op.toFixed(3);
    }
  }

  end(): void {
    for (const e of this.entries.values()) {
      if (!e.used && e.shown) {
        e.el.hidden = true;
        e.shown = false;
      }
    }
  }
}
