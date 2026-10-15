/**
 * A window's `$key` against a real Postgres: a row key is the exact
 * text of each order key, so a cut at a row splits the order exactly AT that
 * row — for the types a decoded row would round: a `timestamptz` with µs the
 * driver reads as a ms `Date`, a long `numeric`, and a `float8` a naive text
 * form would lose — and a `boolean`, whose many ties the id tiebreak splits. For every row of every order, `until = $key` returns exactly
 * the rows up to it, and `after = $key` exactly the rows past it.
 *
 * Run: `./singularity test plugins/network/plugins/live`
 * (requires the running embedded cluster).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  boolean,
  doublePrecision,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { Client } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/infra/plugins/query-resource/server/testing";
import { liveCollection, LIVE_ROW_KEY } from "../../core";
import { compileCollection } from "./serve-collection";

const cuts = pgTable("scroll_key_cuts", {
  id: text("id").primaryKey(),
  t: timestamp("t", { withTimezone: true }),
  num: numeric("num"),
  f: doublePrecision("f"),
  b: boolean("b"),
});

const collection = liveCollection("test.live.scroll-key-roundtrip", {
  fields: {
    id: textField({ label: "Id" }),
    t: nullable(dateField({ label: "T" })),
    num: nullable(textField({ label: "Num" })),
    f: nullable(floatField({ label: "F" })),
    b: nullable(boolField({ label: "B" })),
  },
  id: "id",
  sortable: ["t", "num", "f", "b"],
  default: { orderBy: [["t", "asc"]], limit: 10 },
  maxLimit: 30,
});

// Values that collide once rounded: four instants inside ONE millisecond,
// numerics equal to 15 significant digits, floats one ulp apart.
const VALUES = [
  [
    "a",
    "'2026-09-30 10:00:00.123001+00'",
    "1.000000000000000000001",
    "0.1",
    "true",
  ],
  [
    "b",
    "'2026-09-30 10:00:00.123002+00'",
    "1.000000000000000000002",
    "0.30000000000000004",
    "false",
  ],
  [
    "c",
    "'2026-09-30 10:00:00.123999+00'",
    "1.000000000000000000003",
    "0.3",
    "true",
  ],
  [
    "d",
    "'2026-09-30 10:00:00.1235+00'",
    "1.0000000000000000000025",
    "0.30000000000000004",
    "NULL",
  ],
  ["e", "NULL", "NULL", "NULL", "false"],
  ["f", "'2026-09-30 10:00:00.123001+00'", "-5", "1e-320", "true"],
  [
    "g",
    "'1969-12-31 23:59:59.999999+00'",
    "12345678901234567890.123456789",
    "5e-324",
    "false",
  ],
] as const;

let t: TestDb;
let client: Client;
let db: QueryDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "live_scroll_key" });
  // A TEMP table lives on one session, so every statement rides this client.
  client = new Client({ connectionString: t.connectionString });
  await client.connect();
  const pg = drizzle(client);
  await pg.execute(
    sql.raw(
      "CREATE TEMP TABLE scroll_key_cuts (id text PRIMARY KEY, t timestamptz, num numeric, f float8, b boolean)",
    ),
  );
  await pg.execute(
    sql.raw(
      `INSERT INTO scroll_key_cuts (id, t, num, f, b) VALUES ${VALUES.map(
        ([id, ts, n, f, b]) =>
          `('${id}', ${ts}, ${n === "NULL" ? "NULL" : `${n}::numeric`}, ${f === "NULL" ? "NULL" : `${f}::float8`}, ${b})`,
      ).join(", ")}`,
    ),
  );
  db = pg as unknown as QueryDb;
});

afterAll(async () => {
  await client.end();
  await t.drop();
});

describe("$key round-trips exactly through a cut", () => {
  test("timestamptz µs, numeric, float8 and boolean, both directions: until / after a row's key split the order at that row", async () => {
    const specs = compileCollection(collection, { from: cuts, db });
    const { loader } = compileWindowQuery(
      collection.window,
      specs.window,
    ).serverOpts;
    const codec = collection.window.window;
    let checked = 0;
    for (const col of ["t", "num", "f", "b"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const query = { orderBy: [[col, dir]] as const, limit: 30 };
        const all = (await loader(codec.encode(query))) as Record<
          string,
          unknown
        >[];
        expect(all).toHaveLength(VALUES.length);
        const order = all.map((r) => r.id as string);
        for (let i = 0; i < all.length; i++) {
          const key = all[i]![LIVE_ROW_KEY] as string;
          expect(typeof key).toBe("string");
          const upTo = (await loader(
            codec.encode(query, { until: key }),
          )) as Record<string, unknown>[];
          const past = (await loader(
            codec.encode(query, { after: key }),
          )) as Record<string, unknown>[];
          expect({
            col,
            dir,
            at: order[i],
            upTo: upTo.map((r) => r.id),
          }).toEqual({
            col,
            dir,
            at: order[i],
            upTo: order.slice(0, i + 1),
          });
          expect({
            col,
            dir,
            at: order[i],
            past: past.map((r) => r.id),
          }).toEqual({
            col,
            dir,
            at: order[i],
            past: order.slice(i + 1),
          });
          checked++;
        }
      }
    }
    expect(checked).toBe(4 * 2 * VALUES.length);
  });

  test("the row key is Postgres's own text: µs and every numeric digit survive", async () => {
    const specs = compileCollection(collection, { from: cuts, db });
    const { loader } = compileWindowQuery(
      collection.window,
      specs.window,
    ).serverOpts;
    const rows = (await loader(
      collection.window.window.encode({ orderBy: [["num", "asc"]] }),
    )) as Record<string, unknown>[];
    const byId = new Map(rows.map((r) => [r.id, r[LIVE_ROW_KEY]]));
    expect(byId.get("g")).toBe(
      JSON.stringify(["12345678901234567890.123456789", "g"]),
    );
    const timed = (await loader(collection.window.window.encode())) as Record<
      string,
      unknown
    >[];
    const key = JSON.parse(
      timed.find((r) => r.id === "b")![LIVE_ROW_KEY] as string,
    ) as string[];
    expect(key[0]).toMatch(/\.123002/);
    // …which the decoded row itself could not say.
    expect((timed.find((r) => r.id === "b")!.t as Date).toISOString()).toBe(
      "2026-09-30T10:00:00.123Z",
    );
  });
});
