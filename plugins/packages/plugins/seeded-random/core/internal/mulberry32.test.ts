import { describe, expect, test } from "bun:test";
import { mulberry32 } from "./mulberry32";

describe("mulberry32", () => {
  test("the same seed yields the same sequence", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  test("values stay in [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("a seed is taken modulo 2^32", () => {
    expect(mulberry32(1)()).toBe(mulberry32(1 + 2 ** 32)());
    expect(mulberry32(-1)()).toBe(mulberry32(2 ** 32 - 1)());
  });
});
