// Interactive bits inside the story text: hovering anything with `data-focus` tells the scenes what
// to highlight (packet fields, servers, ...), `data-hexdump` blocks get the packet's bytes, and
// `data-timeline` blocks become to-scale timelines.
import { renderHexdump } from "./hexdump";
import { renderTimeline } from "./timeline";

export function initContent(root: HTMLElement, onFocus: (focus: string | null) => void): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-hexdump]")) renderHexdump(el, el.dataset.hexdump ?? "");
  for (const el of root.querySelectorAll<HTMLElement>("[data-timeline]")) renderTimeline(el);
  let current: string | null = null;
  const set = (f: string | null): void => {
    if (f === current) return;
    current = f;
    onFocus(f);
  };
  root.addEventListener("pointerover", (e) => {
    const el = (e.target as Element | null)?.closest?.("[data-focus]");
    set(el ? el.getAttribute("data-focus") : null);
  });
  root.addEventListener("pointerleave", () => set(null));
  root.addEventListener("focusin", (e) => {
    const el = (e.target as Element | null)?.closest?.("[data-focus]");
    set(el ? el.getAttribute("data-focus") : null);
  });
}
