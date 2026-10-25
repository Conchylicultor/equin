import { describe, expect, test } from "bun:test";
import { mapSlowOpRows, slowOpsSource, type SlowOpRow } from "./slow-ops";
import type { DbSourceCtx } from "./context";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";

const T0 = Date.parse("2026-07-10T09:00:00.000Z");
const ctx: DbSourceCtx = {
  dbName: "wt-a",
  isMainDb: false,
  fromMs: T0,
  toMs: T0 + 60 * 60 * 1000,
};

const snapshot = {
  atTime: new Date(T0 + 5 * 60 * 1000),
  loadAvg1: 12,
  loadAvg5: 8,
  loadAvg15: 6,
  cpuCount: 10,
  pgActiveBackends: 40,
  pgTotalBackends: 80,
  pgTopDatabases: [],
};

const sample = (atMs: number, durationMs: number, traceId?: string) => ({
  atTime: new Date(atMs),
  durationMs,
  snapshot,
  ...(traceId ? { traceId } : {}),
});

// A row as `RawSlowOpRowSchema` yields it at the read boundary — the ring's
// samples are already parsed, so their `atTime`s are Dates.
const row = (
  samples: SlowOpRow["recent_samples"],
  over: Partial<SlowOpRow> = {},
): SlowOpRow => ({
  id: "op-1",
  worktree: "wt-a",
  operation_kind: "http",
  operation: "GET /agents",
  threshold_ms: 3000,
  recent_samples: samples,
  ...over,
});

describe("mapSlowOpRows", () => {
  test("expands each ring sample into an interval [atTime − durationMs, atTime]", () => {
    const at = T0 + 5 * 60 * 1000;
    const events = mapSlowOpRows([row([sample(at, 4000, "tr-9")])], ctx);
    expect(events.length).toBe(1);
    expect(events[0]!.startMs).toBe(at - 4000);
    expect(events[0]!.endMs).toBe(at);
    expect(events[0]!.label).toBe("http GET /agents");
    expect(events[0]!.traceId).toBe("tr-9");
    expect(events[0]!.severity).toBe("warning");
  });

  test("a sample at ≥5× its row threshold is an error (the 471s page load)", () => {
    const at = T0 + 5 * 60 * 1000;
    const events = mapSlowOpRows([row([sample(at, 471_000)])], ctx);
    expect(events[0]!.severity).toBe("error");
    expect(events[0]!.traceId).toBeUndefined();
  });

  test("drops samples outside the window but keeps the overlapping ones", () => {
    const inside = sample(T0 + 10 * 60 * 1000, 2000);
    const before = sample(T0 - 60 * 60 * 1000, 2000);
    const after = sample(T0 + 2 * 60 * 60 * 1000, 2000);
    // Straddles the left edge: ends 1s after fromMs, started 5s before.
    const straddling = sample(T0 + 1000, 6000);
    const events = mapSlowOpRows(
      [row([before, inside, after, straddling])],
      ctx,
    );
    expect(events.map((e) => e.endMs)).toEqual([
      T0 + 10 * 60 * 1000,
      T0 + 1000,
    ]);
  });

  test("event ids are unique per sample within a row", () => {
    const a = sample(T0 + 60_000, 1000);
    const b = sample(T0 + 120_000, 1000);
    const ids = mapSlowOpRows([row([a, b])], ctx).map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("slowOpsSource.build", () => {
  test("fork DBs scope to their own worktree; main stays unfiltered", () => {
    const fork = slowOpsSource.build(ctx);
    expect(fork.text).toContain("AND worktree = $2");
    expect(fork.values).toEqual([T0, "wt-a"]);
    const main = slowOpsSource.build({
      ...ctx,
      dbName: MAIN_WORKTREE_NAME,
      isMainDb: true,
    });
    expect(main.text).not.toContain("worktree =");
    expect(main.values).toEqual([T0]);
  });
});
