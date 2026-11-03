/**
 * The raw-SQL helpers (`raw-sql.ts`, step 16b.1 of
 * research/2026-10-06-global-scoped-change-routing-p8-v3.md): each renders
 * through drizzle's real dialect. `anyOf`'s two invalid-id policies are pinned
 * to the exact text the join routes' probes and the union's id reads ran
 * before they shared it (the union snapshot and the compile golden pin them
 * end to end); the Postgres behaviour of each is network/live's
 * `serve-union-oracle.test.ts` (a bad uuid key absent) and the reverse-probe
 * oracles.
 */

import { describe, expect, test } from "bun:test";
import { sql, type SQL } from "drizzle-orm";
import {
  integer,
  PgDialect,
  pgTable,
  text,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { BASE_RELATION } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { compileJoins } from "./joins";
import {
  allOf,
  anyOf,
  canonicalSqlType,
  decoderOfRead,
  fromSql,
  nullOf,
} from "./raw-sql";

const dialect = new PgDialect();
const render = (q: SQL) => {
  const { sql: text, params } = dialect.sqlToQuery(q);
  return { sql: text, params };
};

const owners = pgTable("rs_owners", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
const items = pgTable("rs_items", {
  id: uuid("id").primaryKey(),
  ownerId: text("owner_id"),
  code: integer("code").notNull(),
  slug: varchar("slug"),
  label: text("label"),
});

describe("anyOf", () => {
  test("throws: one array param cast to the column's own type", () => {
    expect(
      render(anyOf(items.code, ["1", "2"], { invalid: "throws" })),
    ).toEqual({
      sql: `"rs_items"."code" = ANY($1::integer[])`,
      params: [["1", "2"]],
    });
    expect(render(anyOf(owners.id, ["a"], { invalid: "throws" }))).toEqual({
      sql: `"rs_owners"."id" = ANY($1::text[])`,
      params: [["a"]],
    });
  });

  test("absent: a text column compares the text array as is", () => {
    expect(render(anyOf(owners.id, ["a", "b"], { invalid: "absent" }))).toEqual(
      {
        sql: `"rs_owners"."id" = ANY($1::text[])`,
        params: [["a", "b"]],
      },
    );
  });

  test("absent: any other type keeps only the ids pg_input_is_valid accepts", () => {
    expect(render(anyOf(items.id, ["x"], { invalid: "absent" }))).toEqual({
      sql: `"rs_items"."id" = ANY(ARRAY(SELECT x::uuid FROM unnest($1::text[]) AS x WHERE pg_input_is_valid(x, $2)))`,
      params: [["x"], "uuid"],
    });
    // varchar is not text by name: its ids are validated too.
    expect(
      render(anyOf(items.slug, ["s"], { invalid: "absent" })).sql,
    ).toContain("pg_input_is_valid");
  });

  test("the policy is required (tsc)", () => {
    // @ts-expect-error — an id list states what a bad id does
    const unstated = () => anyOf(owners.id, ["a"]);
    expect(typeof unstated).toBe("function");
  });
});

describe("type names and constants", () => {
  test("canonicalSqlType folds spellings, case and spacing, arrays included", () => {
    expect(canonicalSqlType("TIMESTAMPTZ")).toBe("timestamp with time zone");
    expect(canonicalSqlType("int4")).toBe("integer");
    expect(canonicalSqlType("float8[]")).toBe("double precision[]");
    expect(canonicalSqlType("  Timestamp   With Time Zone ")).toBe(
      "timestamp with time zone",
    );
    expect(canonicalSqlType("uuid")).toBe("uuid");
  });

  test("nullOf is a typed NULL", () => {
    expect(render(nullOf("timestamp with time zone")).sql).toBe(
      "NULL::timestamp with time zone",
    );
  });

  test("decoderOfRead: a column decodes as itself, an expression by its mapWith", () => {
    expect(decoderOfRead(items.code)).toBe(items.code);
    const mapped = sql`(1)`.mapWith(Number);
    expect(decoderOfRead(mapped).mapFromDriverValue("4")).toBe(4);
  });

  test("allOf: undefined when nothing is present, the conjunction otherwise", () => {
    expect(allOf([undefined, undefined])).toBeUndefined();
    expect(render(allOf([sql`a`, undefined, sql`b`])!).sql).toBe("(a and b)");
  });
});

describe("fromSql", () => {
  const plan = compileJoins(
    { table: items, name: "rs_items" },
    [
      {
        kind: "lookup",
        alias: "owner",
        table: owners,
        pk: owners.id,
        on: { from: BASE_RELATION, col: items.ownerId },
        required: true,
      },
    ],
    items.id,
    "rs",
  );
  const base = { table: items, name: "rs_items" };

  test("renders the base and the included joins under their aliases", () => {
    expect(render(fromSql(base, plan, new Set(), "rs")).sql).toBe(`"rs_items"`);
    expect(render(fromSql(base, plan, new Set(["owner"]), "rs")).sql).toBe(
      `"rs_items" INNER JOIN "rs_owners" "owner" ON "owner"."id" = "rs_items"."owner_id"`,
    );
  });

  test("throws on an included relation no join declares", () => {
    expect(() =>
      fromSql(base, plan, new Set(["member_x"]), 'union arm "a"'),
    ).toThrow(/union arm "a": the tuple includes relation "member_x"/);
  });
});
