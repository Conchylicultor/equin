import { describe, it, expect } from "bun:test";
import {
  min,
  median,
  p95,
  stat,
  aggregateMode,
  buildReport,
} from "./aggregate";
import type { BootBenchRunResponse, IterResult } from "../../shared/endpoints";

describe("min", () => {
  it("returns the smallest value, order-independent", () => {
    expect(min([3, 1, 2])).toBe(1);
    expect(min([5])).toBe(5);
    expect(min([-2, 0, 4])).toBe(-2);
  });
  it("throws on empty", () => {
    expect(() => min([])).toThrow();
  });
});

describe("median", () => {
  it("odd count picks the middle", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([3, 1, 2])).toBe(2);
  });
  it("even count averages the two middles", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("single element", () => {
    expect(median([7])).toBe(7);
  });
});

describe("p95", () => {
  it("interpolates near the top", () => {
    expect(p95([0, 10])).toBeCloseTo(9.5, 10);
  });
  it("single element", () => {
    expect(p95([5])).toBe(5);
  });
  it("0..100 in steps of 10", () => {
    // 11 points, rank = 0.95 * 10 = 9.5 → between 90 and 100.
    expect(p95([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toBeCloseTo(
      95,
      10,
    );
  });
});

describe("stat", () => {
  it("bundles min/median/p95", () => {
    expect(stat([1, 2, 3])).toEqual({ min: 1, median: 2, p95: 2.9 });
  });
});

describe("aggregateMode", () => {
  const iter = (
    total: number,
    workMs: number,
    source: "memory" | "persisted" | "loader",
    loaderMs: number,
    maxMs: number,
    extra: Partial<IterResult> = {},
  ): IterResult => ({
    bootSnapshot: {
      totalMs: total,
      perKey: { "edited-files": { source, workMs } },
      persistedReadMs: total / 10,
    },
    firstSubscribe: {
      "edited-files": { onFirstSubscribeMs: 1, loaderMs },
      "commits-graph.delta": null,
    },
    eventLoop: { maxMs, p99Ms: 0, meanMs: 0 },
    runtimeProfile: { loaders: [], db: [] },
    ...extra,
  });

  it("aggregates totals, per-key, first-subscribe, and event loop", () => {
    const agg = aggregateMode([
      iter(10, 2, "loader", 5, 100),
      iter(20, 4, "loader", 7, 200),
      iter(30, 6, "loader", 9, 300),
    ]);
    expect(agg.iterations).toBe(3);
    expect(agg.bootSnapshotTotalMs.median).toBe(20);
    expect(agg.bootSnapshotPersistedReadMs.median).toBe(2);
    expect(agg.bootSnapshotPerKey["edited-files"]!.source).toBe("loader");
    expect(agg.bootSnapshotPerKey["edited-files"]!.workMs.min).toBe(2);
    expect(agg.firstSubscribe["edited-files"]!.loaderMs.median).toBe(7);
    // A target null in every iteration aggregates to null, not a crash.
    expect(agg.firstSubscribe["commits-graph.delta"]).toBeNull();
    expect(agg.eventLoopMaxMs.p95).toBeCloseTo(290, 10);
  });

  it("marks a per-key source mixed when it varies across iterations", () => {
    const agg = aggregateMode([
      iter(10, 2, "loader", 5, 100),
      iter(10, 2, "persisted", 5, 100),
    ]);
    expect(agg.bootSnapshotPerKey["edited-files"]!.source).toBe("mixed");
  });

  it("unions loaders/db by label with per-layer wait Stats", () => {
    const agg = aggregateMode([
      iter(10, 2, "loader", 5, 100, {
        runtimeProfile: {
          loaders: [
            {
              label: "edited-files",
              count: 1,
              avgMs: 100,
              selfMs: 20,
              childMs: 0,
              maxMs: 120,
              waits: { "heavy-read-acquire": 80 },
            },
          ],
          db: [
            {
              label: "SELECT pushes",
              count: 2,
              avgMs: 3,
              selfMs: 3,
              childMs: 0,
              maxMs: 5,
            },
          ],
        },
      }),
      // Second iteration lacks the db label and adds a second loader label, so the
      // union must keep both and aggregate each over only the iterations it appears.
      iter(20, 4, "loader", 7, 200, {
        runtimeProfile: {
          loaders: [
            {
              label: "edited-files",
              count: 1,
              avgMs: 200,
              selfMs: 40,
              childMs: 0,
              maxMs: 220,
              waits: { "heavy-read-acquire": 160, "heavy-read-local": 10 },
            },
            {
              label: "commits-graph.graph",
              count: 1,
              avgMs: 50,
              selfMs: 40,
              childMs: 10,
              maxMs: 50,
            },
          ],
          db: [],
        },
      }),
    ]);

    const edited = agg.loaders["edited-files"]!;
    expect(edited.avgMs.median).toBe(150);
    expect(edited.selfMs.min).toBe(20);
    expect(edited.childMs.median).toBe(0);
    expect(agg.loaders["commits-graph.graph"]!.childMs.median).toBe(10);
    // heavy-read-acquire appeared in both iterations; heavy-read-local in only one.
    expect(edited.waits["heavy-read-acquire"]!.median).toBe(120);
    expect(edited.waits["heavy-read-local"]!.min).toBe(10);
    // A label present in only one iteration is still surfaced (union-by-label).
    expect(agg.loaders["commits-graph.graph"]!.avgMs.median).toBe(50);
    expect(agg.db["SELECT pushes"]!.avgMs.median).toBe(3);
  });

  it("carries the load summary when iterations ran under a host-gate load", () => {
    const agg = aggregateMode([
      iter(10, 2, "loader", 5, 100, {
        load: { concurrency: 4, peakGateWaitMs: 300 },
      }),
      iter(20, 4, "loader", 7, 200, {
        load: { concurrency: 4, peakGateWaitMs: 500 },
      }),
    ]);
    expect(agg.load!.concurrency).toBe(4);
    expect(agg.load!.peakGateWaitMs.median).toBe(400);
  });

  it("omits the load summary for an isolated set", () => {
    const agg = aggregateMode([iter(10, 2, "loader", 5, 100)]);
    expect(agg.load).toBeUndefined();
  });

  it("throws on an empty iteration set", () => {
    expect(() => aggregateMode([])).toThrow();
  });
});

describe("buildReport", () => {
  const res: BootBenchRunResponse = {
    fixtures: { conversationId: "c1", attemptId: "a1" },
    runs: {
      warm: [
        {
          bootSnapshot: {
            totalMs: 10,
            perKey: { "edited-files": { source: "persisted", workMs: 1 } },
            persistedReadMs: 9,
          },
          firstSubscribe: {
            "edited-files": { onFirstSubscribeMs: 1, loaderMs: 2 },
          },
          eventLoop: { maxMs: 5, p99Ms: 0, meanMs: 0 },
          runtimeProfile: { loaders: [], db: [] },
        },
      ],
    },
    snapshotBloat: {
      warm: { tableBytes: 12345, deadTuples: 678, liveTuples: 9 },
    },
    snapshotBytes: {
      warm: {
        total: { raw: 1000, gzip: 200 },
        perKey: { notifications: { raw: 600, gzip: 120 } },
        rowKeyBytes: { notifications: 42 },
      },
    },
  };

  it("passes each mode's snapshotBloat through onto the aggregate", () => {
    const report = buildReport(res);
    expect(report.modes.warm!.snapshotBloat).toEqual({
      tableBytes: 12345,
      deadTuples: 678,
      liveTuples: 9,
    });
    expect(report.modes.warm!.bootSnapshotPersistedReadMs.median).toBe(9);
    expect(report.modes.cold).toBeUndefined();
  });

  it("passes each mode's snapshotBytes through onto the aggregate", () => {
    const report = buildReport(res);
    expect(report.modes.warm!.snapshotBytes).toEqual({
      total: { raw: 1000, gzip: 200 },
      perKey: { notifications: { raw: 600, gzip: 120 } },
      rowKeyBytes: { notifications: 42 },
    });
  });

  it("leaves snapshotBytes off a mode the response carries none for", () => {
    const older: BootBenchRunResponse = { ...res, snapshotBytes: undefined };
    expect(buildReport(older).modes.warm!.snapshotBytes).toBeUndefined();
  });
});
