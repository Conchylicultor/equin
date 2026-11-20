import { describe, expect, test } from "bun:test";
import { awakeBetween, isSleepStamp, sleptBetween } from "./stamp";

const s = (asleepMs: number, boot = "B") => ({ boot, asleepMs });

describe("sleptBetween", () => {
  test("the difference of one boot's stamps", () => {
    expect(sleptBetween(s(100), s(900))).toBe(800);
  });
  test("cannot tell across a reboot or without a stamp", () => {
    expect(sleptBetween(s(100), s(900, "C"))).toBeNull();
    expect(sleptBetween(null, s(900))).toBeNull();
    expect(sleptBetween(s(100), null)).toBeNull();
  });
  test("read jitter never goes negative", () => {
    expect(sleptBetween(s(100.0002), s(100))).toBe(0);
  });
});

describe("awakeBetween", () => {
  test("a 934 s nap inside a 16 min span leaves the awake time", () => {
    const span = awakeBetween(
      { wallMs: 0, sleep: s(5_000) },
      { wallMs: 960_000, sleep: s(5_000 + 934_000) },
    );
    expect(span).toEqual({
      wallMs: 960_000,
      sleptMs: 934_000,
      awakeMs: 26_000,
    });
  });
  test("where the sleep cannot be told, the wall clock judges", () => {
    expect(
      awakeBetween({ wallMs: 0, sleep: null }, { wallMs: 5_000, sleep: s(9) }),
    ).toEqual({ wallMs: 5_000, sleptMs: null, awakeMs: 5_000 });
  });
  test("a sleep is never more than the span (a wall clock stepped back)", () => {
    expect(
      awakeBetween(
        { wallMs: 1_000, sleep: s(0) },
        { wallMs: 1_500, sleep: s(2_000) },
      ),
    ).toEqual({ wallMs: 500, sleptMs: 500, awakeMs: 0 });
  });
});

test("isSleepStamp", () => {
  expect(isSleepStamp(s(1))).toBe(true);
  expect(isSleepStamp({ boot: "B" })).toBe(false);
  expect(isSleepStamp(null)).toBe(false);
});
