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
  test("a span spent hidden is not slow itself", () => {
    expect(
      judgePagePauses(item, { hiddenMs: 68_500, stalledMs: 0 }),
    ).toBeNull();
  });

  test("a slow op spanning a brief tab switch is still judged on its visible part", () => {
    expect(judgePagePauses(item, { hiddenMs: 1, stalledMs: 0 })).toEqual({
      ...item,
      ownMs: 69_021,
      waits: { transport: 68_900, "page-hidden": 1 },
    });
  });

  test("hidden and stalled time are both taken off", () => {
    expect(
      judgePagePauses(item, { hiddenMs: 30_000, stalledMs: 30_000 }),
    ).toEqual({
      ...item,
      ownMs: 9022,
      waits: {
        transport: 68_900,
        "page-hidden": 30_000,
        "main-thread-stall": 30_000,
      },
    });
  });

  test("a span spent behind a frozen main thread is not slow itself", () => {
    // `update tasks took 69022ms` inside a 273 s stall (2026-10-29 audit).
    expect(
      judgePagePauses(item, { hiddenMs: 0, stalledMs: 68_500 }),
    ).toBeNull();
  });

  test("still slow after the stall: the stall is charged to its own layer", () => {
    expect(judgePagePauses(item, { hiddenMs: 0, stalledMs: 60_000 })).toEqual({
      ...item,
      ownMs: 9022,
      waits: { transport: 68_900, "main-thread-stall": 60_000 },
    });
  });

  test("no pause: unchanged", () => {
    expect(judgePagePauses(item, { hiddenMs: 0, stalledMs: 0 })).toBe(item);
  });
});
