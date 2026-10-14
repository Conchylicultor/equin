import { describe, expect, test } from "bun:test";
import {
  bergPoints,
  depthReadout,
  maxHalf,
  openWidth,
  rowWidths,
  stripBg,
  unitY,
} from "./geometry";

// Expected values are the prototype's own formulas (index.html), evaluated by hand.

describe("openWidth", () => {
  test("grows with the sentence and the weight, capped at 300", () => {
    expect(openWidth("x".repeat(100), 1)).toBe(230);
    expect(openWidth("x".repeat(100), 3)).toBe(262);
    expect(openWidth("x".repeat(400), 3)).toBe(300);
  });
});

describe("maxHalf", () => {
  test("48% of the width, never past 580", () => {
    expect(maxHalf(1000)).toBe(480);
    expect(maxHalf(1600)).toBe(580);
  });
});

describe("rowWidths", () => {
  test("the apps row at 1280: 0.75 of the berg, 90% of it", () => {
    // M = 580 → round(2·580·0.75·0.9) = 783; open: min(page 940, max(1096.2, 740)) = 940
    expect(rowWidths(1280, 0, 10)).toEqual({ row: 783, open: 940 });
  });
  test("a middle layer averages its taper with the next one's", () => {
    // HW[4]=.76, HW[5]=.86 → .81; round(2·580·.81·.9) = 846
    expect(rowWidths(1280, 4, 10).row).toBe(846);
  });
  test("a phone uses the phone taper and a 96% row", () => {
    // W=390: M=187.2, HW_PHONE[1]=.66, [2]=.76 → .71; round(2·187.2·.71·.96) = 255
    expect(rowWidths(390, 1, 10).row).toBe(255);
  });
});

describe("unitY", () => {
  test("interpolates inside a layer, and reaches the end at the last unit", () => {
    const cuts = [0, 100, 300, 600];
    expect(unitY(cuts, 1)).toBe(100);
    expect(unitY(cuts, 1.5)).toBe(200);
    expect(unitY(cuts, 3)).toBe(600);
  });
});

describe("stripBg", () => {
  test("strip 0 is the sky", () => {
    expect(stripBg(0, 10)).toContain("var(--berg-sky-0)");
  });
  test("a sea strip places its stops in layer units relative to itself", () => {
    expect(stripBg(1, 10)).toBe(
      "linear-gradient(to bottom, var(--berg-sea-0) 0.00%, var(--berg-sea-1) 100.00%, var(--berg-sea-2) 450.00%, var(--berg-sea-3) 702.00%, var(--berg-abyss) 900.00%)",
    );
  });
});

describe("bergPoints", () => {
  const keys = [
    [10, 5],
    [100, 200],
    [400, 300],
  ] as const;
  test("is the same on every draw (seeded jitter)", () => {
    const a = bergPoints({ W: 1000, M: 480, keys, tailY: 500 });
    const b = bergPoints({ W: 1000, M: 480, keys, tailY: 500 });
    expect(a).toEqual(b);
  });
  test("mirrors one side about the centre and closes at the tail", () => {
    const pts = bergPoints({ W: 1000, M: 480, keys, tailY: 500 });
    // 2 spans × 4 steps + the tail, per side
    expect(pts).toHaveLength(18);
    expect(pts[0]).toEqual([505, 10]);
    expect(pts[8]).toEqual([504, 500]);
    expect(pts[9]).toEqual([496, 500]);
    expect(pts[17]).toEqual([495, 10]);
  });
});

describe("depthReadout", () => {
  const locs = [140365, 34571, 286996, 88701];
  test("above the water: sea level and the apps' lines", () => {
    expect(
      depthReadout(locs, { above: true, cur: 0, t: 0, atBottom: false }),
    ).toEqual({
      value: "Sea level",
      label: "140,365 lines of apps",
    });
  });
  test("below: the layers passed, and the current one in proportion", () => {
    // 34,571 + 286,996 · 0.5
    expect(
      depthReadout(locs, { above: false, cur: 2, t: 0.5, atBottom: false })
        .value,
    ).toBe("178,069");
  });
  test("at the bottom: every layer below the apps", () => {
    expect(
      depthReadout(locs, { above: false, cur: 3, t: 0.2, atBottom: true })
        .value,
    ).toBe("410,268");
  });
});
