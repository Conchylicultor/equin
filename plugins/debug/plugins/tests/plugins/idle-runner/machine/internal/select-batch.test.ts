import { describe, expect, test } from "bun:test";
import {
  IDLE_BATCH_BUDGET_MS,
  IDLE_BATCH_MAX_FILES,
  REVERIFY_AFTER_MS,
  selectIdleBatch,
  type BatchCandidate,
} from "./select-batch";

const NOW = Date.parse("2026-11-11T10:00:00Z");
const DAY = 24 * 60 * 60_000;

function c(
  path: string,
  status: BatchCandidate["status"],
  opts: Partial<Omit<BatchCandidate, "path" | "status">> = {},
): BatchCandidate {
  return {
    path,
    status,
    lastOutcome: status === "never" ? null : "passed",
    lastRanAt: status === "never" ? null : new Date(NOW - DAY),
    durationMs: status === "never" ? null : 1_000,
    ...opts,
  };
}

describe("selectIdleBatch", () => {
  test("stale-and-last-failing, then never run, then stale oldest first", () => {
    const batch = selectIdleBatch(
      [
        c("stale-new.test.ts", "stale", { lastRanAt: new Date(NOW - DAY) }),
        c("passing.test.ts", "passing"),
        c("never-b.test.ts", "never"),
        c("stale-failed.test.ts", "stale", { lastOutcome: "failed" }),
        c("stale-old.test.ts", "stale", { lastRanAt: new Date(NOW - 5 * DAY) }),
        c("never-a.test.ts", "never"),
        c("stale-not-loaded.test.ts", "stale", {
          lastOutcome: "not-loaded",
          lastRanAt: new Date(NOW - 3 * DAY),
        }),
        c("failing.test.ts", "failing", { lastOutcome: "failed" }),
      ],
      NOW,
    );
    expect(batch).toEqual([
      "stale-not-loaded.test.ts",
      "stale-failed.test.ts",
      "never-a.test.ts",
      "never-b.test.ts",
      "stale-old.test.ts",
      "stale-new.test.ts",
    ]);
  });

  test("current verdicts are re-run only once nothing stale or never-run is left, and only past a week", () => {
    const old = c("old.test.ts", "passing", {
      lastRanAt: new Date(NOW - REVERIFY_AFTER_MS - DAY),
    });
    const older = c("older.test.ts", "failing", {
      lastOutcome: "failed",
      lastRanAt: new Date(NOW - REVERIFY_AFTER_MS - 3 * DAY),
    });
    const recent = c("recent.test.ts", "passing", {
      lastRanAt: new Date(NOW - DAY),
    });
    expect(selectIdleBatch([old, recent, older], NOW)).toEqual([
      "older.test.ts",
      "old.test.ts",
    ]);
    expect(
      selectIdleBatch([old, recent, c("never.test.ts", "never")], NOW),
    ).toEqual(["never.test.ts"]);
  });

  test("nothing worth running is an empty batch", () => {
    expect(selectIdleBatch([c("a.test.ts", "passing")], NOW)).toEqual([]);
    expect(selectIdleBatch([], NOW)).toEqual([]);
  });

  test("a batch stops at the file cap", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      c(`f${String(i).padStart(2, "0")}.test.ts`, "never", { durationMs: 10 }),
    );
    expect(selectIdleBatch(many, NOW)).toHaveLength(IDLE_BATCH_MAX_FILES);
  });

  test("a batch stops once its last-known durations reach the budget, a file taken whole", () => {
    const slow = (i: number) =>
      c(`slow${i}.test.ts`, "stale", {
        durationMs: IDLE_BATCH_BUDGET_MS / 2 - 1,
        lastRanAt: new Date(NOW - (10 - i) * DAY),
      });
    expect(selectIdleBatch([slow(1), slow(2), slow(3), slow(4)], NOW)).toEqual([
      "slow1.test.ts",
      "slow2.test.ts",
      "slow3.test.ts",
    ]);
    const huge = c("huge.test.ts", "stale", {
      durationMs: 5 * IDLE_BATCH_BUDGET_MS,
    });
    expect(selectIdleBatch([huge], NOW)).toEqual(["huge.test.ts"]);
    expect(selectIdleBatch([huge, slow(1)], NOW)).toEqual([
      "slow1.test.ts",
      "huge.test.ts",
    ]);
    expect(selectIdleBatch([huge, slow(1), slow(2)], NOW)).toEqual([
      "slow1.test.ts",
      "slow2.test.ts",
      "huge.test.ts",
    ]);
  });
});
