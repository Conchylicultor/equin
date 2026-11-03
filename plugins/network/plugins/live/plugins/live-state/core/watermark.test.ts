import { test, expect, describe } from "bun:test";
import { compareTxWatermark } from "./watermark";

describe("compareTxWatermark", () => {
  test("orders plain decimal text numerically", () => {
    expect(compareTxWatermark("1", "2")).toBe(-1);
    expect(compareTxWatermark("2", "1")).toBe(1);
    expect(compareTxWatermark("7", "7")).toBe(0);
  });

  test("is numeric, not lexicographic — '9' < '10'", () => {
    // String comparison would say "9" > "10"; the comparator must not.
    expect(compareTxWatermark("9", "10")).toBe(-1);
    expect(compareTxWatermark("10", "9")).toBe(1);
  });

  test("handles 64-bit xid8 values beyond Number.MAX_SAFE_INTEGER exactly", () => {
    // Adjacent values that collapse to the same float64 — a number-based
    // comparator would return 0 for both pairs.
    expect(compareTxWatermark("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareTxWatermark("9007199254740992", "9007199254740993")).toBe(-1);
    // Near the xid8 ceiling (2^64 - 1).
    expect(compareTxWatermark("18446744073709551615", "18446744073709551614")).toBe(1);
    expect(compareTxWatermark("18446744073709551615", "18446744073709551615")).toBe(0);
  });

  test("throws on non-numeric input — a malformed watermark is a bug", () => {
    expect(() => compareTxWatermark("not-a-xid", "1")).toThrow();
    expect(() => compareTxWatermark("1", "1e3")).toThrow();
    expect(() => compareTxWatermark("1.5", "1")).toThrow();
  });
});
