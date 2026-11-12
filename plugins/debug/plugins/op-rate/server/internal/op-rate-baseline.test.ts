import { describe, expect, test } from "bun:test";
import {
  BOOT_SETTLE_MS,
  BUCKET_UPPER,
  bucketOf,
  bucketUpper,
  callsPerWindow,
  hourThresholdOf,
  planTick,
  thresholdOf,
  usualCallsOf,
  usualHourCallsOf,
  utcDayStart,
  utcHourStart,
  WINDOW_MS,
  type OpHistory,
} from "./op-rate-baseline";

/** A history built from raw per-window counts, as the store would hold it. */
function historyOf(counts: readonly number[]): OpHistory {
  const buckets = new Map<number, number>();
  for (const n of counts)
    if (n > 0) buckets.set(bucketOf(n), (buckets.get(bucketOf(n)) ?? 0) + 1);
  return { windows: counts.length, buckets };
}

describe("buckets", () => {
  test("exact up to 16, then each bound at most 25% above the last", () => {
    for (let n = 1; n <= 16; n++) expect(bucketUpper(bucketOf(n))).toBe(n);
    for (let i = 16; i < BUCKET_UPPER.length; i++) {
      expect(bucketUpper(i)).toBeGreaterThan(bucketUpper(i - 1));
      expect(bucketUpper(i) / bucketUpper(i - 1)).toBeLessThanOrEqual(1.25);
    }
  });

  test("a count lands in the first bucket whose bound holds it", () => {
    for (const n of [17, 19, 20, 21, 760, 1269, 6691, 1_000_000]) {
      const b = bucketOf(n);
      expect(bucketUpper(b)).toBeGreaterThanOrEqual(n);
      expect(bucketUpper(b - 1)).toBeLessThan(n);
    }
  });

  test("refuses a count that is no window of calls", () => {
    expect(() => bucketOf(0)).toThrow();
    expect(() => bucketOf(2.5)).toThrow();
  });
});

describe("usualCallsOf", () => {
  test("windows the op was not called in count as 0", () => {
    // 1% of 1,000 windows busy: the 99th percentile is still 0.
    const counts = [
      ...Array<number>(990).fill(0),
      ...Array<number>(10).fill(500),
    ];
    expect(usualCallsOf(historyOf(counts), 0.99)).toBe(0);
    // 2% busy: the 99th percentile is the busy level (its bucket's bound).
    const busier = [
      ...Array<number>(980).fill(0),
      ...Array<number>(20).fill(500),
    ];
    const usual = usualCallsOf(historyOf(busier), 0.99);
    expect(usual).toBeGreaterThanOrEqual(500);
    expect(usual).toBeLessThanOrEqual(500 * 1.25);
  });

  test("a recurring burst is usual: streaming ~760 calls in 7% of windows", () => {
    const counts = Array.from({ length: 2016 }, (_, i) =>
      i % 14 === 0 ? 760 : 3,
    );
    expect(usualCallsOf(historyOf(counts), 0.99)).toBeGreaterThanOrEqual(760);
  });

  test("throws when the op has more called windows than the regime has windows", () => {
    expect(() =>
      usualCallsOf({ windows: 1, buckets: new Map([[bucketOf(5), 2]]) }, 0.99),
    ).toThrow();
  });
});

describe("thresholdOf", () => {
  const rule = { minCalls: 60, factor: 3 };

  test("factor × usual, never below the minimum", () => {
    expect(thresholdOf({ kind: "baseline", usualCalls: 800 }, rule)).toBe(2400);
    expect(thresholdOf({ kind: "baseline", usualCalls: 0 }, rule)).toBe(60);
    expect(thresholdOf({ kind: "baseline", usualCalls: 15 }, rule)).toBe(60);
  });

  test("the warm-up bar is the per-kind threshold as given", () => {
    expect(thresholdOf({ kind: "warm-up", threshold: 500 }, rule)).toBe(500);
  });
});

describe("callsPerWindow", () => {
  test("a stretched window is scaled down to the standard one", () => {
    expect(callsPerWindow(1000, 2 * WINDOW_MS)).toBe(500);
  });

  test("a short window (boot) is not scaled up", () => {
    expect(callsPerWindow(300, WINDOW_MS / 5)).toBe(300);
    expect(callsPerWindow(300, WINDOW_MS)).toBe(300);
  });
});

describe("planTick", () => {
  // The process started at 0; its profile's epoch is its module load, at 1 s.
  const start = 0;
  const epoch = 1_000;

  test("the process's first tick closes the boot window, counts from 0", () => {
    expect(planTick(undefined, epoch, epoch + 240_000, start)).toEqual({
      kind: "window",
      regime: "boot",
      windowMs: 240_000,
      fromZero: true,
    });
  });

  test("a later tick in the same epoch is a steady window since the last", () => {
    expect(
      planTick({ epoch, atMs: epoch + 240_000 }, epoch, epoch + 540_000, start),
    ).toEqual({
      kind: "window",
      regime: "steady",
      windowMs: 300_000,
      fromZero: false,
    });
  });

  test("the window after a first tick that came right after start is still boot", () => {
    // Started 20 s before the tick: the reconnect burst lands after it.
    const plan = planTick({ epoch, atMs: 20_000 }, epoch, 320_000, start);
    expect(plan).toMatchObject({ kind: "window", regime: "boot" });
    // The window after that starts past BOOT_SETTLE_MS: steady.
    expect(
      planTick(
        { epoch, atMs: BOOT_SETTLE_MS },
        epoch,
        BOOT_SETTLE_MS + WINDOW_MS,
        start,
      ),
    ).toMatchObject({ kind: "window", regime: "steady" });
  });

  test("a reset since the last tick (a benchmark) is not judged", () => {
    expect(
      planTick(
        { epoch, atMs: epoch + 300_000 },
        epoch + 400_000,
        epoch + 600_000,
        start,
      ).kind,
    ).toBe("unjudgeable");
  });

  test("counts spanning more than two windows from their start are not judged", () => {
    expect(planTick(undefined, epoch, epoch + 3 * WINDOW_MS, start).kind).toBe(
      "unjudgeable",
    );
  });
});

describe("the hour horizon", () => {
  const rule = { minCalls: 60, factor: 3 };

  test("usual hour is the quantile of past hours, quiet hours as 0", () => {
    const hours = [
      ...Array<number>(160).fill(0),
      100,
      200,
      300,
      400,
      500,
      600,
      700,
      800,
    ];
    // 95th of 168: rank 160 → still a quiet hour.
    expect(usualHourCallsOf(hours, 0.95)).toBe(0);
    // 170 hours: rank 162 → the second busy hour.
    expect(usualHourCallsOf([...hours, 900, 1000], 0.95)).toBe(200);
  });

  test("a bursty op's sustained doubling passes its hour bar, not its window bar", () => {
    // Windows: median ~100, 1% of windows at 1,500 → window bar ≥ 4,500.
    // Hours: ~12 × 100 plus a burst = ~2,000 usual → bar 6,000; +1,500 per
    // window sustained for an hour is ~19,000.
    expect(12 * (100 + 1500)).toBeGreaterThan(hourThresholdOf(2000, rule));
    expect(100 + 1500).toBeLessThan(
      thresholdOf({ kind: "baseline", usualCalls: 1500 }, rule),
    );
  });

  test("the hour floor is the window floor over twelve windows", () => {
    expect(hourThresholdOf(0, rule)).toBe(720);
    expect(hourThresholdOf(1000, rule)).toBe(3000);
  });

  test("throws on no past hour", () => {
    expect(() => usualHourCallsOf([], 0.95)).toThrow();
  });

  test("utcHourStart is the start of the instant's UTC hour", () => {
    expect(utcHourStart(Date.UTC(2026, 10, 12, 9, 59, 59)).toISOString()).toBe(
      "2026-11-12T09:00:00.000Z",
    );
  });
});

test("utcDayStart is the UTC midnight of the instant", () => {
  expect(utcDayStart(Date.UTC(2026, 10, 12, 23, 59)).toISOString()).toBe(
    "2026-11-12T00:00:00.000Z",
  );
});
