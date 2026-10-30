import { describe, expect, test } from "bun:test";
import { coveredMs, overlapsAny, pushBounded } from "./intervals";

describe("coveredMs", () => {
  test("clips to the window and unions overlaps", () => {
    const iv = [
      { startMs: 0, endMs: 100 },
      { startMs: 50, endMs: 150 }, // overlaps the first: counted once
      { startMs: 300, endMs: 400 },
    ];
    expect(coveredMs(iv, 80, 350)).toBe(70 + 50);
  });

  test("nothing inside the window is 0", () => {
    expect(coveredMs([{ startMs: 0, endMs: 10 }], 20, 30)).toBe(0);
  });
});

describe("overlapsAny", () => {
  test("a touching interval overlaps; a disjoint one does not", () => {
    expect(overlapsAny([{ startMs: 0, endMs: 10 }], 10, 20)).toBe(true);
    expect(overlapsAny([{ startMs: 0, endMs: 9 }], 10, 20)).toBe(false);
  });
});

describe("pushBounded", () => {
  test("drops the oldest past the cap", () => {
    const ring = [1, 2];
    pushBounded(ring, 3, 2);
    expect(ring).toEqual([2, 3]);
  });
});
