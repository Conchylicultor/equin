import { describe, expect, test } from "bun:test";
import { judgePagePauses } from "./page-pause-judge";
import type { SlowOpClientItem } from "../../shared/endpoints";

const item: SlowOpClientItem = {
  operationKind: "update",
  operation: "tasks",
  durationMs: 69_022,
  ownMs: 69_022,
  thresholdMs: 1000,
  waits: { transport: 68_900 },
};

describe("judgePagePauses", () => {
  test("a span the page was hidden in is dropped", () => {
    expect(judgePagePauses(item, { hidden: true, stalledMs: 0 })).toBeNull();
  });

  test("a span spent behind a frozen main thread is not slow itself", () => {
    // `update tasks took 69022ms` inside a 273 s stall (2026-10-29 audit).
    expect(
      judgePagePauses(item, { hidden: false, stalledMs: 68_500 }),
    ).toBeNull();
  });

  test("still slow after the stall: the stall is charged to its own layer", () => {
    expect(judgePagePauses(item, { hidden: false, stalledMs: 60_000 })).toEqual(
      {
        ...item,
        ownMs: 9022,
        waits: { transport: 68_900, "main-thread-stall": 60_000 },
      },
    );
  });

  test("no pause: unchanged", () => {
    expect(judgePagePauses(item, { hidden: false, stalledMs: 0 })).toBe(item);
  });
});
