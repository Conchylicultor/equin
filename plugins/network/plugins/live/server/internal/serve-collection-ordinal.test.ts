/**
 * An ORDINAL field against a real Postgres: a field declaring its value order
 * (`enumTextField(values, { ordered: true })`) sorts a window by each value's
 * position in that order — never by its text — in both directions, a NULL
 * last either way; and its `$key` is the position, so a cut at any row splits
 * the order exactly at that row (`until` / `after`), as for any order key.
 *
 * The values are chosen so the declared order disagrees with the text order
 * (`todo` < `doing` < `done`, alphabetically `doing` < `done` < `todo`).
 *
 * Run: `./equin test plugins/network/plugins/live`
 * (requires the running embedded cluster).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { nullable } from "@plugins/fields/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import { Client } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import type { QueryDb } from "@plugins/network/plugins/live/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/network/plugins/live/plugins/query-resource/server/testing";
import { liveCollection, LIVE_ROW_KEY } from "../../core";
import { compileCollection } from "./serve-collection";

const PHASES = ["todo", "doing", "done"] as const;

const items = pgTable("ordinal_items", {
  id: text("id").primaryKey(),
  phase: text("phase"),
  label: text("label").notNull(),
});

const collection = liveCollection("test.live.ordinal", {
  fields: {
    id: textField({ label: "Id" }),
    phase: nullable(enumTextField(PHASES, { label: "Phase", ordered: true })),
    label: textField({ label: "Label" }),
  },
  id: "id",
  sortable: ["phase", "label"],
  default: { orderBy: [["label", "asc"]], limit: 10 },
  maxLimit: 30,
});

// Ties on a phase (the id breaks them), and a row with none.
const ROWS = [
  ["a", "done", "x"],
  ["b", "todo", "y"],
  ["c", "doing", "z"],
  ["d", "todo", "w"],
  ["e", null, "v"],
  ["f", "done", "u"],
] as const;

let t: TestDb;
let client: Client;
let db: QueryDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "live_ordinal" });
  // A TEMP table lives on one session, so every statement rides this client.
  client = new Client({ connectionString: t.connectionString });
  await client.connect();
  const pg = drizzle(client);
  await pg.execute(
    sql.raw(
      "CREATE TEMP TABLE ordinal_items (id text PRIMARY KEY, phase text, label text NOT NULL)",
    ),
  );
  await pg.execute(
    sql.raw(
      `INSERT INTO ordinal_items (id, phase, label) VALUES ${ROWS.map(
        ([id, phase, label]) =>
          `('${id}', ${phase === null ? "NULL" : `'${phase}'`}, '${label}')`,
      ).join(", ")}`,
    ),
  );
  db = pg as unknown as QueryDb;
});

afterAll(async () => {
  await client.end();
  await t.drop();
});

function loaderOf() {
  const specs = compileCollection(collection, { from: items, db });
  return compileWindowQuery(collection.window, specs.window).serverOpts
    .loader as (params: unknown) => Promise<Record<string, unknown>[]>;
}

describe("an ordinal field orders a window by declared position", () => {
  test("ascending and descending, ties by id, a NULL last either way", async () => {
    const loader = loaderOf();
    const codec = collection.window.window;
    const ids = async (dir: "asc" | "desc") =>
      (
        await loader(codec.encode({ orderBy: [["phase", dir]], limit: 30 }))
      ).map((r) => r.id);
    expect(await ids("asc")).toEqual(["b", "d", "c", "a", "f", "e"]);
    expect(await ids("desc")).toEqual(["a", "f", "c", "b", "d", "e"]);
  });

  test("the row carries the value itself; its key is the position", async () => {
    const loader = loaderOf();
    const rows = await loader(
      collection.window.window.encode({ orderBy: [["phase", "asc"]] }),
    );
    expect(rows[0]!.phase).toBe("todo");
    expect(JSON.parse(rows[0]![LIVE_ROW_KEY] as string)).toEqual(["1", "b"]);
  });

  test("a cut at every row splits the order exactly there, both directions", async () => {
    const loader = loaderOf();
    const codec = collection.window.window;
    for (const dir of ["asc", "desc"] as const) {
      const query = { orderBy: [["phase", dir]] as const, limit: 30 };
      const all = await loader(codec.encode(query));
      const order = all.map((r) => r.id);
      for (let i = 0; i < all.length; i++) {
        const key = all[i]![LIVE_ROW_KEY] as string;
        const upTo = await loader(codec.encode(query, { until: key }));
        const past = await loader(codec.encode(query, { after: key }));
        expect({ dir, at: order[i], upTo: upTo.map((r) => r.id) }).toEqual({
          dir,
          at: order[i],
          upTo: order.slice(0, i + 1),
        });
        expect({ dir, at: order[i], past: past.map((r) => r.id) }).toEqual({
          dir,
          at: order[i],
          past: order.slice(i + 1),
        });
      }
    }
  });

  test("an ordinal key after another key orders within its ties", async () => {
    const loader = loaderOf();
    await client.query("UPDATE ordinal_items SET label = 'same'");
    try {
      const rows = await loader(
        collection.window.window.encode({
          orderBy: [
            ["label", "asc"],
            ["phase", "asc"],
          ],
        }),
      );
      expect(rows.map((r) => r.id)).toEqual(["b", "d", "c", "a", "f", "e"]);
    } finally {
      await client.query(
        `UPDATE ordinal_items SET label = v.label FROM (VALUES ${ROWS.map(
          ([id, , label]) => `('${id}', '${label}')`,
        ).join(", ")}) AS v(id, label) WHERE ordinal_items.id = v.id`,
      );
    }
  });
});
