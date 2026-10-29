import { describe, expect, it } from "vitest";
import { formatSpan, segmentAt, timelineSegments } from "../src/ui/timeline";

describe("timelineSegments", () => {
  it("covers Act I from Enter to the screen with no gaps", () => {
    const segs = timelineSegments("enter", "print");
    expect(segs[0]?.start).toBe(0);
    expect(segs[segs.length - 1]?.end).toBeCloseTo(0.075, 9);
    expect(segs.map((s) => s.id)).toContain("dns");
  });

  it("covers Act II from Enter to the end of the reply", () => {
    const segs = timelineSegments("prompt", "stream");
    expect(segs[0]?.start).toBe(0);
    expect(segs[segs.length - 1]?.end).toBe(14);
  });

  it("rejects ranges that include a chapter without a clock", () => {
    expect(() => timelineSegments("print", "prompt")).toThrow(/no clock/);
    expect(() => timelineSegments("print", "enter")).toThrow(/bad range/);
  });
});

describe("segmentAt", () => {
  const segs = timelineSegments("enter", "print");
  it("finds the step running at a time", () => {
    expect(segmentAt(segs, 0.02).id).toBe("dns");
    expect(segmentAt(segs, 0.04).id).toBe("internet");
    expect(segmentAt(segs, 1).id).toBe("print");
  });
});

describe("formatSpan", () => {
  it("picks a unit that suits the size", () => {
    expect(formatSpan(0)).toBe("0");
    expect(formatSpan(0.00002)).toBe("20 µs");
    expect(formatSpan(0.00026)).toBe("260 µs");
    expect(formatSpan(0.0292)).toBe("29.2 ms");
    expect(formatSpan(2.1)).toBe("2.1 s");
  });
});
