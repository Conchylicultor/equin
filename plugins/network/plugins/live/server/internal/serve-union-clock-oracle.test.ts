/**
 * Oracle for a CLOCK field on a union (`clockField.elapsed`, item 7 session 2
 * of research/2026-11-03-global-live-collections-item7-remaining.md), on a
 * throwaway database: the runs shape in miniature — two ledgers, each with a
 * start and an optional finish — with `took` the elapsed time, to `now` while
 * a run is in flight.
 *
 * - The SQL rendering (`clockFieldSql`, against the tuple's pinned `now`) and
 *   the JS rendering (`clockFieldValue`, what the browser computes) agree on
 *   every row — read back off the row key, the one place the server's value
 *   travels.
 * - Sorted by `took`, an in-flight run sorts by how long it has been going —
 *   in both directions — not last; filtered by `took`, it matches by the same.
 * - A pin is a pure input: two loads at one pin answer the same, a later pin
 *   re-orders.
 * - No row carries `took`; a point read pins nothing and reads nothing of it.
 * - The codec refuses a query naming `took` without `now`, and `now` beside a
 *   query naming none; a grouping's `where` over it is pinned like a window's.
 * - Raw clock reads are refused where a union compiles: an arm `where` reading
 *   `now()`.
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { Client } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import type { ColumnRef } from "@plugins/network/plugins/live/plugins/query-resource/core";
import type { QueryDb } from "@plugins/network/plugins/live/plugins/query-resource/server";
import {
  clockField,
  clockFieldValue,
  LIVE_ROW_KEY,
  liveArm,
  liveCollection,
  pinNow,
  type LiveWindowParams,
} from "@plugins/network/plugins/live/core";
import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { durationField } from "@plugins/fields/plugins/duration/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { clockFieldSql } from "./clock-sql";
import { compileUnion, type UnionArmBinding } from "./serve-union";

const A = "oc_a";
const B = "oc_b";
const ledger = (name: string) =>
  pgTable(name, {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  });
const aRuns = ledger(A);
const bRuns = ledger(B);

const MINUTE = 60_000;

const runs = liveCollection("test.live.union-clock-oracle", {
  fields: {
    kind: textField({ label: "Kind" }),
    label: textField({ label: "Label" }),
    took: clockField.elapsed(durationField({ label: "Took" }), {
      from: "startedAt",
      until: "finishedAt",
      quantumMs: MINUTE,
    }),
    startedAt: dateField({ label: "Started" }),
    finishedAt: nullable(dateField({ label: "Finished" })),
  },
  carry: {
    fields: { runKey: textField(), id: textField() },
  },
  id: "runKey",
  arms: { discriminator: "kind" },
  sortable: ["label", "startedAt", "took"],
  default: { orderBy: [["startedAt", "desc"]], limit: 5 },
  maxLimit: 20,
});
const form = runs.fields.took.clock!;
const aColumns = liveArm(runs, "a", { label: "A", order: 10, fields: {} });
const bColumns = liveArm(runs, "b", { label: "B", order: 20, fields: {} });

type Refs = Record<string, Record<string, ColumnRef>>;
const armOf = (
  columns: typeof aColumns,
  table: typeof aRuns,
): UnionArmBinding => ({
  columns,
  from: table,
  id: table.id,
  base: (j) => {
    const r = j as unknown as Refs;
    return {
      id: r.base!.id!,
      label: r.base!.label!,
      startedAt: r.base!.startedAt!,
      finishedAt: r.base!.finishedAt!,
      // What `serveUnionCollection` derives for every arm from the field's
      // one declaration.
      took: clockFieldSql(form, {
        startedAt: r.base!.startedAt!,
        finishedAt: r.base!.finishedAt!,
      }),
    };
  },
  extra: () => ({}),
});
const arms = [armOf(aColumns, aRuns), armOf(bColumns, bRuns)];

// One fixed instant everything is measured from — pinned, as a reader pins it.
const NOW = pinNow(Date.parse("2026-11-03T12:00:30Z"), MINUTE);
const at = (minutesBefore: number) => new Date(NOW - minutesBefore * MINUTE);

let testDb: TestDb;
let client: Client;
let db: NodePgDatabase;
let compiled: ReturnType<typeof compileUnion>;

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "live_union_clock" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  db = drizzle(client);
  for (const name of [A, B]) {
    await db.execute(
      sql.raw(
        `CREATE TABLE ${name} (id text PRIMARY KEY, label text NOT NULL,
           started_at timestamptz NOT NULL, finished_at timestamptz);`,
      ),
    );
  }
  // a1: finished, took 5 min. a2: running, started 10 min ago.
  // b1: finished, took 20 min. b2: running, started 2 min ago.
  await db.insert(aRuns).values([
    { id: "a1", label: "a1", startedAt: at(30), finishedAt: at(25) },
    { id: "a2", label: "a2", startedAt: at(10), finishedAt: null },
  ]);
  await db.insert(bRuns).values([
    { id: "b1", label: "b1", startedAt: at(60), finishedAt: at(40) },
    { id: "b2", label: "b2", startedAt: at(2), finishedAt: null },
  ]);
  compiled = compileUnion(runs, {
    arms: () => arms,
    db: db as unknown as QueryDb,
  });
}, 30_000);

afterAll(async () => {
  await client?.end();
  await testDb?.drop();
});

const w = runs.window.window;
type Row = Record<string, unknown>;
const load = async (params: LiveWindowParams): Promise<Row[]> =>
  (await compiled.window.loader(params)) as unknown as Row[];
const keys = (rows: readonly Row[]) => rows.map((r) => r.runKey);

describe("a clock field on a union", () => {
  test("sorted by it, an in-flight run sorts by how long it has been going — both directions", async () => {
    const desc = await load(
      w.encode({ orderBy: [["took", "desc"]], now: NOW }),
    );
    expect(keys(desc)).toEqual(["b:b1", "a:a2", "a:a1", "b:b2"]);
    const asc = await load(w.encode({ orderBy: [["took", "asc"]], now: NOW }));
    expect(keys(asc)).toEqual(["b:b2", "a:a1", "a:a2", "b:b1"]);
  });

  test("its SQL and JS renderings agree on every row (read off the row key)", async () => {
    const rows = await load(
      w.encode({ orderBy: [["took", "desc"]], now: NOW }),
    );
    for (const row of rows) {
      const parts = JSON.parse(row[LIVE_ROW_KEY] as string) as string[];
      expect(Number(parts[0])).toBe(clockFieldValue(form, row, NOW)!);
    }
  });

  test("no row carries it; the order signature reads its inputs", async () => {
    const rows = await load(
      w.encode({ orderBy: [["took", "desc"]], now: NOW }),
    );
    for (const row of rows) expect(Object.hasOwn(row, "took")).toBe(false);
    const point = (await compiled.rows.loader(
      runs.rows.point.encode(["a:a2", "b:b1"]),
    )) as unknown as Row[];
    expect(point.map((r) => Object.hasOwn(r, "took"))).toEqual([false, false]);
  });

  test("filtered by it, an in-flight run matches by its elapsed time at the pin", async () => {
    const rows = await load(
      w.encode({ where: { took: { gt: 6 * MINUTE } }, now: NOW }),
    );
    expect(new Set(keys(rows))).toEqual(new Set(["a:a2", "b:b1"]));
  });

  test("a pin is a pure input: one pin answers alike, a later pin re-orders", async () => {
    const q = { orderBy: [["took", "desc"]] as const };
    const first = await load(w.encode({ ...q, now: NOW }));
    const again = await load(w.encode({ ...q, now: NOW }));
    expect(again).toEqual(first);
    // Fifteen minutes on, the 10-minute run has been going 25: past b1's 20.
    const later = await load(w.encode({ ...q, now: NOW + 15 * MINUTE }));
    expect(keys(later)).toEqual(["a:a2", "b:b1", "b:b2", "a:a1"]);
  });

  test("a grouping whose where reads it is pinned too", async () => {
    const groups = (await compiled.groups.loader(
      runs.groups.groups.encode({
        groupBy: "kind",
        where: { took: { gt: 6 * MINUTE } },
        now: NOW,
      }),
    )) as { value: unknown; count: number }[];
    expect(groups).toEqual([
      { value: "a", count: 1 },
      { value: "b", count: 1 },
    ]);
  });

  test("the codec pins exactly the queries that read it", () => {
    expect(() => w.encode({ orderBy: [["took", "desc"]] })).toThrow(
      /names clock field "took" — its reader pins `now`/,
    );
    expect(() => w.encode({ where: { took: { gt: 1 } } })).toThrow(
      /names clock field "took"/,
    );
    expect(() => w.encode({ now: NOW })).toThrow(
      /`now` beside a query that names no clock field/,
    );
    expect(() =>
      w.encode({ orderBy: [["took", "desc"]], now: NOW + 1 }),
    ).toThrow(/not floored to 60000 ms/);
    expect(() =>
      w.decode({ limit: "5", order: JSON.stringify([["took", "desc"]]) }),
    ).toThrow(/names clock field "took"/);
    expect(() =>
      runs.groups.groups.encode({ groupBy: "took" as never, now: NOW }),
    ).toThrow(/is a clock field/);
    expect(w.clockQuantum({ orderBy: [["took", "asc"]] })).toBe(MINUTE);
    expect(w.clockQuantum({ orderBy: [["label", "asc"]] })).toBeNull();
    expect(
      w.familyOf(w.encode({ orderBy: [["took", "desc"]], now: NOW })),
    ).not.toBe(
      w.familyOf(w.encode({ orderBy: [["took", "desc"]], now: NOW + MINUTE })),
    );
  });

  test("an arm reading Postgres's own clock is refused where the union compiles", () => {
    expect(() =>
      compileUnion(runs, {
        arms: () => [
          {
            ...arms[0]!,
            where: () => sql`${aRuns.startedAt} > now() - interval '1 day'`,
          },
        ],
        db: db as unknown as QueryDb,
      }),
    ).toThrow(/reads the clock \(`now\(\)`/);
  });
});
