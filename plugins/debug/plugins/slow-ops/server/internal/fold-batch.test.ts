import { describe, test, expect } from "bun:test";
import type { ContentionSnapshot } from "@plugins/infra/plugins/host/plugins/contention/server";
import { VARIANT_CAP, type SlowOpSample } from "../../core";
import { foldSlowOpBatch, mergeSample, type FoldItem } from "./fold-batch";
import type { RecordSlowOpInput } from "./input";

const T0 = new Date("2026-07-11T03:30:00.000Z");
const T1 = new Date("2026-07-11T03:32:00.000Z");
const T2 = new Date("2026-07-11T03:34:00.000Z");

const snapshot = (atTime: Date): ContentionSnapshot => ({
  atTime,
  loadAvg1: 1,
  loadAvg5: 1,
  loadAvg15: 1,
  cpuCount: 8,
  pgActiveBackends: 1,
  pgTotalBackends: 2,
  pgTopDatabases: [],
});

const item = (
  occurredAt: Date,
  over: Partial<RecordSlowOpInput> = {},
): FoldItem => ({
  occurredAt,
  input: {
    operationKind: "loader",
    operation: "test-op",
    durationMs: 100,
    thresholdMs: 50,
    source: "server-slow-op",
    ...over,
  },
});

describe("mergeSample", () => {
  test("stamps the sample at its occurredAt, not the write instant", () => {
    const [newest] = mergeSample([], snapshot(T1), 100, undefined, T1);
    expect(newest?.atTime).toBe(T1);
  });

  test("an older replayed sample sorts behind an already-present newer one", () => {
    const ring = mergeSample([], snapshot(T2), 100, undefined, T2);
    const merged = mergeSample(ring, snapshot(T1), 200, undefined, T1);
    expect(merged.map((s) => s.atTime)).toEqual([T2, T1]);
  });

  test("orders against jsonb-round-tripped entries whose atTime is an ISO string", () => {
    // A sample read back from the jsonb column carries atTime as an ISO
    // string at runtime despite the Date-typed schema — the sort must
    // normalize both representations.
    const persisted = [
      { atTime: T2.toISOString(), durationMs: 100, snapshot: snapshot(T2) },
    ] as unknown as SlowOpSample[];
    const merged = mergeSample(persisted, snapshot(T1), 200, undefined, T1);
    expect(merged.map((s) => new Date(s.atTime).getTime())).toEqual([
      T2.getTime(),
      T1.getTime(),
    ]);
  });

  test("caps the ring at the newest 10 by time, dropping the oldest", () => {
    let ring: SlowOpSample[] = [];
    for (let i = 0; i < 10; i++) {
      const at = new Date(T1.getTime() + (i + 1) * 1000);
      ring = mergeSample(ring, snapshot(at), 100, undefined, at);
    }
    // A replayed sample older than everything in a full ring is not among the
    // newest 10 — it drops instead of evicting a newer entry.
    const merged = mergeSample(ring, snapshot(T0), 200, undefined, T0);
    expect(merged).toHaveLength(10);
    expect(
      merged.some((s) => new Date(s.atTime).getTime() === T0.getTime()),
    ).toBe(false);
  });
});

describe("foldSlowOpBatch", () => {
  test("one row per op, every item counted, rows sorted by key", () => {
    const { ops } = foldSlowOpBatch(
      [
        item(T1, { operation: "op-b", durationMs: 100 }),
        item(T1, { operation: "op-a", durationMs: 50 }),
        item(T2, { operation: "op-b", durationMs: 300 }),
      ],
      snapshot(T1),
      "wt",
    );
    expect(ops.map((o) => [o.operation, o.count, o.totalMs, o.maxMs])).toEqual([
      ["op-a", 1, 50, 50],
      ["op-b", 2, 400, 300],
    ]);
    expect(ops.every((o) => o.worktree === "wt")).toBe(true);
  });

  test("first/last seen span the batch and last-* attribution is the newest occurrence's", () => {
    // Arrival order is not time order (a duress replay): the newest wins.
    const [op] = foldSlowOpBatch(
      [
        item(T2, { durationMs: 100, thresholdMs: 50 }),
        item(T1, { durationMs: 200, thresholdMs: 75 }),
      ],
      snapshot(T1),
      "wt",
    ).ops;
    expect(op?.firstSeenAt).toEqual(T1);
    expect(op?.lastSeenAt).toEqual(T2);
    expect(op?.lastMs).toBe(100);
    expect(op?.thresholdMs).toBe(50);
    expect(op?.recentSamples.map((s) => s.atTime)).toEqual([T2, T1]);
  });

  test("a tie in time gives last-* attribution to the later arrival", () => {
    const [op] = foldSlowOpBatch(
      [item(T1, { durationMs: 100 }), item(T1, { durationMs: 200 })],
      snapshot(T1),
      "wt",
    ).ops;
    expect(op?.lastMs).toBe(200);
  });

  test("callers fold per (op, caller) and an item without one counts on its op only", () => {
    const { ops, callers } = foldSlowOpBatch(
      [
        item(T1, { caller: { kind: "route", label: "/b" }, durationMs: 10 }),
        item(T2, { caller: { kind: "route", label: "/a" }, durationMs: 20 }),
        item(T1, { caller: { kind: "route", label: "/b" }, durationMs: 30 }),
        item(T1, { caller: null }),
      ],
      snapshot(T1),
      "wt",
    );
    expect(ops[0]?.count).toBe(4);
    expect(
      callers.map((c) => [c.callerLabel, c.count, c.totalMs, c.maxMs]),
    ).toEqual([
      ["/a", 1, 20, 20],
      ["/b", 2, 40, 30],
    ]);
  });

  test("variants are bounded even on the batch that creates the row", () => {
    const items = Array.from({ length: VARIANT_CAP + 5 }, (_, i) =>
      item(T1, { durationMs: 100 + i, detail: { variant: `v${i}` } }),
    );
    const [op] = foldSlowOpBatch(items, snapshot(T1), "wt").ops;
    expect(op?.variants).toHaveLength(VARIANT_CAP + 1);
    expect(op?.variants.reduce((a, v) => a + v.count, 0)).toBe(items.length);
  });

  test("waits sum per layer and measures keep the larger max and the latest last", () => {
    const [op] = foldSlowOpBatch(
      [
        item(T1, {
          waits: { gate: 10 },
          detail: { measures: { subscribers: 40 } },
        }),
        item(T1, {
          waits: { gate: 5, lock: 1 },
          detail: { measures: { subscribers: 12 } },
        }),
      ],
      snapshot(T1),
      "wt",
    ).ops;
    expect(op?.waits).toEqual({ gate: 15, lock: 1 });
    expect(op?.measures).toEqual({ subscribers: { max: 40, last: 12 } });
  });
});
