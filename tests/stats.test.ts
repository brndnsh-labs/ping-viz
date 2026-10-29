import { describe, expect, it } from "vitest";
import type { PerfSample } from "../src/app";
import { formatStats } from "../src/ui/stats";

const sample: PerfSample = {
  frames: 30,
  cpuMs: 1.234,
  gpuMs: -1,
  worstGapMs: 17.04,
  renderScale: 1,
  width: 2880,
  height: 1800,
  scenes: ["globe", "lan"],
};

describe("formatStats", () => {
  it("turns frames per period into fps and shows a dash before the first GPU sample", () => {
    const text = formatStats(sample, 500, 2);
    expect(text).toContain("60 fps");
    expect(text).toContain("gpu –");
    expect(text).toContain("2880×1800");
    expect(text).toContain("globe + lan");
  });

  it("shows GPU time once there is one", () => {
    expect(formatStats({ ...sample, gpuMs: 4.56 }, 500, 2)).toContain("gpu 4.6 ms");
  });
});
