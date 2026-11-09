import { describe, expect, test } from "bun:test";
import { arrivalDelayMs, arrivalOpenMs } from "./arrival-timing";

describe("arrival timing", () => {
  test("a short batch cascades 150 ms apart, the room open past the last step", () => {
    expect([0, 1, 2, 3].map((s) => arrivalDelayMs(s, 4))).toEqual([
      150, 300, 450, 600,
    ]);
    expect(arrivalOpenMs(4)).toBe(975);
    expect(arrivalOpenMs(3)).toBe(825);
  });

  test("one step opens over the minimum", () => {
    expect(arrivalDelayMs(0, 1)).toBe(150);
    expect(arrivalOpenMs(1)).toBe(600);
  });

  test("a long batch compresses its gaps to keep the cascade bounded", () => {
    expect(arrivalDelayMs(19, 20)).toBe(1050);
    expect(arrivalOpenMs(20)).toBe(1425);
    expect(arrivalOpenMs(100)).toBe(1425);
  });
});
