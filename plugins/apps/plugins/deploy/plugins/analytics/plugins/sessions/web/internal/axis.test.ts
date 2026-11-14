import { describe, expect, it } from "bun:test";
import {
  axisFrac,
  axisMaxS,
  axisTicks,
  labelledTicks,
  pageShares,
} from "./axis";

describe("axisMaxS", () => {
  it("is never under an hour, else the longest visit", () => {
    expect(axisMaxS(12)).toBe(3600);
    expect(axisMaxS(4440)).toBe(4440);
  });
});

describe("axisFrac", () => {
  it("is log1p(s/4) / log1p(max/4), 0 at 0 and 1 at the end", () => {
    expect(axisFrac(0, 3600)).toBe(0);
    expect(axisFrac(3600, 3600)).toBe(1);
    expect(axisFrac(60, 3600)).toBeCloseTo(
      Math.log1p(15) / Math.log1p(900),
      12,
    );
  });
  it("keeps a bounce readable: 5 s takes over a tenth of an hour-long axis", () => {
    expect(axisFrac(5, 3600)).toBeGreaterThan(0.1);
  });
  it("is monotonic and clamped past the end", () => {
    expect(axisFrac(30, 3600)).toBeLessThan(axisFrac(31, 3600));
    expect(axisFrac(9000, 3600)).toBe(1);
    expect(axisFrac(-3, 3600)).toBe(0);
  });
});

describe("axisTicks", () => {
  it("labels up to the axis' end", () => {
    expect(axisTicks(3600).map((t) => t.label)).toEqual([
      "0",
      "10s",
      "30s",
      "1m",
      "5m",
      "15m",
      "1h",
    ]);
    expect(axisTicks(8000).at(-1)!.label).toBe("2h");
  });
});

describe("pageShares", () => {
  it("splits the bar linearly by each page's share of the visit", () => {
    expect(pageShares([96, 74, 41]).map((x) => x * 211)).toEqual([
      expect.closeTo(96, 9),
      expect.closeTo(74, 9),
      expect.closeTo(41, 9),
    ]);
  });
  it("shares evenly when the visit has no measured time", () => {
    expect(pageShares([0, 0])).toEqual([0.5, 0.5]);
  });
});

describe("labelledTicks", () => {
  it("a wide axis keeps every tick", () => {
    expect(labelledTicks(3600, 1000)).toEqual(axisTicks(3600));
  });
  it("a narrow axis drops the ticks crowding their neighbours, keeping 0 and the end", () => {
    const labels = labelledTicks(3600, 120).map((t) => t.label);
    expect(labels[0]).toBe("0");
    expect(labels.at(-1)).toBe("1h");
    expect(labels.length).toBeLessThan(axisTicks(3600).length);
  });
  it("kept labels never sit closer than their room", () => {
    const w = 150;
    const xs = labelledTicks(7200, w).map((t) => axisFrac(t.s, 7200) * w);
    for (let i = 1; i < xs.length; i++)
      expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(32);
  });
});
