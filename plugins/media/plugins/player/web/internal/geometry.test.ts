import { describe, expect, it } from "bun:test";
import { previewSize } from "./geometry";

describe("previewSize", () => {
  it("is a quarter of the player's width, within bounds", () => {
    expect(previewSize(16 / 9, 640, 360)).toEqual({ width: 160, height: 90 });
    expect(previewSize(16 / 9, 2000, 1125)).toEqual({
      width: 192,
      height: 108,
    });
    expect(previewSize(16 / 9, 200, 400)).toEqual({ width: 96, height: 54 });
  });
  it("is never taller than 40% of the player", () => {
    expect(previewSize(9 / 16, 640, 360)).toEqual({ width: 81, height: 144 });
  });
  it("has no size before the aspect is known", () => {
    expect(previewSize(0, 640, 360)).toBeNull();
    expect(previewSize(Number.NaN, 640, 360)).toBeNull();
  });
});
