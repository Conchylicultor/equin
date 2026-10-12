import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { is, SQL } from "drizzle-orm";
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
import { drizzle } from "drizzle-orm/pg-proxy";
import type { DbExecutor } from "@plugins/database/server";
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

// A drizzle proxy that records every statement instead of sending it — so the
// accessors can be checked against the SQL they produce, with no database. It
// is handed to each accessor as its executor (never swapped in via
// `mock.module`: a bun module mock is process-wide and would leak into every
// suite sharing the `./singularity test` run).
const statements: { sql: string; params: unknown[] }[] = [];
const recordingDb = drizzle(async (sql, params) => {
  statements.push({ sql, params });
  return { rows: [] };
});
// The accessors only call pg-core query builders (select / insert / delete),
// which the pg-proxy and node-postgres drizzles share; `DbExecutor` is spelled
// as the node-postgres pool-or-tx type, hence the cast.
const exec = recordingDb as unknown as DbExecutor;

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
    expect(ddl(thing.table)).toEqual(ddl(oldTable));
  });

  test("spells out the columns it must keep", () => {
    const { columns, foreignKeys } = ddl(thing.table);
    // Positional: drizzle-kit diffs by position, so the order is the contract.
    expect(columns.map((c) => c.name)).toEqual([
      "parent_id",
      "semitones",
      "enabled",
      "label",
      "source",
      "created_at",
      "updated_at",
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
  test("get / upsert / delete key on parent_id", async () => {
    statements.length = 0;
    await thing.get("s1", exec);
    await thing.upsert("s1", { semitones: 2 }, exec);
    await thing.delete("s1", exec);

    const [get, upsert, del] = statements;
    expect(get?.sql).toContain(`where "ext_probe_ext_thing"."parent_id" = $1`);
    expect(get?.params).toEqual(["s1", 1]);

    expect(upsert?.sql).toMatch(/^insert into "ext_probe_ext_thing"/);
    expect(upsert?.sql).toContain(`on conflict ("parent_id") do update`);
    expect(upsert?.params).toContain("s1");
    expect(upsert?.params).toContain(2);

    expect(del?.sql).toBe(
      `delete from "ext_probe_ext_thing" where "ext_probe_ext_thing"."parent_id" = $1`,
    );
    expect(del?.params).toEqual(["s1"]);
  });
});

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
    await thing.upsert("s1", { semitones: 2, label: "x" }, exec);
    const [upsert] = statements;
    expect(conflictSet(upsert?.sql)).toBe(`"semitones" = $4, "label" = $5`);
    expect(bindsADate(upsert?.params)).toBe(false);
  });

  test("an empty patch rewrites the key with its own value", async () => {
    statements.length = 0;
    await thing.upsert("s1", {}, exec);
    await thing.upsert("s2", { label: undefined }, exec);
    for (const [i, id] of ["s1", "s2"].entries()) {
      const upsert = statements[i];
      expect(conflictSet(upsert?.sql)).toBe(`"parent_id" = $2`);
      expect(bindsADate(upsert?.params)).toBe(false);
      expect(upsert?.params.filter((p) => p === id)).toHaveLength(2);
    }
  });
});

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
