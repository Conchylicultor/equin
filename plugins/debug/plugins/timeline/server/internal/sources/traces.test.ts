import { describe, expect, test } from "bun:test";
import { mapTraceRows, tracesSource, type TraceRow } from "./traces";
import type { DbSourceCtx } from "./context";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";

const T0 = Date.parse("2026-07-10T09:00:00.000Z");
const ctx = (over?: Partial<DbSourceCtx>): DbSourceCtx => ({
  dbName: "wt-a",
  isMainDb: false,
  fromMs: T0,
  toMs: T0 + 60 * 60 * 1000, // 1h window
  ...over,
});

// One row as `RawTraceRowSchema` yields it at the read boundary (snake_case,
// extracted JSON scalars).
const row = (over: Partial<TraceRow> = {}): TraceRow => ({
  id: "trace-1",
  worktree: "wt-a",
  trigger_kind: "slow-span",
  trigger_label: "GET /api/agents",
  duration_ms: 5000,
  created_at: new Date(T0 + 10 * 60 * 1000),
  wall_time: new Date(T0 + 10 * 60 * 1000).toISOString(),
  at_ms: 100_000,
  window_start_ms: 70_000,
  critical: false,
  ...over,
});

describe("mapTraceRows", () => {
  test("maps wallTime + window span to a wall-clock interval ending at wallTime", () => {
    const [ev] = mapTraceRows([row()], ctx());
    expect(ev).toBeDefined();
    expect(ev!.endMs).toBe(T0 + 10 * 60 * 1000);
    expect(ev!.startMs).toBe(ev!.endMs - 30_000); // atMs − windowStartMs
    expect(ev!.source).toBe("trace");
    expect(ev!.traceId).toBe("trace-1");
    expect(ev!.label).toBe("slow-span: GET /api/agents");
    expect(ev!.severity).toBe("warning");
    expect(ev!.detail["windowSpanMs"]).toBe(30_000);
  });

  test("critical trigger maps to error severity", () => {
    const [ev] = mapTraceRows([row({ critical: true })], ctx());
    expect(ev!.severity).toBe("error");
  });

  test("null critical (older rows) maps to warning", () => {
    const [ev] = mapTraceRows([row({ critical: null })], ctx());
    expect(ev!.severity).toBe("warning");
  });

  test("falls back to durationMs span and created_at end when snapshot scalars are null", () => {
    const [ev] = mapTraceRows(
      [row({ wall_time: null, at_ms: null, window_start_ms: null })],
      ctx(),
    );
    expect(ev!.endMs).toBe(T0 + 10 * 60 * 1000); // created_at
    expect(ev!.startMs).toBe(ev!.endMs - 5000); // duration_ms
  });

  test("drops rows whose interval does not overlap the window (created_at slack)", () => {
    // wallTime 2h after the window's end — passes the SQL pre-filter only via
    // slack, must be dropped by the exact overlap check.
    const late = row({
      wall_time: new Date(T0 + 3 * 60 * 60 * 1000).toISOString(),
      created_at: new Date(T0 + 3 * 60 * 60 * 1000),
    });
    expect(mapTraceRows([late], ctx())).toEqual([]);
  });

  test("throws on an unparseable wallTime instead of emitting garbage", () => {
    expect(() =>
      mapTraceRows([row({ wall_time: "not-a-date" })], ctx()),
    ).toThrow(/unparseable snapshot wallTime/);
  });
});

describe("tracesSource.build", () => {
  test("fork DBs scope to their own worktree; main stays unfiltered", () => {
    const fork = tracesSource.build(ctx());
    expect(fork.text).toContain("AND worktree = $3");
    expect(fork.values).toEqual([T0, T0 + 60 * 60 * 1000, "wt-a"]);
    const main = tracesSource.build(
      ctx({ dbName: MAIN_WORKTREE_NAME, isMainDb: true }),
    );
    expect(main.text).not.toContain("worktree =");
    expect(main.values).toEqual([T0, T0 + 60 * 60 * 1000]);
  });
});
