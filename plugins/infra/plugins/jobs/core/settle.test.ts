import { describe, expect, test } from "bun:test";
import { assertSettleSpec, settledRunAt } from "./settle";

const settle = { quietMs: 2_000, maxWaitMs: 30_000 };
const t = (ms: number) => new Date(1_000_000 + ms);

describe("settledRunAt", () => {
  test("a fresh key is due quietMs from now", () => {
    expect(settledRunAt(settle, t(0), null)).toEqual(t(2_000));
  });
  test("an enqueue onto a pending row pushes it back by quietMs", () => {
    expect(settledRunAt(settle, t(10_000), t(0))).toEqual(t(12_000));
  });
  test("never past maxWaitMs after the pending row was queued", () => {
    expect(settledRunAt(settle, t(29_000), t(0))).toEqual(t(30_000));
  });
  test("a row already past its ceiling is due now, never in the past", () => {
    expect(settledRunAt(settle, t(45_000), t(0))).toEqual(t(45_000));
  });
});

describe("assertSettleSpec", () => {
  test("refuses a ceiling below the quiet window", () => {
    expect(() => assertSettleSpec("j", { quietMs: 5, maxWaitMs: 1 })).toThrow(
      /quietMs <= maxWaitMs/,
    );
  });
  test("refuses a zero quiet window", () => {
    expect(() => assertSettleSpec("j", { quietMs: 0, maxWaitMs: 1 })).toThrow();
  });
  test("accepts a sound window", () => {
    assertSettleSpec("j", settle);
  });
});
