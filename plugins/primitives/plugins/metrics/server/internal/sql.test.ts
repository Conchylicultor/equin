/**
 * sqlFlow / sqlLevel against a real Postgres: the interval join, the split
 * grouping, the fill of empty cells, and a distinct count over the range.
 *
 * Requires the running embedded cluster (`./equin build` first);
 * `createTestDb` throws loudly rather than skipping when it is not up.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { resolveRange, type Interval } from "../../core/intervals";
import { sqlFlow, sqlLevel } from "./sql";

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test, so awaiting it
 * trips await-thenable.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

let t: TestDb;

const NOW = new Date("2026-09-30T15:00:00Z");
// Four day buckets (27th … 30th, the last partial), then the range.
const r = resolveRange(
  {
    interval: { start: "2026-09-27T00:00:00Z", end: "2026-10-05T00:00:00Z" },
    bucket: "day",
  },
  NOW,
  "UTC",
);
const intervals: Interval[] = [...r.buckets, r.range];

beforeAll(async () => {
  t = await createTestDb({ prefix: "metrics_sql" });
  await t.db.execute(sql`
    CREATE TABLE events (at timestamptz NOT NULL, kind text, who text NOT NULL, amount int NOT NULL)`);
  await t.db.execute(sql`
    INSERT INTO events (at, kind, who, amount) VALUES
      ('2026-09-26T23:59:59Z', 'a', 'ann', 100),  -- before the range
      ('2026-09-27T00:00:00Z', 'a', 'ann', 1),    -- on the first boundary: in
      ('2026-09-27T12:00:00Z', 'b', 'bob', 2),
      ('2026-09-28T00:00:00Z', NULL, 'ann', 3),   -- no kind
      ('2026-09-30T10:00:00Z', 'a', 'bob', 4),
      ('2026-09-30T16:00:00Z', 'a', 'cid', 100)   -- after now: out`);
  await t.db.execute(sql`
    CREATE TABLE spans (opened timestamptz NOT NULL, closed timestamptz, kind text NOT NULL)`);
  await t.db.execute(sql`
    INSERT INTO spans (opened, closed, kind) VALUES
      ('2026-09-20T00:00:00Z', NULL, 'a'),                    -- open throughout
      ('2026-09-27T06:00:00Z', '2026-09-28T00:00:00Z', 'a'),  -- closes exactly at the 27th's end: still open then
      ('2026-09-28T06:00:00Z', '2026-09-29T06:00:00Z', 'b'),  -- open at the 28th's end only
      ('2026-09-30T20:00:00Z', NULL, 'b')                     -- opens after now`);
});

afterAll(async () => {
  await t.drop();
});

const params = {};

describe("sqlFlow", () => {
  const flow = (agg = sql`count(*)`) =>
    sqlFlow({
      db: t.db,
      from: sql`events e`,
      time: sql`e.at`,
      agg,
      splits: { kind: { expr: sql`e.kind`, label: sql`upper(e.kind)` } },
    });

  test("counts rows per interval, half-open, filling empty intervals with 0", async () => {
    const rows = await flow()({ intervals, split: null, params });
    expect(rows).toEqual([
      { key: "total", label: "Total", values: [2, 1, 0, 1, 4] },
    ]);
  });

  test("splits by an expression, a NULL key reading as (none)", async () => {
    const rows = await flow()({ intervals, split: "kind", params });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(Object.keys(byKey).sort()).toEqual(["(none)", "a", "b"]);
    expect(byKey.a).toEqual({ key: "a", label: "A", values: [1, 0, 0, 1, 2] });
    expect(byKey.b).toEqual({ key: "b", label: "B", values: [1, 0, 0, 0, 1] });
    expect(byKey["(none)"]!.values).toEqual([0, 1, 0, 0, 1]);
  });

  test("a distinct count over the range is not the sum of its buckets", async () => {
    const rows = await flow(sql`count(DISTINCT e.who)`)({
      intervals,
      split: null,
      params,
    });
    expect(rows[0]!.values).toEqual([2, 1, 0, 1, 2]);
  });

  test("where may depend on the params", async () => {
    const evaluate = sqlFlow<{ who: string }>({
      db: t.db,
      from: sql`events e`,
      time: sql`e.at`,
      agg: sql`sum(e.amount)`,
      where: (p) => sql`e.who = ${p.who}`,
    });
    const rows = await evaluate({
      intervals,
      split: null,
      params: { who: "ann" },
    });
    expect(rows[0]!.values).toEqual([1, 3, 0, 0, 4]);
  });

  test("an empty interval of a median is null, not 0", async () => {
    const evaluate = sqlFlow({
      db: t.db,
      from: sql`events e`,
      time: sql`e.at`,
      agg: sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY e.amount)`,
      empty: null,
    });
    const rows = await evaluate({ intervals, split: null, params });
    expect(rows[0]!.values).toEqual([1.5, 3, null, 4, 2.5]);
  });

  test("a split with no SQL expression throws", async () => {
    expect(
      (await rejection(flow()({ intervals, split: "nope", params }))).message,
    ).toMatch(/no SQL expression for split "nope"/);
  });
});

describe("sqlLevel", () => {
  test("counts rows open at each interval's end", async () => {
    const evaluate = sqlLevel({
      db: t.db,
      from: sql`spans s`,
      start: sql`s.opened`,
      end: sql`s.closed`,
    });
    const rows = await evaluate({ intervals, split: null, params });
    // End of 27th: the open-ended one + the one closing exactly then; end of
    // 28th: open-ended + the b span; the range ends at now, before the late opener.
    expect(rows).toEqual([
      { key: "total", label: "Total", values: [2, 2, 1, 1, 1] },
    ]);
  });

  test("splits", async () => {
    const evaluate = sqlLevel({
      db: t.db,
      from: sql`spans s`,
      start: sql`s.opened`,
      end: sql`s.closed`,
      splits: { kind: { expr: sql`s.kind` } },
    });
    const rows = await evaluate({ intervals, split: "kind", params });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.values]));
    expect(byKey).toEqual({ a: [2, 1, 1, 1, 1], b: [0, 1, 0, 0, 0] });
  });
});
