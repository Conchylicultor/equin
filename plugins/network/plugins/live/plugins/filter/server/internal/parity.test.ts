/**
 * Parity suite for the one op table: every op × every domain it takes, over
 * values with NULLs, empty and whitespace strings, non-ASCII case, astral
 * characters, non-array jsonb and µs instants — answered twice, in memory
 * (`matchesFilter` over the row values AS THE DRIVER RETURNS THEM) and by a
 * real Postgres (`renderOpSql` / `filterSql` over TEMP tables on a throwaway
 * database). The two answers must be the same id set. Then: every complement
 * pair is disjoint and covering, and seeded random and/or trees agree too.
 *
 * Run: `./equin test plugins/network/plugins/live/plugins/filter`
 * (requires the running embedded cluster).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql, type SQL } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { canonicalizeFilter } from "../../core/internal/codec";
import type { FilterDomainId } from "../../core/internal/domains";
import type { Filter, Filterable } from "../../core/internal/expr";
import { matchesFilter } from "../../core/internal/matches";
import {
  filterOps,
  getFilterOp,
  opAllowsDomain,
  type FilterOpId,
} from "../../core/internal/ops";
import { filterSql, renderOpSql } from "./render";

// ── Fixtures ────────────────────────────────────────────────────────────

interface Case {
  domain: FilterDomainId;
  sqlType: string;
  /** SQL literals (NULL included), inserted verbatim. */
  values: string[];
  /** Operands for value / pattern ops. */
  operands: unknown[];
  /** Operands for list ops. */
  lists: unknown[][];
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const TEXTS = [
  "apple",
  "Apple",
  "app",
  "banana",
  "",
  " ",
  "\t\n",
  " ",
  "É",
  "é",
  "École",
  "école",
  "ﬁx",
  "\u{1F600}",
  "\u{1F600}x",
  "zeta",
  "50%",
  "a_b",
  "a\\b",
  "ÀB",
];

const CASES: Record<string, Case> = {
  text: {
    domain: "text",
    sqlType: "text",
    values: [...TEXTS.map(lit), "NULL"],
    operands: [
      "apple",
      "APPLE",
      "app",
      "b",
      "",
      " ",
      "É",
      "é",
      "écol",
      "ÉCOLE",
      "ﬁ",
      "\u{1F600}",
      "￿",
      "zz",
      "%",
      "_",
      "a_b",
      "\\",
      "50%",
      "àb",
    ],
    lists: [[], ["apple"], ["apple", "Apple", "", "É"], [...TEXTS]],
  },
  number: {
    domain: "number",
    sqlType: "double precision",
    values: ["-2.5", "-1", "0", "1", "2", "3.75", "100", "NULL"],
    operands: [-3, -1, 0, 1.5, 2, 3.75, 1000],
    lists: [[], [0], [-1, 1.5, 2], [-2.5, -1, 0, 1, 2, 3.75, 100]],
  },
  // A number domain over an integer column: the float8 cast keeps a
  // fractional operand exact instead of failing to parse it as an int.
  integer: {
    domain: "number",
    sqlType: "integer",
    values: ["-1", "0", "1", "2", "NULL"],
    operands: [0, 1, 1.5, 2, -0.5],
    lists: [[], [1], [0.5, 1, 2]],
  },
  boolean: {
    domain: "boolean",
    sqlType: "boolean",
    values: ["true", "false", "NULL"],
    operands: [true, false],
    lists: [],
  },
  instant: {
    domain: "instant",
    sqlType: "timestamptz",
    values: [
      lit("2026-06-15T12:30:00.000Z"),
      lit("2026-06-15T12:30:00.000500Z"),
      lit("2026-06-15T12:30:00.000999Z"),
      lit("2026-06-15T12:30:00.001Z"),
      lit("2026-06-15T12:29:59.999999Z"),
      lit("1969-12-31T23:59:59.999500Z"),
      lit("2027-01-01T00:00:00.000Z"),
      "NULL",
    ],
    operands: [
      "2026-06-15T12:30:00.000Z",
      "2026-06-15T12:30:00.001Z",
      "2026-06-15T12:29:59.999Z",
      "1969-12-31T23:59:59.999Z",
      "2028-01-01T00:00:00.000Z",
    ],
    lists: [],
  },
  stringArray: {
    domain: "stringArray",
    sqlType: "jsonb",
    values: [
      `'["a","b"]'`,
      `'["a"]'`,
      `'[]'`,
      `'["B"]'`,
      `'["a","c"]'`,
      `'["\u{1F600}"]'`,
      `'[""]'`,
      `'"a"'`,
      `'{"a":1}'`,
      `'null'`,
      `'3'`,
      "NULL",
    ],
    operands: [],
    lists: [
      [],
      ["a"],
      ["a", "b"],
      ["b", "c"],
      ["B"],
      ["\u{1F600}"],
      [""],
      ["z"],
    ],
  },
};

type CaseId = keyof typeof CASES;

// ── Harness ─────────────────────────────────────────────────────────────

let t: TestDb;
let client: Client;
let db: NodePgDatabase;
/** Each table's rows as the driver returns them. */
const ROWS: Record<string, { id: number; v: unknown }[]> = {};

const tableOf = (id: string) => sql.raw(`filter_parity_${id}`);

async function ids(table: string, where: SQL): Promise<number[]> {
  const r = await db.execute<{ id: number }>(
    sql`SELECT id FROM ${tableOf(table)} WHERE ${where} ORDER BY id`,
  );
  return r.rows.map((row) => row.id);
}

/**
 * Rows as a typed read hands them to a filter: through the raw `pg` client,
 * whose parsers decode `timestamptz` to a `Date` (µs truncated to ms). Not
 * `db.execute`: drizzle's per-query override returns `timestamptz` as the raw
 * Postgres text (`2026-06-15 14:30:00+02`), which no row schema passes on.
 */
async function driverRows<R extends Record<string, unknown>>(
  query: string,
): Promise<R[]> {
  const r = await client.query<R>(query);
  return r.rows;
}

function memoryIds(
  rows: readonly Record<string, unknown>[],
  filter: Filter | undefined,
  filterable: Filterable,
): number[] {
  return rows
    .filter((row) => matchesFilter(row, filter, filterable))
    .map((row) => row.id as number);
}

function operandsFor(c: Case, op: FilterOpId): unknown[] {
  switch (getFilterOp(op).operand) {
    case "none":
      return [undefined];
    case "list":
      return c.lists;
    case "value":
    case "pattern":
      return c.operands;
  }
}

beforeAll(async () => {
  t = await createTestDb({ prefix: "live_filter_parity" });
  // TEMP tables live on one session, so every statement rides this client.
  client = new Client({ connectionString: t.connectionString });
  await client.connect();
  db = drizzle(client);
  for (const [id, c] of Object.entries(CASES)) {
    await db.execute(
      sql.raw(
        `CREATE TEMP TABLE filter_parity_${id} (id int PRIMARY KEY, v ${c.sqlType})`,
      ),
    );
    const values = c.values
      .map((v, i) => `(${i}, ${v}::${c.sqlType})`)
      .join(", ");
    await db.execute(
      sql.raw(`INSERT INTO filter_parity_${id} (id, v) VALUES ${values}`),
    );
    ROWS[id] = await driverRows<{ id: number; v: unknown }>(
      `SELECT id, v FROM filter_parity_${id} ORDER BY id`,
    );
  }
});

afterAll(async () => {
  await client.end();
  await t.drop();
});

// ── Suites ──────────────────────────────────────────────────────────────

describe("the cluster", () => {
  test("collates and classifies text as C", async () => {
    const r = await db.execute<{ c: string; t: string }>(
      sql`SELECT datcollate AS c, datctype AS t FROM pg_database WHERE datname = current_database()`,
    );
    expect(["C", "POSIX"]).toContain(r.rows[0]!.c);
    expect(["C", "POSIX"]).toContain(r.rows[0]!.t);
  });

  test("the driver truncates a µs timestamptz to ms, as the instant domain does", () => {
    const byId = ROWS.instant!;
    expect((byId[1]!.v as Date).toISOString()).toBe("2026-06-15T12:30:00.000Z");
    expect((byId[2]!.v as Date).toISOString()).toBe("2026-06-15T12:30:00.000Z");
    expect((byId[4]!.v as Date).toISOString()).toBe("2026-06-15T12:29:59.999Z");
    expect((byId[5]!.v as Date).toISOString()).toBe("1969-12-31T23:59:59.999Z");
  });
});

describe("every op × every domain: memory vs Postgres", () => {
  for (const [id, c] of Object.entries(CASES) as [CaseId, Case][]) {
    test(`${id} (${c.domain})`, async () => {
      const filterable = { v: { domain: c.domain } };
      const rows = ROWS[id]!;
      let checked = 0;
      for (const op of Object.keys(filterOps) as FilterOpId[]) {
        if (!opAllowsDomain(op, c.domain)) continue;
        for (const operand of operandsFor(c, op)) {
          const f = canonicalizeFilter(
            { column: "v", op, operand } as Filter,
            filterable,
          );
          const expected = memoryIds(rows, f, filterable);
          const actual = await ids(
            id,
            renderOpSql(op, c.domain, sql.raw("v"), operand),
          );
          expect({ op, operand, ids: actual }).toEqual({
            op,
            operand,
            ids: expected,
          });
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(5);
    });
  }
});

describe("complement pairs are disjoint and covering in Postgres", () => {
  const negatives = (Object.keys(filterOps) as FilterOpId[]).filter(
    (op) => getFilterOp(op).complementOf !== undefined,
  );
  test("six pairs", () => {
    expect(negatives.length).toBe(6);
  });
  for (const [id, c] of Object.entries(CASES) as [CaseId, Case][]) {
    test(`${id} (${c.domain})`, async () => {
      const all = ROWS[id]!.map((r) => r.id);
      for (const neg of negatives) {
        if (!opAllowsDomain(neg, c.domain)) continue;
        const pos = getFilterOp(neg).complementOf!;
        for (const operand of operandsFor(c, neg)) {
          const p = await ids(
            id,
            renderOpSql(pos, c.domain, sql.raw("v"), operand),
          );
          const n = await ids(
            id,
            renderOpSql(neg, c.domain, sql.raw("v"), operand),
          );
          expect(p.filter((x) => n.includes(x))).toEqual([]);
          expect([...p, ...n].sort((a, b) => a - b)).toEqual(all);
        }
      }
    });
  }
});

// ── Random trees ────────────────────────────────────────────────────────

const MIXED_ROWS = 48;
const MIXED: Record<string, CaseId> = {
  t: "text",
  n: "number",
  b: "boolean",
  i: "instant",
  s: "stringArray",
};
const mixedFilterable: Filterable = Object.fromEntries(
  Object.entries(MIXED).map(([col, id]) => [
    col,
    { domain: CASES[id]!.domain },
  ]),
);

/** mulberry32 — a seeded PRNG, so a failing tree reproduces. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("random and/or trees: memory vs Postgres", () => {
  let mixedRows: Record<string, unknown>[] = [];

  beforeAll(async () => {
    const rand = prng(20260925);
    const pick = <T>(xs: readonly T[]): T =>
      xs[Math.floor(rand() * xs.length)]!;
    const cols = Object.entries(MIXED);
    await db.execute(
      sql.raw(
        `CREATE TEMP TABLE filter_parity_mixed (id int PRIMARY KEY, ${cols
          .map(([col, id]) => `${col} ${CASES[id]!.sqlType}`)
          .join(", ")})`,
      ),
    );
    const tuples = Array.from(
      { length: MIXED_ROWS },
      (_, row) =>
        `(${row}, ${cols.map(([, id]) => `${pick(CASES[id]!.values)}::${CASES[id]!.sqlType}`).join(", ")})`,
    );
    await db.execute(
      sql.raw(
        `INSERT INTO filter_parity_mixed (id, ${cols.map(([c]) => c).join(", ")}) VALUES ${tuples.join(", ")}`,
      ),
    );
    mixedRows = await driverRows<Record<string, unknown>>(
      "SELECT * FROM filter_parity_mixed ORDER BY id",
    );
  });

  test("400 seeded trees up to depth 4 agree", async () => {
    const rand = prng(42);
    const pick = <T>(xs: readonly T[]): T =>
      xs[Math.floor(rand() * xs.length)]!;
    const clauses = Object.entries(MIXED).flatMap(([column, id]) => {
      const c = CASES[id]!;
      return (Object.keys(filterOps) as FilterOpId[])
        .filter((op) => opAllowsDomain(op, c.domain))
        .flatMap((op) =>
          operandsFor(c, op).map((operand) => ({ column, op, operand })),
        );
    });
    const tree = (depth: number): Filter => {
      if (depth === 0 || rand() < 0.3) return pick(clauses) as Filter;
      const n = 1 + Math.floor(rand() * 3);
      const children = Array.from({ length: n }, () => tree(depth - 1));
      return rand() < 0.5 ? { and: children } : { or: children };
    };
    const targets = Object.fromEntries(
      Object.keys(MIXED).map((col) => [col, sql.raw(col)]),
    );
    const size = (f: Filter): number =>
      "and" in f
        ? f.and.reduce((n, c) => n + size(c), 0)
        : "or" in f
          ? f.or.reduce((n, c) => n + size(c), 0)
          : 1;
    let nonTrivial = 0;
    for (let i = 0; i < 400; i++) {
      let raw = tree(4);
      while (size(raw) > 50) raw = tree(4);
      const f = canonicalizeFilter(raw, mixedFilterable);
      const expected = memoryIds(mixedRows, f, mixedFilterable);
      const where = filterSql(f, targets, mixedFilterable) ?? sql`TRUE`;
      const actual = await ids("mixed", where);
      expect({ i, f, ids: actual }).toEqual({ i, f, ids: expected });
      if (expected.length > 0 && expected.length < MIXED_ROWS) nonTrivial++;
    }
    // The generator must actually exercise selective filters.
    expect(nonTrivial).toBeGreaterThan(100);
  });
});
