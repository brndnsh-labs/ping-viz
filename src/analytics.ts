/**
 * Umami analytics (cookieless, self-hosted at umami.brndn.zip). The tracker script in index.html
 * records the pageview; this adds how far people read and whether WebGPU was missing. The tag's
 * `data-domains` limits reporting to ping-viz.brndn.zip, so dev, localhost and screenshots stay silent.
 */

interface Umami {
  track(event: string, data?: Record<string, string | number>): void;
}

/** Send one event. A silent no-op if the tracker is blocked, offline or not loaded yet; never throws. */
function track(event: string, data?: Record<string, string | number>): void {
  try {
    (globalThis as { umami?: Umami }).umami?.track(event, data);
  } catch {
    // analytics must never break the page
  }
}

/**
 * One `chapter` event per chapter, the first time it crosses the middle of the screen. Works with or
 * without WebGPU, since the text is there either way. The tracker loads deferred, so an event fired
 * before it's ready is dropped; that only affects the first chapter, which the pageview covers.
 */
export function trackChapters(root: ParentNode): void {
  const seen = new Set<string>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.chapter;
        if (!e.isIntersecting || !id || seen.has(id)) continue;
        seen.add(id);
        io.unobserve(e.target);
        track("chapter", { id });
      }
    },
    { rootMargin: "-50% 0px -50% 0px" },
  );
  for (const el of root.querySelectorAll<HTMLElement>("[data-chapter]")) io.observe(el);
}

/** The page fell back to text only: no WebGPU, or the GPU was lost. */
export function trackNoGpu(reason: string): void {
  track("no-webgpu", { reason: reason.slice(0, 80) });
}
