import { describe, expect, test } from "bun:test";
import {
  swingFeelName,
  swingLabel,
  swingRatioLabel,
  swingSplit,
  swingStopAt,
} from "./swing-format";

describe("swing formatting", () => {
  test("ratios read as the musician writes them", () => {
    expect(swingRatioLabel(2)).toBe("2:1");
    expect(swingRatioLabel(1.5)).toBe("3:2");
    expect(swingRatioLabel(3)).toBe("3:1");
    expect(swingRatioLabel(1.75)).toBe("1.75:1");
  });

  test("a ratio has a name", () => {
    expect(swingFeelName(1)).toBe("Straight");
    expect(swingFeelName(1.5)).toBe("Light swing");
    expect(swingFeelName(2)).toBe("Triplet swing");
    expect(swingFeelName(3)).toBe("Hard swing");
  });

  test("label, split and stops", () => {
    expect(swingLabel({ unit: 16, ratio: 1.5 })).toBe("Swing 16ths · 3:2");
    expect(swingSplit(2)).toEqual([67, 33]);
    expect(swingStopAt(2)?.id).toBe("triplet");
    expect(swingStopAt(2.1)).toBeUndefined();
  });
});
