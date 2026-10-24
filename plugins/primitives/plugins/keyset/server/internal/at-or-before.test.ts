/**
 * `atOrBeforePredicate` against a real Postgres: for random rows and random
 * cuts over nullable / non-null keys in both directions, `seek(c)` and
 * `atOrBefore(c)` split the rows exactly in two (disjoint, covering), and each
 * agrees with an `ORDER BY … NULLS LAST` reference — the cut's position among
 * the rows as Postgres itself orders them.
 *
 * Run: `./equin test plugins/primitives/plugins/keyset`
 * (requires the running embedded cluster).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql, type SQL } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { integer, PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { Client } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import {
  atOrBeforePredicate,
  orderByClauses,
  seekPredicate,
  type SortKey,
} from "./seek";

const t = pgTable("keyset_cut", {
  id: integer("id").primaryKey(),
  a: integer("a"), // nullable
  b: text("b").notNull(),
  c: integer("c"), // nullable
});

type Row = { id: number; a: number | null; b: string; c: number | null };

let db: TestDb;
let client: Client;
let pg: NodePgDatabase;
const dialect = new PgDialect();

/** A tiny seeded PRNG, so a failure reproduces. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ROWS: Row[] = (() => {
  const rnd = prng(7);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  // Few distinct values, so ties on every key are common and the tiebreaker works.
  return Array.from({ length: 60 }, (_, id) => ({
    id,
    a: pick([null, 1, 2, 3]),
    b: pick(["x", "y", "z"]),
    c: pick([null, -1, 0, 5]),
  }));
})();

const literal = (v: number | string | null): string =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v}'`;

beforeAll(async () => {
  db = await createTestDb({ prefix: "keyset_cut" });
  // A TEMP table lives on one session, so every statement rides this client.
  client = new Client({ connectionString: db.connectionString });
  await client.connect();
  pg = drizzle(client);
  await pg.execute(
    sql.raw(
      "CREATE TEMP TABLE keyset_cut (id int PRIMARY KEY, a int, b text NOT NULL, c int)",
    ),
  );
  await pg.execute(
    sql.raw(
      `INSERT INTO keyset_cut (id, a, b, c) VALUES ${ROWS.map(
        (r) => `(${r.id}, ${literal(r.a)}, ${literal(r.b)}, ${literal(r.c)})`,
      ).join(", ")}`,
    ),
  );
});

afterAll(async () => {
  await client.end();
  await db.drop();
});

async function ids(where: SQL | undefined): Promise<number[]> {
  const q = sql`SELECT ${t.id} AS id FROM ${t}${where ? sql` WHERE ${where}` : sql``} ORDER BY ${t.id}`;
  const r = await pg.execute<{ id: number }>(q);
  return r.rows.map((row) => row.id);
}

/**
 * The reference: the rows ordered by Postgres, with the cut inserted as a
 * probe row, so the cut's position is Postgres's own answer. Returns the ids
 * strictly before the probe and at-or-after it (the probe itself excluded).
 */
async function reference(
  keys: SortKey[],
  cut: Row,
): Promise<{ before: number[]; after: number[] }> {
  const probe = `(SELECT ${cut.id} AS id, ${literal(cut.a)}::int AS a, ${literal(cut.b)}::text AS b, ${literal(cut.c)}::int AS c)`;
  const order = orderByClauses(keys)
    .map((s) => dialect.sqlToQuery(s).sql)
    .join(", ");
  const r = await client.query<{ id: number }>(
    `SELECT id FROM (SELECT * FROM keyset_cut UNION ALL ${probe}) AS "keyset_cut" ORDER BY ${order}`,
  );
  const ordered = r.rows.map((row) => row.id);
  const at = ordered.indexOf(cut.id);
  const sorted = (xs: number[]) => [...xs].sort((x, y) => x - y);
  return {
    before: sorted(ordered.slice(0, at).filter((id) => id !== cut.id)),
    after: sorted(ordered.slice(at + 1)),
  };
}

const COLS = {
  a: { col: t.a, nullable: true },
  b: { col: t.b, nullable: false },
  c: { col: t.c, nullable: true },
} as const;

describe("atOrBeforePredicate", () => {
  test("rejects a cut that does not name every key", () => {
    const keys: SortKey[] = [
      { fieldId: "id", col: t.id, dir: "asc", nullable: false },
    ];
    expect(() => atOrBeforePredicate(keys, [])).toThrow(/every key/);
  });

  test("seek(c) and atOrBefore(c) partition the rows, each matching ORDER BY … NULLS LAST", async () => {
    const rnd = prng(42);
    const shapes: (keyof typeof COLS)[][] = [
      ["a"],
      ["b"],
      ["c"],
      ["a", "b"],
      ["c", "a"],
      ["b", "c", "a"],
    ];
    let checked = 0;
    for (const shape of shapes) {
      for (const dirs of [
        ["asc", "asc", "asc"],
        ["desc", "desc", "desc"],
        ["asc", "desc", "asc"],
        ["desc", "asc", "desc"],
      ] as const) {
        const keys: SortKey[] = [
          ...shape.map((name, i) => ({
            fieldId: name,
            col: COLS[name].col,
            dir: dirs[i]!,
            nullable: COLS[name].nullable,
          })),
          { fieldId: "id", col: t.id, dir: "asc", nullable: false },
        ];
        // Cuts at existing rows (the scroll's case: a server-minted key of a
        // real row) and at synthetic tuples (between, before and after rows).
        const cuts: Row[] = [
          ...Array.from(
            { length: 6 },
            () => ROWS[Math.floor(rnd() * ROWS.length)]!,
          ),
          ...Array.from({ length: 6 }, (_, k) => ({
            id: 1000 + k,
            a: [null, 0, 2, 4][Math.floor(rnd() * 4)]!,
            b: ["w", "y", "zz"][Math.floor(rnd() * 3)]!,
            c: [null, -2, 0, 9][Math.floor(rnd() * 4)]!,
          })),
        ];
        for (const cut of cuts) {
          const values = keys.map(
            (k) => cut[k.fieldId as keyof Row] as number | string | null,
          );
          const before = await ids(atOrBeforePredicate(keys, values));
          const after = await ids(seekPredicate(keys, values));
          const all = ROWS.map((r) => r.id);
          expect(new Set([...before, ...after]).size).toBe(
            before.length + after.length,
          );
          expect([...before, ...after].sort((x, y) => x - y)).toEqual(all);
          const ref = await reference(keys, cut);
          const existing = ROWS.some((r) => r.id === cut.id);
          // The cut row itself is at-or-before; the probe stands in for it.
          const expectedBefore = existing
            ? [...ref.before, cut.id].sort((x, y) => x - y)
            : ref.before;
          const expectedAfter = existing
            ? ref.after.filter((id) => id !== cut.id)
            : ref.after;
          expect({ shape, dirs, cut, before }).toEqual({
            shape,
            dirs,
            cut,
            before: expectedBefore,
          });
          expect({ shape, dirs, cut, after }).toEqual({
            shape,
            dirs,
            cut,
            after: expectedAfter,
          });
          checked++;
        }
      }
    }
    expect(checked).toBe(6 * 4 * 12);
  });
});
