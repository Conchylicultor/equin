/**
 * An ORDINAL base field on a UNION, against a real Postgres: a field declaring
 * its value order (`enumTextField(values, { ordered: true })`) sorts the
 * union's window by each value's position — in every arm's own ORDER BY and
 * the outer one — never by its text, both directions; its `$key` part is the
 * position, so a cut at any row splits the order exactly at that row.
 *
 * The values disagree with their text order (`queued` < `running` < `failed`,
 * alphabetically `failed` < `queued` < `running`).
 *
 * Run: `./equin test plugins/network/plugins/live`
 * (requires the running embedded cluster).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import { Client } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import type { ColumnRef } from "@plugins/network/plugins/live/plugins/query-resource/core";
import type { QueryDb } from "@plugins/network/plugins/live/plugins/query-resource/server";
import {
  LIVE_ROW_KEY,
  liveArm,
  liveCollection,
  type LiveWindowParams,
} from "@plugins/network/plugins/live/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { compileUnion, type UnionArmBinding } from "./serve-union";

const A = "uo_a";
const B = "uo_b";
const ledger = (name: string) =>
  pgTable(name, {
    id: text("id").primaryKey(),
    state: text("state").notNull(),
  });
const aRuns = ledger(A);
const bRuns = ledger(B);

const runs = liveCollection("test.live.union-ordinal", {
  fields: {
    kind: textField({ label: "Kind" }),
    state: enumTextField(["queued", "running", "failed"] as const, {
      label: "State",
      ordered: true,
    }),
  },
  carry: { fields: { runKey: textField(), id: textField() } },
  id: "runKey",
  arms: { discriminator: "kind" },
  sortable: ["state"],
  default: { orderBy: [["state", "asc"]], limit: 5 },
  maxLimit: 20,
});
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
    return { id: r.base!.id!, state: r.base!.state! };
  },
  extra: () => ({}),
});

let testDb: TestDb;
let client: Client;
let db: NodePgDatabase;
let compiled: ReturnType<typeof compileUnion>;

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "live_union_ordinal" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  db = drizzle(client);
  for (const name of [A, B]) {
    await db.execute(
      sql.raw(
        `CREATE TABLE ${name} (id text PRIMARY KEY, state text NOT NULL);`,
      ),
    );
  }
  await db.insert(aRuns).values([
    { id: "a1", state: "failed" },
    { id: "a2", state: "queued" },
    { id: "a3", state: "running" },
  ]);
  await db.insert(bRuns).values([
    { id: "b1", state: "running" },
    { id: "b2", state: "failed" },
    { id: "b3", state: "queued" },
  ]);
  compiled = compileUnion(runs, {
    arms: () => [armOf(aColumns, aRuns), armOf(bColumns, bRuns)],
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

describe("an ordinal field on a union", () => {
  test("sorts by declared position across arms, both directions (ties by row key)", async () => {
    expect(
      keys(await load(w.encode({ orderBy: [["state", "asc"]], limit: 20 }))),
    ).toEqual(["a:a2", "b:b3", "a:a3", "b:b1", "a:a1", "b:b2"]);
    expect(
      keys(await load(w.encode({ orderBy: [["state", "desc"]], limit: 20 }))),
    ).toEqual(["a:a1", "b:b2", "a:a3", "b:b1", "a:a2", "b:b3"]);
  });

  test("a per-arm limit keeps each arm's first rows by position", async () => {
    // Limit 2: each arm's subselect must already order by position, or an
    // arm would hand the outer query its alphabetically first rows.
    expect(
      keys(await load(w.encode({ orderBy: [["state", "asc"]], limit: 2 }))),
    ).toEqual(["a:a2", "b:b3"]);
  });

  test("its key part is the position, and a cut at every row splits there", async () => {
    for (const dir of ["asc", "desc"] as const) {
      const query = { orderBy: [["state", dir]] as const, limit: 20 };
      const all = await load(w.encode(query));
      expect(JSON.parse(all[0]![LIVE_ROW_KEY] as string)[0]).toBe(
        dir === "asc" ? "1" : "3",
      );
      const order = keys(all);
      for (let i = 0; i < all.length; i++) {
        const key = all[i]![LIVE_ROW_KEY] as string;
        const upTo = await load(w.encode(query, { until: key }));
        const past = await load(w.encode(query, { after: key }));
        expect({ dir, at: order[i], upTo: keys(upTo) }).toEqual({
          dir,
          at: order[i],
          upTo: order.slice(0, i + 1),
        });
        expect({ dir, at: order[i], past: keys(past) }).toEqual({
          dir,
          at: order[i],
          past: order.slice(i + 1),
        });
      }
    }
  });
});
