import { describe, expect, test } from "bun:test";
import type { SlowOpSample } from "@plugins/debug/plugins/slow-ops/core";
import type { ContentionSnapshot } from "@plugins/infra/plugins/host/plugins/contention/core";
import type {
  ClusterSlowOp as SlowOp,
  ClusterWorktree,
} from "../../shared/endpoints";
import {
  buildClusterAggregate,
  buildContentionTimeline,
  failedWorktrees,
} from "./aggregate";

function snapshot(over: Partial<ContentionSnapshot> = {}): ContentionSnapshot {
  return {
    atTime: new Date("2026-06-16T00:00:00Z"),
    loadAvg1: 10,
    loadAvg5: 9,
    loadAvg15: 8,
    cpuCount: 12,
    pgActiveBackends: 20,
    pgTotalBackends: 30,
    pgTopDatabases: [],
    ...over,
  };
}

function sample(
  atTime: string,
  over: Partial<SlowOpSample> = {},
): SlowOpSample {
  return {
    atTime: new Date(atTime),
    durationMs: 1000,
    snapshot: snapshot(),
    ...over,
  };
}

function op(over: Partial<SlowOp> = {}): SlowOp {
  return {
    id: crypto.randomUUID(),
    worktree: "wt-a",
    operationKind: "loader",
    operation: "edited-files",
    count: 1,
    totalMs: 1000,
    maxMs: 1000,
    recentSamples: [],
    lastSeenAt: new Date("2026-06-16T00:00:00Z"),
    ...over,
  };
}

function worktree(name: string, ops: SlowOp[]): ClusterWorktree {
  return { name, ok: true, ops };
}

describe("buildClusterAggregate", () => {
  test("groups same op across worktrees: sums count/totalMs, max maxMs, latest lastSeenAt", () => {
    const result = buildClusterAggregate([
      worktree("wt-a", [
        op({
          worktree: "wt-a",
          count: 2,
          totalMs: 3000,
          maxMs: 1800,
          lastSeenAt: new Date("2026-06-16T00:00:00Z"),
        }),
      ]),
      worktree("wt-b", [
        op({
          worktree: "wt-b",
          count: 5,
          totalMs: 4000,
          maxMs: 2500,
          lastSeenAt: new Date("2026-06-16T01:00:00Z"),
        }),
      ]),
    ]);

    expect(result).toHaveLength(1);
    const agg = result[0]!;
    expect(agg.count).toBe(7);
    expect(agg.totalMs).toBe(7000);
    expect(agg.maxMs).toBe(2500);
    expect(agg.lastSeenAt.toISOString()).toBe("2026-06-16T01:00:00.000Z");
  });

  test("counts the distinct set of affected worktrees (dedup, sorted)", () => {
    const result = buildClusterAggregate([
      worktree("wt-b", [op({ worktree: "wt-b" })]),
      worktree("wt-a", [op({ worktree: "wt-a" }), op({ worktree: "wt-a" })]),
    ]);
    expect(result[0]!.worktrees).toEqual(["wt-a", "wt-b"]);
  });

  test("keeps distinct ops separate and sorts by totalMs desc", () => {
    const result = buildClusterAggregate([
      worktree("wt-a", [
        op({ operation: "small", totalMs: 100 }),
        op({ operation: "big", totalMs: 9000 }),
      ]),
    ]);
    expect(result.map((a) => a.operation)).toEqual(["big", "small"]);
  });

  test("ignores failed worktrees", () => {
    const result = buildClusterAggregate([
      { name: "wt-broken", ok: false, error: "boom", ops: [] },
      worktree("wt-a", [op()]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.worktrees).toEqual(["wt-a"]);
  });
});

describe("buildContentionTimeline", () => {
  test("flattens samples across all worktrees and sorts newest first", () => {
    const result = buildContentionTimeline([
      worktree("wt-a", [
        op({
          worktree: "wt-a",
          recentSamples: [
            sample("2026-06-16T00:00:01Z"),
            sample("2026-06-16T00:00:03Z"),
          ],
        }),
      ]),
      worktree("wt-b", [
        op({
          worktree: "wt-b",
          recentSamples: [sample("2026-06-16T00:00:02Z")],
        }),
      ]),
    ]);
    expect(result.map((e) => e.atTime.toISOString())).toEqual([
      "2026-06-16T00:00:03.000Z",
      "2026-06-16T00:00:02.000Z",
      "2026-06-16T00:00:01.000Z",
    ]);
    expect(result[1]!.worktree).toBe("wt-b");
  });

  test("caps the timeline length", () => {
    const samples = Array.from({ length: 50 }, (_, i) =>
      sample(`2026-06-16T00:00:${String(i).padStart(2, "0")}Z`),
    );
    const result = buildContentionTimeline(
      [worktree("wt-a", [op({ recentSamples: samples })])],
      10,
    );
    expect(result).toHaveLength(10);
    // Newest first → the highest second value leads.
    expect(result[0]!.atTime.toISOString()).toBe("2026-06-16T00:00:49.000Z");
  });

  test("carries the contention context onto each entry", () => {
    const result = buildContentionTimeline([
      worktree("wt-a", [
        op({
          recentSamples: [
            sample("2026-06-16T00:00:01Z", {
              durationMs: 13000,
              snapshot: snapshot({
                loadAvg1: 38,
                cpuCount: 12,
                pgActiveBackends: 47,
              }),
            }),
          ],
        }),
      ]),
    ]);
    expect(result[0]!.durationMs).toBe(13000);
    expect(result[0]!.loadAvg1).toBe(38);
    expect(result[0]!.pgActiveBackends).toBe(47);
  });
});

describe("failedWorktrees", () => {
  test("lists failed worktrees with their error", () => {
    const result = failedWorktrees([
      worktree("wt-a", [op()]),
      {
        name: "wt-broken",
        ok: false,
        error: "column recent_samples does not exist",
        ops: [],
      },
    ]);
    expect(result).toEqual([
      { name: "wt-broken", error: "column recent_samples does not exist" },
    ]);
  });
});
