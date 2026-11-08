import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { is, SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  getTableConfig,
  index,
  integer,
  PgDialect,
  type PgTable,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type QueryConfig } from "pg";
import { parsedText } from "@plugins/database/plugins/sql-column/server";
import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { defineExtension } from "./define-extension";

// Every accessor takes an executor (the pool by default). The tests pass one
// that records every statement instead of sending it — so the accessors can be
// checked against the SQL they produce, with no database. It is the same
// node-postgres drizzle `db` is, over a pool that never connects: drizzle hands
// each statement to `pool.query`, which records it and answers no rows.
// (Not `mock.module` on `db`: bun runs every suite in one process, so a module
// mock leaks into every test file that runs after this one.)
const statements: { sql: string; params: unknown[] }[] = [];
const recordingPool = Object.assign(new Pool(), {
  query: async (config: QueryConfig, params: unknown[] = []) => {
    statements.push({ sql: config.text, params });
    return { rows: [] };
  },
});
const recordingDb = drizzle(recordingPool);

// ── A parent, and one extension built each way ──────────────────────────────
const parent = pgTable("ext_probe", { id: text("id").primaryKey() });

const SourceSchema = z.enum(["user", "agent"]);

// The OLD primitive, replicated verbatim: raw drizzle builders, the base
// columns spread around the plugin's columns, a bound index name.
const oldTable = pgTable(
  "ext_probe_ext_thing",
  {
    parentId: text("parent_id")
      .primaryKey()
      .references((): AnyPgColumn => parent.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    semitones: integer("semitones").notNull().default(0),
    enabled: boolean("enabled").notNull().default(false),
    label: text("label"),
    source: parsedText("source", SourceSchema).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("ext_probe_ext_thing_label_idx").on(t.label, t.createdAt)],
);

// The NEW primitive: one shape, one call.
const thingShape = defineExtensionShape({
  key: "songId",
  fields: {
    semitones: intField(),
    enabled: boolField(),
    label: nullable(textField()),
    source: enumTextField(["user", "agent"]),
  },
  serverOnly: ["label"],
  wireTimestamps: ["updatedAt"],
});
const thing = defineExtension(parent, "thing", thingShape, {
  columns: { semitones: { default: 0 }, enabled: { default: false } },
  indexes: (t, b) => [b.index("label").on(t.label, t.createdAt)],
});
// Every own column optional on insert, so an empty upsert is well-typed.
const bareShape = defineExtensionShape({
  key: "songId",
  fields: { label: nullable(textField()) },
});
const bare = defineExtension(parent, "bare", bareShape);

// ── DDL: byte-identical to the old primitive ────────────────────────────────
const dialect = new PgDialect();
const renderDefault = (d: unknown): unknown =>
  is(d, SQL) ? dialect.sqlToQuery(d).sql : d;

function ddl(table: PgTable) {
  const config = getTableConfig(table);
  return {
    name: config.name,
    columns: config.columns.map((c) => ({
      name: c.name,
      type: c.getSQLType(),
      notNull: c.notNull,
      primary: c.primary,
      hasDefault: c.hasDefault,
      default: renderDefault(c.default),
    })),
    primaryKeys: config.primaryKeys.map((pk) => pk.getName()),
    foreignKeys: config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        name: fk.getName(),
        columns: ref.columns.map((c) => c.name),
        foreignTable: getTableConfig(ref.foreignTable).name,
        foreignColumns: ref.foreignColumns.map((c) => c.name),
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      };
    }),
    indexes: config.indexes.map((i) => ({
      name: i.config.name,
      unique: i.config.unique,
      columns: i.config.columns.map((c) => (c as { name: string }).name),
    })),
  };
}

describe("defineExtension DDL", () => {
  test("matches the old raw-drizzle primitive column for column", () => {
    // Same columns, keys, indexes; only the ORDER differs: the shape's
    // server-only fields (`label`, `created_at`) are the entity's server fields,
    // appended after the ref's wire fields.
    const byName = <T extends { name: string }>(cols: T[]) =>
      [...cols].sort((a, b) => a.name.localeCompare(b.name));
    const got = ddl(thing.table);
    const want = ddl(oldTable);
    expect({ ...got, columns: byName(got.columns) }).toEqual({
      ...want,
      columns: byName(want.columns),
    });
  });

  test("spells out the columns it must keep", () => {
    const { columns, foreignKeys } = ddl(thing.table);
    // The ref's (wire) fields in shape order, then the server-only ones in
    // shape order (drizzle diffs columns by name, so the move needs no migration).
    expect(columns.map((c) => c.name)).toEqual([
      "parent_id",
      "semitones",
      "enabled",
      "source",
      "updated_at",
      "label",
      "created_at",
    ]);
    expect(columns[0]).toMatchObject({ type: "text", primary: true });
    expect(foreignKeys).toEqual([
      expect.objectContaining({
        columns: ["parent_id"],
        foreignTable: "ext_probe",
        foreignColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    ]);
  });

  test("the key column is named after the parent key, stored as parent_id", () => {
    expect(thing.key).toBe("songId");
    expect(thing.table.songId.name).toBe("parent_id");
    expect(thing.name).toBe("ext_probe_ext_thing");
  });
});

// ── Wire ────────────────────────────────────────────────────────────────────
describe("defineExtension wire", () => {
  test("schema IS the shape's schema", () => {
    expect(thing.schema).toBe(thingShape.schema);
  });

  test("wire = key + own fields − serverOnly + wireTimestamps", () => {
    const expected = ["songId", "semitones", "enabled", "source", "updatedAt"];
    expect(Object.keys(thing.schema.shape)).toEqual(expected);
    expect(Object.keys(thing.wireColumns)).toEqual(expected);
    expect(thing.wireColumns.songId).toBe(thing.table.songId);
  });
});

// ── Accessors: every one goes through the key column ────────────────────────
describe("defineExtension accessors", () => {
  test("get / upsert / update / delete key on parent_id", async () => {
    statements.length = 0;
    await thing.get("s1", recordingDb);
    await thing.upsert("s1", { semitones: 2, source: "user" }, recordingDb);
    await thing.update("s1", { label: "x" }, recordingDb);
    await thing.delete("s1", recordingDb);

    const [get, upsert, update, del] = statements;
    expect(get?.sql).toContain(`where "ext_probe_ext_thing"."parent_id" = $1`);
    expect(get?.params).toEqual(["s1", 1]);

    expect(upsert?.sql).toMatch(/^insert into "ext_probe_ext_thing"/);
    expect(upsert?.sql).toContain(`on conflict ("parent_id") do update`);
    expect(upsert?.params).toContain("s1");
    expect(upsert?.params).toContain(2);

    expect(update?.sql).toMatch(
      /^update "ext_probe_ext_thing" set "label" = \$1/,
    );
    expect(update?.sql).toContain(
      `where "ext_probe_ext_thing"."parent_id" = $2`,
    );
    expect(update?.sql).not.toContain("insert");

    expect(del?.sql).toBe(
      `delete from "ext_probe_ext_thing" where "ext_probe_ext_thing"."parent_id" = $1`,
    );
    expect(del?.params).toEqual(["s1"]);
  });

  // The statement `upsert` runs, built but not run and without RETURNING — so
  // it can stand as one arm of a data-modifying CTE.
  test("upsertQuery is upsert's statement, unexecuted, without returning", async () => {
    statements.length = 0;
    await thing.upsert("s1", { semitones: 2, source: "user" }, recordingDb);
    const [upsert] = statements;
    const built = new PgDialect().sqlToQuery(
      thing.upsertQuery("s1", { semitones: 2, source: "user" }),
    );
    expect(upsert?.sql).toBe(
      `${built.sql} returning ${returningOf(upsert?.sql)}`,
    );
    expect(built.sql).not.toContain("returning");
    expect(built.params).toEqual(upsert?.params ?? []);
  });

  // Composed into a data-modifying CTE, it stays bare: a parenthesised main
  // statement (what an embedded drizzle builder renders as) is a syntax error.
  test("upsertQuery composes into a CTE unparenthesised", () => {
    const arm = thing.upsertQuery("s1", { semitones: 1, source: "user" });
    const main = thing.upsertQuery("s2", { semitones: 2, source: "agent" });
    const built = new PgDialect().sqlToQuery(sql`WITH a AS (${arm}) ${main}`);
    expect(built.sql).toMatch(
      /^WITH a AS \(insert into "ext_probe_ext_thing" .*\) insert into "ext_probe_ext_thing" /,
    );
    // One placeholder numbering across both arms.
    expect(built.params.indexOf("s1")).toBeLessThan(built.params.indexOf("s2"));
    expect(built.sql).toContain(`$${built.params.length}`);
  });
});

// `onlyIf`: the INSERT half proposes its row only while the condition holds
// (`INSERT … SELECT … WHERE`), the SET list is the given columns — so a parent
// gone under the writer writes nothing instead of failing the foreign key.
describe("upsertQuery with onlyIf", () => {
  test("is INSERT … SELECT … WHERE, its SET the given columns", () => {
    const built = new PgDialect().sqlToQuery(
      thing.upsertQuery(
        "s1",
        { semitones: 3, source: "user" },
        {
          onlyIf: sql`exists (select 1 from "ext_probe" where "id" = ${"s1"})`,
        },
      ),
    );
    expect(built.sql).toBe(
      `insert into "ext_probe_ext_thing" ("parent_id", "semitones", "source") ` +
        `select $1::text, $2::integer, $3::text ` +
        `where exists (select 1 from "ext_probe" where "id" = $4) ` +
        `on conflict ("parent_id") do update set "semitones" = excluded."semitones", "source" = excluded."source"`,
    );
    expect(built.params).toEqual(["s1", 3, "user", "s1"]);
  });

  test("an empty patch rewrites the key, as upsert does", () => {
    const built = new PgDialect().sqlToQuery(
      bare.upsertQuery("s1", {}, { onlyIf: sql`true` }),
    );
    expect(built.sql).toEndWith(
      `do update set "parent_id" = excluded."parent_id"`,
    );
  });

  test("refuses the derived updatedAt at runtime, for a caller typed loosely", () => {
    const loose = thing.upsertQuery as (
      id: string,
      v: Record<string, unknown>,
      o: { onlyIf: SQL },
    ) => SQL;
    expect(() =>
      loose("s1", { updatedAt: new Date() }, { onlyIf: sql`true` }),
    ).toThrow(/"updatedAt" is not one of its own columns/);
  });
});

// The derived `updatedAt` is out of the table's insert model: a typed write of
// it is a tsc error (the trigger would refuse it at runtime).
function _derivedUpdatedAtHasNoTypedSpelling() {
  void recordingDb.update(thing.table).set({
    // @ts-expect-error — updatedAt is derived, not writable
    updatedAt: new Date(),
  });
  const row: (typeof thing.table)["$inferInsert"] = {
    songId: "s",
    source: "user",
    // @ts-expect-error — nor on insert
    updatedAt: new Date(),
  };
  void recordingDb
    .insert(thing.table)
    .values(row)
    .onConflictDoUpdate({
      target: thing.table.songId,
      set: {
        // @ts-expect-error — nor in an upsert's SET
        updatedAt: new Date(),
      },
    });
}
void _derivedUpdatedAtHasNoTypedSpelling;

function returningOf(statement: string | undefined): string {
  const m = statement?.match(/ returning (.*)$/);
  if (!m?.[1]) throw new Error(`no returning in: ${statement}`);
  return m[1];
}

// ── Derived updatedAt: default all-true, per-column overrides ───────────────
// The statement's conflict set, and whether any bound value is a timestamp: an
// upsert leaves `updated_at` to its column default on insert and to the
// trigger on conflict, so it binds no Date anywhere.
function conflictSet(sql: string | undefined): string {
  const m = sql?.match(/do update set (.*) returning/);
  if (!m?.[1]) throw new Error(`no conflict set in: ${sql}`);
  return m[1];
}
const bindsADate = (params: unknown[] | undefined) =>
  (params ?? []).some(
    (p) => p instanceof Date || /^\d{4}-\d\d-\d\dT/.test(String(p)),
  );

describe("defineExtension derived updatedAt", () => {
  test("every own column counts; the key and createdAt never do", () => {
    const spec = thing.derivedUpdatedAt;
    if (!spec) throw new Error("expected a derived updatedAt spec");
    for (const col of ["semitones", "enabled", "label", "source"]) {
      expect(spec.functionDdl).toContain(
        `NEW."${col}" IS DISTINCT FROM OLD."${col}"`,
      );
    }
    expect(spec.functionDdl).not.toContain(`NEW."parent_id" IS DISTINCT`);
    expect(spec.functionDdl).not.toContain(`NEW."created_at" IS DISTINCT`);
  });

  test("a meta.touchedBy override is honoured", () => {
    const overridden = defineExtension(parent, "overridden", thingShape, {
      touchedBy: { enabled: false, source: { into: ["agent"] } },
    });
    const spec = overridden.derivedUpdatedAt;
    if (!spec) throw new Error("expected a derived updatedAt spec");
    expect(spec.functionDdl).not.toContain(`NEW."enabled" IS DISTINCT`);
    expect(spec.functionDdl).toContain(
      `NEW."semitones" IS DISTINCT FROM OLD."semitones"`,
    );
    expect(spec.functionDdl).toContain(`'agent'`);
  });

  test("upsert never writes updated_at", async () => {
    statements.length = 0;
    await thing.upsert(
      "s1",
      { semitones: 2, label: "x", source: "user" },
      recordingDb,
    );
    const [upsert] = statements;
    expect(conflictSet(upsert?.sql)).toBe(
      `"semitones" = $5, "source" = $6, "label" = $7`,
    );
    expect(bindsADate(upsert?.params)).toBe(false);
  });

  test("an empty patch rewrites the key with its own value", async () => {
    statements.length = 0;
    await bare.upsert("s1", {}, recordingDb);
    await bare.upsert("s2", { label: undefined }, recordingDb);
    for (const [i, id] of ["s1", "s2"].entries()) {
      const upsert = statements[i];
      expect(conflictSet(upsert?.sql)).toBe(`"parent_id" = $2`);
      expect(bindsADate(upsert?.params)).toBe(false);
      expect(upsert?.params.filter((p) => p === id)).toHaveLength(2);
    }
  });

  test("update never writes updated_at; an empty patch only reads", async () => {
    statements.length = 0;
    await thing.update("s1", { semitones: 3 }, recordingDb);
    await thing.update("s1", { label: undefined }, recordingDb);
    const [update, read] = statements;
    expect(update?.sql).toMatch(
      /^update "ext_probe_ext_thing" set "semitones" = \$1 /,
    );
    expect(bindsADate(update?.params)).toBe(false);
    expect(read?.sql).toMatch(/^select /);
  });
});

// Never run: an upsert must carry every column without a DB default, since
// its INSERT half is checked for NOT NULL before the conflict is resolved.
async function _upsertTypeTests(): Promise<void> {
  // @ts-expect-error — `source` has no default, so an upsert must give it.
  await thing.upsert("s1", { semitones: 2 }, recordingDb);
  // A partial write to an existing row is `update`'s.
  await thing.update("s1", { semitones: 2 }, recordingDb);
}

// Never run (it would register a table): declarations the types must refuse.
function _touchedByTypeTests(): void {
  defineExtension(parent, "types", thingShape, {
    // @ts-expect-error — "robot" is not a value of `source`.
    touchedBy: { source: { into: ["robot"] } },
  });
  defineExtension(parent, "types", thingShape, {
    // @ts-expect-error — the key is the primitive's, never overridable.
    touchedBy: { songId: true },
  });
  defineExtension(parent, "types", thingShape, {
    // @ts-expect-error — nor is createdAt.
    touchedBy: { createdAt: true },
  });
}
void _touchedByTypeTests;
void _upsertTypeTests;

describe("defineExtension throws", () => {
  test("on a reserved field, at shape definition", () => {
    expect(() =>
      defineExtension(
        parent,
        "bad",
        defineExtensionShape({
          key: "songId",
          fields: { createdAt: textField() },
        }),
      ),
    ).toThrow(/field "createdAt" is reserved/);
  });
});

// ── Compile-time: the loader's rows ≡ the wire schema ───────────────────────
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

// Never called — it exists so `typeof` can read the row type a
// `db.select(ext.wireColumns)` loader returns.
function wireLoader() {
  return recordingDb.select(thing.wireColumns).from(thing.table);
}
type _LoaderRow = Awaited<ReturnType<typeof wireLoader>>[number];
type _WireRow = z.infer<typeof thing.schema>;
// Exported so noUnusedLocals keeps the assertions (type-test aliases).
export type _LoaderRowIsWireRow = Expect<Equal<_LoaderRow, _WireRow>>;
export type _WireRowSpelledOut = Expect<
  Equal<
    _WireRow,
    {
      songId: string;
      semitones: number;
      enabled: boolean;
      source: "user" | "agent";
      updatedAt: Date;
    }
  >
>;
// `get` returns the FULL row, server-only columns included.
type _FullRow = NonNullable<Awaited<ReturnType<typeof thing.get>>>;
export type _GetReturnsFullRow = Expect<
  Equal<
    _FullRow,
    _WireRow & { label: string | null; createdAt: Date } extends infer R
      ? { [K in keyof R]: R[K] }
      : never
  >
>;
// `upsert`'s patch: own fields only, DB-defaulted ones optional.
type _Patch = Parameters<typeof thing.upsert>[1];
export type _PatchOmitsPrimitiveKeys = Expect<
  Equal<Extract<keyof _Patch, "songId" | "createdAt" | "updatedAt">, never>
>;
