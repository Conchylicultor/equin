/**
 * The batch write against a real Postgres (db-test-fixture, seeded with the
 * REAL migration chain): a folded batch is ONE upsert per table through the
 * change producers, with every list merge in SQL (merge-sql.ts). The suite
 * pins the semantics the recorder documents — shed-replay timestamp honesty
 * (research/2026-07-11-global-observability-freeze-blind-spots.md), batch
 * accumulation, per-caller rows — and checks the SQL merges against an oracle:
 * the pre-batching per-item merge, applied one item at a time in JS.
 *
 * Run: `./singularity test plugins/debug/plugins/slow-ops`
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import {
  flushNow,
  mountProducersForTest,
} from "@plugins/database/plugins/change-feed/server/testing";
import type { routeChange } from "@plugins/database/plugins/change-feed/server";
import type { ContentionSnapshot } from "@plugins/infra/plugins/host/plugins/contention/server";
import type {
  SlowOpMeasures,
  SlowOpSample,
  VariantBreakdown,
} from "../../core";
import {
  foldSlowOpBatch,
  mergeSample,
  mergeWaits,
  type FoldItem,
} from "./fold-batch";
import type { RecordSlowOpInput } from "./input";
import { mergeMeasures, mergeVariant } from "./merge-detail";
import { slowOpCallersProducer, slowOpsProducer } from "./producer";
import { writeSlowOpRows } from "./record-slow-op";
import { _slowOpCallers, _slowOps } from "./tables";

const T0 = new Date("2026-07-11T03:30:00.000Z");
const T1 = new Date("2026-07-11T03:32:00.000Z");
const T2 = new Date("2026-07-11T03:34:00.000Z");
const WT = "wt-test";

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

describe("writeSlowOpRows (real DB)", () => {
  let t: TestDb;
  let routed: Parameters<typeof routeChange>[0][] = [];
  let unmount: () => void;

  // One batch, as recordSlowOpBatch writes it (one snapshot per batch).
  const write = async (items: FoldItem[], at = T1): Promise<void> => {
    await writeSlowOpRows(foldSlowOpBatch(items, snapshot(at), WT), t.db);
  };

  const readOps = () => t.db.select().from(_slowOps);
  const readOne = async () => {
    const rows = await readOps();
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };
  const readCallers = () => t.db.select().from(_slowOpCallers);

  beforeAll(async () => {
    t = await createTestDb({ prefix: "slowop_test" });
    await runMigrations(t.db);
    unmount = mountProducersForTest([slowOpsProducer, slowOpCallersProducer], {
      route: (change) => routed.push(change),
    });
  });

  afterAll(async () => {
    unmount();
    await t.drop();
  });

  beforeEach(async () => {
    await t.db.execute(sql`DELETE FROM slow_ops`);
    await t.db.execute(sql`DELETE FROM slow_op_callers`);
    flushNow(slowOpsProducer);
    flushNow(slowOpCallersProducer);
    routed = [];
  });

  test("a shed-then-replayed op lands at its original occurredAt, not write time", async () => {
    // T1 is minutes in the past relative to the write — exactly a duress-shed
    // item replayed after the episode cleared.
    await write([item(T1)]);

    const row = await readOne();
    expect(row.firstSeenAt.getTime()).toBe(T1.getTime());
    expect(row.lastSeenAt.getTime()).toBe(T1.getTime());
    expect(new Date(row.recentSamples[0]!.atTime).getTime()).toBe(T1.getTime());
  });

  test("an out-of-order replay never regresses timestamps or clobbers last-* attribution", async () => {
    // A live op lands first (T2), then an in-freeze item from EARLIER (T1)
    // replays after it — the interleaving the flush can produce.
    await write([item(T2, { durationMs: 100, thresholdMs: 50 })]);
    await write([item(T1, { durationMs: 200, thresholdMs: 75 })]);

    const row = await readOne();
    expect(row.count).toBe(2);
    expect(row.totalMs).toBe(300);
    expect(row.maxMs).toBe(200);
    expect(row.lastSeenAt.getTime()).toBe(T2.getTime());
    expect(row.firstSeenAt.getTime()).toBe(T1.getTime());
    expect(row.lastMs).toBe(100);
    expect(row.thresholdMs).toBe(50);
    expect(row.recentSamples.map((s) => new Date(s.atTime).getTime())).toEqual([
      T2.getTime(),
      T1.getTime(),
    ]);
  });

  test("a genuinely newer occurrence advances last_seen_at and takes over last-* attribution", async () => {
    await write([item(T1, { durationMs: 200, thresholdMs: 75 })]);
    await write([item(T2, { durationMs: 100, thresholdMs: 50 })]);

    const row = await readOne();
    expect(row.lastSeenAt.getTime()).toBe(T2.getTime());
    expect(row.firstSeenAt.getTime()).toBe(T1.getTime());
    expect(row.lastMs).toBe(100);
    expect(row.thresholdMs).toBe(50);
  });

  test("distinct operations in one batch each get their own row", async () => {
    await write([
      item(T1, { operation: "op-a" }),
      item(T1, { operation: "op-b" }),
    ]);

    const rows = await readOps();
    expect(rows.map((r) => r.operation).sort()).toEqual(["op-a", "op-b"]);
    for (const row of rows) expect(row.count).toBe(1);
  });

  test("repeats of one operation in one batch accumulate onto one row", async () => {
    await write([item(T1, { durationMs: 100 }), item(T2, { durationMs: 300 })]);

    const row = await readOne();
    expect(row.count).toBe(2);
    expect(row.totalMs).toBe(400);
    expect(row.maxMs).toBe(300);
    expect(row.lastMs).toBe(300);
    expect(row.recentSamples.map((s) => new Date(s.atTime).getTime())).toEqual([
      T2.getTime(),
      T1.getTime(),
    ]);
  });

  // Every caller keeps its own row, accumulated across batches — no cap.
  test("each (op, caller) is one additive row across batches", async () => {
    await write([
      item(T1, { caller: { kind: "route", label: "/a" }, durationMs: 10 }),
      item(T1, { caller: { kind: "route", label: "/b" }, durationMs: 20 }),
    ]);
    await write([
      item(T2, { caller: { kind: "route", label: "/a" }, durationMs: 40 }),
      item(T2, { caller: null }),
    ]);

    expect((await readOne()).count).toBe(4);
    const callers = await readCallers();
    expect(
      callers.map((c) => [c.callerLabel, c.count, c.totalMs, c.maxMs]).sort(),
    ).toEqual([
      ["/a", 2, 50, 40],
      ["/b", 1, 20, 20],
    ]);
    const a = callers.find((c) => c.callerLabel === "/a")!;
    expect(a.firstSeenAt.getTime()).toBe(T1.getTime());
    expect(a.lastSeenAt.getTime()).toBe(T2.getTime());
  });

  test("hundreds of callers on one op all stay named", async () => {
    const items = Array.from({ length: 300 }, (_, i) =>
      item(T1, { caller: { kind: "route", label: `/c/${i}` } }),
    );
    await write(items);
    expect(await readCallers()).toHaveLength(300);
  });

  test("the variant bound holds on the batch that creates the row and on the merge", async () => {
    const batch = (from: number) =>
      Array.from({ length: 15 }, (_, i) =>
        item(T1, {
          durationMs: 100 + from + i,
          detail: { variant: `v${from + i}` },
        }),
      );
    await write(batch(0));
    expect((await readOne()).variants).toHaveLength(11);
    await write(batch(100));
    const row = await readOne();
    expect(row.variants).toHaveLength(11);
    expect(row.variants.at(-1)?.variant).toBe("(other)");
    expect(row.variants.reduce((a, v) => a + v.count, 0)).toBe(30);
  });

  test("each write routes the ids it touched, coalesced to one flush", async () => {
    await write([
      item(T1, { operation: "op-a", caller: { kind: "route", label: "/a" } }),
    ]);
    await write([item(T1, { operation: "op-b" })]);
    expect(routed).toEqual([]); // coalesced: nothing routes before the window

    flushNow(slowOpsProducer);
    flushNow(slowOpCallersProducer);
    const ops = await readOps();
    const callers = await readCallers();
    const byTable = new Map(routed.map((c) => [c.table, c]));
    expect([...(byTable.get("slow_ops")?.ids ?? [])].sort()).toEqual(
      ops.map((r) => r.id).sort(),
    );
    expect(byTable.get("slow_op_callers")?.ids).toEqual([callers[0]!.id]);
  });

  // Two backends write the same ops at once during a hot swap. Each batch is
  // sorted by key, so both take the row locks in the same order.
  test("concurrent overlapping batches complete and both count", async () => {
    const ops = ["op-a", "op-b", "op-c", "op-d"];
    const batch = (order: string[]) =>
      order.map((operation) =>
        item(T1, { operation, caller: { kind: "route", label: "/x" } }),
      );
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        write(batch(i % 2 === 0 ? ops : [...ops].reverse())),
      ),
    );
    const rows = await readOps();
    expect(rows.map((r) => r.count)).toEqual([6, 6, 6, 6]);
    expect((await readCallers()).map((c) => c.count)).toEqual([6, 6, 6, 6]);
  });

  // The oracle: random occurrences, split into random batches, written through
  // fold + SQL merge, must equal the pre-batching per-item merge applied one
  // item at a time in arrival order.
  test("fold + SQL merge equals the per-item merge, over random batches", async () => {
    const rand = mulberry32(42);
    for (let round = 0; round < 8; round++) {
      await t.db.execute(sql`DELETE FROM slow_ops`);
      await t.db.execute(sql`DELETE FROM slow_op_callers`);

      const items: FoldItem[] = Array.from({ length: 60 }, (_, i) => {
        const pick = <T>(xs: readonly T[]): T =>
          xs[Math.floor(rand() * xs.length)]!;
        const at = new Date(T0.getTime() + Math.floor(rand() * 600) * 1000 + i);
        return item(at, {
          operation: pick(["op-a", "op-b", "op-c"]),
          durationMs: 10 + Math.floor(rand() * 500),
          thresholdMs: pick([50, 75]),
          caller:
            rand() < 0.2
              ? null
              : { kind: "route", label: pick(["/a", "/b", "/c", "/d"]) },
          waits: rand() < 0.5 ? { [pick(["g1", "g2"])]: 5 } : undefined,
          detail: {
            ...(rand() < 0.6 ? { variant: pick(["v1", "v2", "v3"]) } : {}),
            ...(rand() < 0.5
              ? { measures: { subscribers: Math.floor(rand() * 100) } }
              : {}),
          },
        });
      });

      for (let i = 0; i < items.length;) {
        const n = 1 + Math.floor(rand() * 12);
        await write(items.slice(i, i + n), items[i]!.occurredAt);
        i += n;
      }

      const expected = sequentialOracle(items);
      const rows = await readOps();
      expect(rows).toHaveLength(expected.ops.size);
      for (const row of rows) {
        const want = expected.ops.get(row.operation)!;
        expect(row.count).toBe(want.count);
        expect(row.totalMs).toBe(want.totalMs);
        expect(row.maxMs).toBe(want.maxMs);
        expect(row.lastMs).toBe(want.lastMs);
        expect(row.thresholdMs).toBe(want.thresholdMs);
        expect(row.firstSeenAt.getTime()).toBe(want.firstSeenAt.getTime());
        expect(row.lastSeenAt.getTime()).toBe(want.lastSeenAt.getTime());
        expect(row.waits).toEqual(want.waits);
        expect(row.measures).toEqual(want.measures);
        expect(sortVariants(row.variants)).toEqual(sortVariants(want.variants));
        expect(
          row.recentSamples.map((s) => [
            new Date(s.atTime).getTime(),
            s.durationMs,
          ]),
        ).toEqual(
          want.recentSamples.map((s) => [
            new Date(s.atTime).getTime(),
            s.durationMs,
          ]),
        );
      }
      const callers = await readCallers();
      expect(
        callers
          .map(
            (c) =>
              `${c.operation}|${c.callerLabel}|${c.count}|${c.totalMs}|${c.maxMs}`,
          )
          .sort(),
      ).toEqual([...expected.callers].sort());
    }
  });
});

// The per-item merge the recorder ran before batching (one read-modify-write
// per occurrence), kept here as the oracle the batch write must match.
function sequentialOracle(items: FoldItem[]) {
  interface Row {
    count: number;
    totalMs: number;
    maxMs: number;
    lastMs: number;
    thresholdMs: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
    waits: Record<string, number>;
    recentSamples: SlowOpSample[];
    variants: VariantBreakdown[];
    measures: SlowOpMeasures;
  }
  const ops = new Map<string, Row>();
  const callers = new Map<string, [number, number, number]>();
  for (const { input, occurredAt } of items) {
    const d = input.durationMs;
    let row = ops.get(input.operation);
    if (!row) {
      row = {
        count: 1,
        totalMs: d,
        maxMs: d,
        lastMs: d,
        thresholdMs: input.thresholdMs,
        firstSeenAt: occurredAt,
        lastSeenAt: occurredAt,
        waits: {},
        recentSamples: [],
        variants: [],
        measures: {},
      };
      ops.set(input.operation, row);
    } else {
      const newest = occurredAt.getTime() >= row.lastSeenAt.getTime();
      row.count += 1;
      row.totalMs += d;
      row.maxMs = Math.max(row.maxMs, d);
      if (newest) {
        row.lastMs = d;
        row.thresholdMs = input.thresholdMs;
        row.lastSeenAt = occurredAt;
      }
      if (occurredAt < row.firstSeenAt) row.firstSeenAt = occurredAt;
    }
    if (input.waits) row.waits = mergeWaits(row.waits, input.waits);
    row.recentSamples = mergeSample(
      row.recentSamples,
      snapshot(occurredAt),
      d,
      input.traceId,
      occurredAt,
      input.detail,
    );
    if (input.detail?.variant !== undefined) {
      row.variants = mergeVariant(row.variants, input.detail.variant, d);
    }
    if (input.detail?.measures) {
      row.measures = mergeMeasures(row.measures, input.detail.measures);
    }
    if (input.caller) {
      const key = `${input.operation}|${input.caller.label}`;
      const c = callers.get(key) ?? [0, 0, 0];
      callers.set(key, [c[0] + 1, c[1] + d, Math.max(c[2], d)]);
    }
  }
  return {
    ops,
    callers: [...callers].map(([k, [n, tot, mx]]) => `${k}|${n}|${tot}|${mx}`),
  };
}

const sortVariants = (vs: VariantBreakdown[]) =>
  [...vs].sort((a, b) => a.variant.localeCompare(b.variant));

// A seeded PRNG, so a failing round reproduces.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
