import { test, expect } from "bun:test";
import { z } from "zod";
import {
  doublePrecision,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { getTableConfig, PgCustomColumn } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import { SqlColumnError } from "@plugins/database/plugins/sql-column/server/testing";
import type { StorageColumnFor } from "@plugins/fields/plugins/server-capabilities/server";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { defineFieldType } from "@plugins/fields/core";
import type { FieldDef } from "@plugins/fields/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { defineEntity } from "./define-entity";
import { defaultNow, defaultRandom } from "./types";

// ── Throwaway field types + storage builders ───────────────────────────────
// Local field types via fields/core keep this unit decoupled from concrete
// field-type plugins (importing a sibling type would form a cross-plugin
// cycle).
const textType = defineFieldType<string>("__ent_text__");
const uuidType = defineFieldType<string>("__ent_uuid__");
const intType = defineFieldType<number>("__ent_int__");
const floatType = defineFieldType<number>("__ent_float__");
const dateType = defineFieldType<Date>("__ent_date__");
// A type with NO storage contribution — exercises the throw path.
const noStorageType = defineFieldType<string>("__ent_no_storage__");
// A type whose column is narrowed by the FIELD's own schema — the `decode` arm.
// Mirrors the real `text` storage contribution's discrimination so these tests
// exercise defineEntity's arm dispatch, not a stand-in for it.
const decodedTextType = defineFieldType<string>("__ent_decoded_text__");
const decodeText = <V extends string>(
  n: string,
  valueSchema: ZodParser<V>,
): StorageColumnFor<V> =>
  valueSchema instanceof z.ZodString
    ? // Sound: `ZodString`'s output IS `string`, which is not assignable to any
      // proper subtype of itself, so a `ZodParser<V>` for a narrower `V` can never
      // be a `ZodString`. TS cannot narrow a type parameter from an `instanceof`.
      (text(n) as unknown as StorageColumnFor<V>)
    : parsedText(n, valueSchema);

// json field type is generic over its payload T; build it per-payload below.
function jsonType<T>() {
  return defineFieldType<T>("__ent_json__");
}
// The jsonb column is narrowed by the FIELD's own schema too. Mirrors the real
// `json` storage contribution's discrimination, so these tests exercise
// defineEntity's arm dispatch rather than a stand-in for it.
const decodeJson = <V>(
  n: string,
  valueSchema: ZodParser<V>,
): StorageColumnFor<V> =>
  valueSchema instanceof z.ZodUnknown
    ? // Sound for the same reason as the text branch: `ZodUnknown`'s output IS
      // `unknown`, which no narrower `V` can be, so passing the `instanceof`
      // proves `V` is `unknown`.
      (jsonb(n) as unknown as StorageColumnFor<V>)
    : parsedJson(n, valueSchema);

collectContributions([
  {
    id: "define-entity-test",
    contributions: [
      Fields.Storage({ type: textType, build: (n) => text(n) }),
      Fields.Storage({ type: uuidType, build: (n) => uuid(n) }),
      Fields.Storage({ type: intType, build: (n) => integer(n) }),
      Fields.Storage({ type: floatType, build: (n) => doublePrecision(n) }),
      Fields.Storage({ type: jsonType<unknown>(), decode: decodeJson }),
      Fields.Storage({
        type: dateType,
        build: (n) => timestamp(n, { withTimezone: true }),
      }),
      Fields.Storage({ type: decodedTextType, decode: decodeText }),
    ],
  },
]);

// ── Field-def helpers ──────────────────────────────────────────────────────
function field<T>(
  type: ReturnType<typeof defineFieldType<T>>,
  schema: z.ZodType<T>,
  defaultValue: T,
): FieldDef<T> {
  return Object.freeze({ type, schema, defaultValue, meta: {} });
}

// Payload shapes for the json columns (mirror slow_ops core types).
interface CallerBreakdown {
  caller: string;
  count: number;
}
interface SlowOpSample {
  at: number;
  load: number;
}

// ── The slow_ops shape, rebuilt through defineEntity ───────────────────────
function buildSlowOps() {
  return defineEntity(
    "slow_ops",
    {
      id: field(uuidType, z.string(), ""),
      worktree: field(textType, z.string(), ""),
      operationKind: field(textType, z.string(), ""),
      operation: field(textType, z.string(), ""),
      count: field(intType, z.number(), 0),
      totalMs: field(floatType, z.number(), 0),
      maxMs: field(floatType, z.number(), 0),
      lastMs: field(floatType, z.number(), 0),
      thresholdMs: field(floatType, z.number(), 0),
      callers: field(
        jsonType<CallerBreakdown[]>(),
        z.array(
          z.object({ caller: z.string(), count: z.number() }),
        ) as z.ZodType<CallerBreakdown[]>,
        [],
      ),
      recentSamples: field(
        jsonType<SlowOpSample[]>(),
        z.array(z.object({ at: z.number(), load: z.number() })) as z.ZodType<
          SlowOpSample[]
        >,
        [],
      ),
      firstSeenAt: field(dateType, z.date(), new Date(0)),
      lastSeenAt: field(dateType, z.date(), new Date(0)),
    },
    {
      primaryKey: "id",
      columns: {
        id: { default: defaultRandom() },
        count: { default: 0 },
        totalMs: { default: 0 },
        maxMs: { default: 0 },
        lastMs: { default: 0 },
        thresholdMs: { default: 0 },
        callers: { default: [] },
        recentSamples: { default: [] },
        firstSeenAt: { default: defaultNow() },
        lastSeenAt: { default: defaultNow() },
      },
    },
  );
}

test("defineEntity reproduces the slow_ops column names (snake_case)", () => {
  const slowOps = buildSlowOps();
  const { columns } = getTableConfig(slowOps.table);
  const byName = new Map(columns.map((c) => [c.name, c]));

  // snake_case DDL column names, keyed by JS prop in the entity record.
  expect(slowOps.table.operationKind.name).toBe("operation_kind");
  expect(slowOps.table.totalMs.name).toBe("total_ms");
  expect(slowOps.table.firstSeenAt.name).toBe("first_seen_at");
  expect(slowOps.table.recentSamples.name).toBe("recent_samples");
  expect(slowOps.table.worktree.name).toBe("worktree");

  expect(byName.has("operation_kind")).toBe(true);
  expect(byName.has("total_ms")).toBe(true);
  expect(byName.has("first_seen_at")).toBe(true);
});

test("defineEntity reproduces per-column notNull / primary / hasDefault / SQL type", () => {
  const slowOps = buildSlowOps();
  const { columns } = getTableConfig(slowOps.table);
  const col = (name: string) => {
    const c = columns.find((c) => c.name === name);
    if (!c) throw new Error(`no column ${name}`);
    return c;
  };

  // id: uuid, PK, defaultRandom (hasDefault), notNull
  const id = col("id");
  expect(id.getSQLType()).toBe("uuid");
  expect(id.primary).toBe(true);
  expect(id.notNull).toBe(true);
  expect(id.hasDefault).toBe(true);

  // worktree: text, notNull, NO default
  const worktree = col("worktree");
  expect(worktree.getSQLType()).toBe("text");
  expect(worktree.notNull).toBe(true);
  expect(worktree.hasDefault).toBe(false);
  expect(worktree.primary).toBe(false);

  // count: integer, notNull, default 0
  const count = col("count");
  expect(count.getSQLType()).toBe("integer");
  expect(count.notNull).toBe(true);
  expect(count.hasDefault).toBe(true);

  // totalMs: double precision, notNull, default 0
  const totalMs = col("total_ms");
  expect(totalMs.getSQLType()).toBe("double precision");
  expect(totalMs.notNull).toBe(true);
  expect(totalMs.hasDefault).toBe(true);

  // callers: jsonb, notNull, default []
  const callers = col("callers");
  expect(callers.getSQLType()).toBe("jsonb");
  expect(callers.notNull).toBe(true);
  expect(callers.hasDefault).toBe(true);

  // firstSeenAt: timestamp with time zone, notNull, defaultNow (hasDefault)
  const firstSeenAt = col("first_seen_at");
  expect(firstSeenAt.getSQLType()).toBe("timestamp with time zone");
  expect(firstSeenAt.notNull).toBe(true);
  expect(firstSeenAt.hasDefault).toBe(true);
});

test("defineEntity passes through indexes via the third-arg callback", () => {
  const { uniqueIndex } = require("drizzle-orm/pg-core");
  const slowOps = defineEntity(
    "slow_ops_idx",
    {
      id: field(uuidType, z.string(), ""),
      worktree: field(textType, z.string(), ""),
      operationKind: field(textType, z.string(), ""),
      operation: field(textType, z.string(), ""),
    },
    {
      primaryKey: "id",
      columns: { id: { default: defaultRandom() } },
      indexes: (t) => [
        uniqueIndex("slow_ops_kind_op_worktree_idx").on(
          t.operationKind,
          t.operation,
          t.worktree,
        ),
      ],
    },
  );

  const { indexes } = getTableConfig(slowOps.table);
  expect(indexes.length).toBe(1);
  const idx = indexes[0]!;
  expect(idx.config.name).toBe("slow_ops_kind_op_worktree_idx");
  expect(idx.config.unique).toBe(true);
  expect(idx.config.columns.map((c: any) => c.name)).toEqual([
    "operation_kind",
    "operation",
    "worktree",
  ]);
});

test("entity.schema validates a sample row", () => {
  const slowOps = buildSlowOps();
  const row = {
    id: "11111111-1111-1111-1111-111111111111",
    worktree: "main",
    operationKind: "http",
    operation: "GET /x",
    count: 3,
    totalMs: 12.5,
    maxMs: 9,
    lastMs: 4.2,
    thresholdMs: 2,
    callers: [{ caller: "loader", count: 3 }],
    recentSamples: [{ at: 1, load: 0.5 }],
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  };
  expect(() => slowOps.schema.parse(row)).not.toThrow();
});

test("defineEntity throws (naming key + type) for a field whose type has no storage", () => {
  expect(() =>
    defineEntity("bad", {
      id: field(uuidType, z.string(), ""),
      kind: field(noStorageType, z.string(), ""),
    }),
  ).toThrow(/"kind"/);
  expect(() =>
    defineEntity("bad", {
      id: field(uuidType, z.string(), ""),
      kind: field(noStorageType, z.string(), ""),
    }),
  ).toThrow(/__ent_no_storage__/);
});

// ── Compile-time guard: z.infer<schema> ≡ table.$inferSelect ────────────────
// The whole point of Stage C: the two derive from one FieldsRecord and must be
// identical by construction. A drift is a tsc error on this line.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const slowOpsForType = buildSlowOps();
type _SchemaInfer = z.infer<typeof slowOpsForType.schema>;
type _SelectInfer = (typeof slowOpsForType.table)["$inferSelect"];
// Exported so noUnusedLocals keeps the assertion (a type-test alias).
export type _RowMatchesWire = Expect<Equal<_SchemaInfer, _SelectInfer>>;

// ── Server-only columns: in the table DDL, off the wire ─────────────────────
// An entity with a `serverOnly` key keeps the column in the FULL table DDL but
// omits it from BOTH the derived wire `schema` and `wireColumns` (the loader's
// select-map). The column-builder loop is untouched, so `$inferSelect` still
// carries every column — the omit lives only on the wire side.
function buildServerOnlyEnt() {
  return defineEntity(
    "ent_server_only",
    {
      id: field(uuidType, z.string(), ""),
      pageId: field(textType, z.string(), ""),
      output: field(textType, z.string(), ""),
      // server-only columns:
      prompt: field(textType, z.string(), ""),
      createdAt: field(dateType, z.date(), new Date(0)),
    },
    {
      primaryKey: "id",
      serverOnly: ["prompt", "createdAt"],
      columns: {
        id: { default: defaultRandom() },
        createdAt: { default: defaultNow() },
      },
    },
  );
}

test("server-only columns stay in the DDL but leave the wire schema + wireColumns", () => {
  const ent = buildServerOnlyEnt();

  // (a) DDL is FULL — every column (incl. server-only) is a real table column.
  const { columns } = getTableConfig(ent.table);
  const ddlNames = new Set(columns.map((c) => c.name));
  expect(ddlNames.has("prompt")).toBe(true);
  expect(ddlNames.has("created_at")).toBe(true);
  expect(ddlNames.has("output")).toBe(true);

  // (b) wireColumns excludes the server-only keys, keeps the normal ones.
  const wireKeys = Object.keys(ent.wireColumns);
  expect(wireKeys).toContain("id");
  expect(wireKeys).toContain("pageId");
  expect(wireKeys).toContain("output");
  expect(wireKeys).not.toContain("prompt");
  expect(wireKeys).not.toContain("createdAt");
  // Each wire column is the real drizzle column proxy off the table.
  expect(ent.wireColumns.output).toBe(ent.table.output);

  // (c) the wire schema parses a row WITHOUT the server-only keys (strict object
  // would reject `prompt`/`createdAt` if they were still in the shape).
  const row = { id: "x", pageId: "p", output: "o" };
  expect(() => ent.schema.parse(row)).not.toThrow();
  const parsed = ent.schema.parse(row) as Record<string, unknown>;
  expect("prompt" in parsed).toBe(false);
  expect("createdAt" in parsed).toBe(false);
});

test("defineEntity throws when a serverOnly key is not a field", () => {
  expect(() =>
    defineEntity(
      "ent_bad_server_only",
      { id: field(uuidType, z.string(), "") },
      // `nope` is not a field key.
      { primaryKey: "id", serverOnly: ["nope" as "id"] },
    ),
  ).toThrow(/serverOnly key "nope" is not a field/);
});

test("defineEntity throws when a serverOnly key is the primary key", () => {
  // Single-column PK.
  expect(() =>
    defineEntity(
      "ent_pk_server_only",
      {
        id: field(uuidType, z.string(), ""),
        note: field(textType, z.string(), ""),
      },
      { primaryKey: "id", serverOnly: ["id"] },
    ),
  ).toThrow(/primary-key column "id" cannot be serverOnly/);

  // Composite PK.
  expect(() =>
    defineEntity(
      "ent_composite_pk_server_only",
      {
        a: field(textType, z.string(), ""),
        b: field(textType, z.string(), ""),
      },
      { primaryKey: ["a", "b"], serverOnly: ["b"] },
    ),
  ).toThrow(/primary-key column "b" cannot be serverOnly/);
});

// ── Compile-time guard: wire schema ≡ $inferSelect MINUS the server-only keys ─
// The full-column invariant becomes: `z.infer<schema>` equals `$inferSelect`
// with exactly the server-only keys removed. This is the server-only analogue
// of `_RowMatchesWire`.
const serverOnlyForType = buildServerOnlyEnt();
type _WireInfer = z.infer<typeof serverOnlyForType.schema>;
type _FullSelect = (typeof serverOnlyForType.table)["$inferSelect"];
export type _WireOmitsServerOnly = Expect<
  Equal<_WireInfer, Omit<_FullSelect, "prompt" | "createdAt">>
>;
// The server-only keys are genuinely absent from the wire schema shape…
export type _PromptOffWire = Expect<
  Equal<"prompt" extends keyof _WireInfer ? true : false, false>
>;
export type _CreatedAtOffWire = Expect<
  Equal<"createdAt" extends keyof _WireInfer ? true : false, false>
>;
// …while `$inferSelect` still carries them (they're real table columns).
export type _PromptOnSelect = Expect<
  Equal<"prompt" extends keyof _FullSelect ? true : false, true>
>;
// And `wireColumns` is typed WITHOUT the server-only keys.
type _WireCols = typeof serverOnlyForType.wireColumns;
export type _WireColsOmitsServerOnly = Expect<
  Equal<"prompt" extends keyof _WireCols ? true : false, false>
>;
export type _WireColsKeepsNormal = Expect<
  Equal<"output" extends keyof _WireCols ? true : false, true>
>;

// ── Compile-time guard: DB-defaulted columns are OPTIONAL on insert ─────────
// A column with a DB default (`meta.columns[k].default`, incl. defaultNow /
// defaultRandom / the `[]` rings) must NOT be required by `$inferInsert` — a
// loader inserting a row may omit it and let the DB fill it. This is exactly
// what `record-slow-op.ts` relies on (its insert omits id / recentSamples /
// firstSeenAt / lastSeenAt). Without the `HasDefault` brand on `EntityColumns`,
// the select-exact cast made every column required on insert — the Stage D
// regression this guards. `worktree` / `operationKind` / `operation` carry NO
// DB default, so they stay required.
type _Insert = (typeof slowOpsForType.table)["$inferInsert"];
type OptionalKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];
type RequiredKeys<T> = Exclude<keyof T, OptionalKeys<T>>;
// The defaulted columns must be optional…
export type _DefaultedColsAreOptional = Expect<
  Equal<
    Extract<
      | "id"
      | "count"
      | "totalMs"
      | "maxMs"
      | "lastMs"
      | "thresholdMs"
      | "callers"
      | "recentSamples"
      | "firstSeenAt"
      | "lastSeenAt",
      OptionalKeys<_Insert>
    >,
    | "id"
    | "count"
    | "totalMs"
    | "maxMs"
    | "lastMs"
    | "thresholdMs"
    | "callers"
    | "recentSamples"
    | "firstSeenAt"
    | "lastSeenAt"
  >
>;
// …and the no-DB-default columns must stay required.
export type _NoDefaultColsAreRequired = Expect<
  Equal<
    Extract<"worktree" | "operationKind" | "operation", RequiredKeys<_Insert>>,
    "worktree" | "operationKind" | "operation"
  >
>;

// Runtime mirror of the `record-slow-op.ts` insert shape: omitting every
// DB-defaulted column must satisfy the insert type. Compiles (and runs as a
// trivial assertion) iff the optionality above holds.
test("DB-defaulted columns may be omitted from an insert", () => {
  const insertValues: _Insert = {
    worktree: "main",
    operationKind: "http",
    operation: "GET /x",
  };
  expect(insertValues.worktree).toBe("main");
});

// ── Compile-time guard: nullable columns are optional on insert + `| null` on
// select ────────────────────────────────────────────────────────────────────
// A genuinely type-level-nullable field — `InferFieldValue` includes `null`, as
// produced by `nullable(...)` — must be OPTIONAL on insert (omit ⇒ NULL) and
// `T | null` on select, exactly like a hand-written nullable drizzle column. The
// prior unconditional `NotNull` brand on `EntityColumns` wrongly forced it
// REQUIRED on insert (mail-core never caught this — it has no partial inserts —
// and the FK test below casts its nullability away). This locks the fix.
function nullableTextFieldT(): FieldDef<string | null> {
  return field(
    textType as unknown as ReturnType<typeof defineFieldType<string | null>>,
    z.string().nullable(),
    null,
  );
}
const nullableEnt = defineEntity(
  "ent_nullable",
  { id: field(textType, z.string(), ""), note: nullableTextFieldT() },
  { primaryKey: "id" },
);
type _NullableInsert = (typeof nullableEnt.table)["$inferInsert"];
type _NullableSelect = (typeof nullableEnt.table)["$inferSelect"];
// `note` is OPTIONAL on insert…
export type _NullableColOptionalOnInsert = Expect<
  Equal<Extract<"note", OptionalKeys<_NullableInsert>>, "note">
>;
// …`string | null` on select…
export type _NullableColSelectType = Expect<
  Equal<_NullableSelect["note"], string | null>
>;
// …and the non-nullable `id` stays REQUIRED on insert.
export type _NonNullColStaysRequired = Expect<
  Equal<Extract<"id", RequiredKeys<_NullableInsert>>, "id">
>;

test("nullable columns may be omitted from an insert (default to NULL)", () => {
  const insertValues: _NullableInsert = { id: "x" };
  expect(insertValues.id).toBe("x");
});

// ── Compile-time guard: an enum-branded field's literal DB default stays
// optional-on-insert (no `DefaultedKeys` collapse) ──────────────────────────
// A field whose value type is a string-literal UNION (an enum-branded text
// column, as `enumTextField` produces) carrying a bare-literal DB default
// (`{ default: "a" }`) used to widen the WHOLE `meta.columns` object to the
// constraint shape, collapsing `DefaultedKeys` to `never` and forcing EVERY
// DB-defaulted column (incl. plain `defaultNow()` ones) required on insert. The
// `const M` type param on `defineEntity` keeps the meta literal so this can't
// happen. `field` casts mirror `enumTextField` (union value over the `text`
// storage token).
function enumBrandedField(): FieldDef<"a" | "b" | "c"> {
  return field(
    textType as unknown as ReturnType<typeof defineFieldType<"a" | "b" | "c">>,
    z.enum(["a", "b", "c"]) as unknown as z.ZodType<"a" | "b" | "c">,
    "a",
  );
}
const enumDefaultEnt = defineEntity(
  "ent_enum_default",
  {
    id: field(textType, z.string(), ""),
    status: enumBrandedField(),
    createdAt: field(dateType, z.coerce.date(), new Date(0)),
  },
  {
    primaryKey: "id",
    columns: { status: { default: "a" }, createdAt: { default: defaultNow() } },
  },
);
type _EnumInsert = (typeof enumDefaultEnt.table)["$inferInsert"];
// Both the enum-defaulted `status` AND the `defaultNow()` `createdAt` are
// OPTIONAL on insert (the collapse would have made them required)…
export type _EnumDefaultsOptional = Expect<
  Equal<
    Extract<"status" | "createdAt", OptionalKeys<_EnumInsert>>,
    "status" | "createdAt"
  >
>;
// …while the no-default `id` stays REQUIRED.
export type _EnumNonDefaultRequired = Expect<
  Equal<Extract<"id", RequiredKeys<_EnumInsert>>, "id">
>;

test("enum-branded literal DB default does not collapse insert optionality", () => {
  const insertValues: _EnumInsert = { id: "x" };
  expect(insertValues.id).toBe("x");
});

// ── Foreign keys: cascade / set-null / self-ref / composite junction ────────
// A relational cluster (the mail-core shape that motivated FK support): a root
// table, a child with a CASCADE FK + a nullable SELF FK (SET NULL), and a
// composite-PK junction whose two columns each CASCADE to a different parent.
// `null` schema makes the SELF-FK column nullable so SET NULL is valid; cast to
// `z.ZodType<string>` keeps the throwaway field type happy (runtime nullability
// is read off the raw schema instance, exactly like a real nullable field).
function nullableField(): FieldDef<string> {
  return field(
    textType,
    z.string().nullable() as unknown as z.ZodType<string>,
    "",
  );
}

test("defineEntity emits FK constraints (cascade, set-null, self-ref, composite)", () => {
  const accounts = defineEntity(
    "fk_accounts",
    { id: field(textType, z.string(), "") },
    { primaryKey: "id" },
  );

  const labels = defineEntity(
    "fk_labels",
    {
      id: field(textType, z.string(), ""),
      accountId: field(textType, z.string(), ""),
      parentId: nullableField(),
    },
    {
      primaryKey: "id",
      columns: {
        accountId: {
          references: { column: () => accounts.table.id, onDelete: "cascade" },
        },
        // Self reference — the `AnyPgColumn` annotation breaks circular inference.
        parentId: {
          references: {
            column: (): AnyPgColumn => labels.table.id,
            onDelete: "set null",
          },
        },
      },
    },
  );

  const messages = defineEntity(
    "fk_messages",
    {
      id: field(textType, z.string(), ""),
      accountId: field(textType, z.string(), ""),
    },
    {
      primaryKey: "id",
      columns: {
        accountId: {
          references: { column: () => accounts.table.id, onDelete: "cascade" },
        },
      },
    },
  );

  const messageLabels = defineEntity(
    "fk_message_labels",
    {
      messageId: field(textType, z.string(), ""),
      labelId: field(textType, z.string(), ""),
    },
    {
      primaryKey: ["messageId", "labelId"],
      columns: {
        messageId: {
          references: { column: () => messages.table.id, onDelete: "cascade" },
        },
        labelId: {
          references: { column: () => labels.table.id, onDelete: "cascade" },
        },
      },
    },
  );

  // Helper: { localCol → { table, foreignCol, onDelete } } for a table's FKs.
  const fkMap = (t: Parameters<typeof getTableConfig>[0]) =>
    new Map(
      getTableConfig(t).foreignKeys.map((fk) => {
        const ref = fk.reference();
        return [
          ref.columns[0]!.name,
          {
            table: getTableConfig(ref.foreignTable).name,
            foreignCol: ref.foreignColumns[0]!.name,
            onDelete: fk.onDelete,
          },
        ] as const;
      }),
    );

  // labels: account_id → accounts.id CASCADE; parent_id → labels.id SET NULL.
  const labelFks = fkMap(labels.table);
  expect(labelFks.get("account_id")).toEqual({
    table: "fk_accounts",
    foreignCol: "id",
    onDelete: "cascade",
  });
  expect(labelFks.get("parent_id")).toEqual({
    table: "fk_labels",
    foreignCol: "id",
    onDelete: "set null",
  });
  // The SET-NULL target column must be nullable, else the constraint is invalid.
  expect(labels.table.parentId.notNull).toBe(false);

  // messages: account_id → accounts.id CASCADE.
  expect(fkMap(messages.table).get("account_id")).toEqual({
    table: "fk_accounts",
    foreignCol: "id",
    onDelete: "cascade",
  });

  // Junction: composite PK + two CASCADE FKs to different parents.
  const jl = messageLabels.table;
  const { primaryKeys } = getTableConfig(jl);
  expect(primaryKeys[0]!.columns.map((c) => c.name)).toEqual([
    "message_id",
    "label_id",
  ]);
  const jlFks = fkMap(jl);
  expect(jlFks.get("message_id")).toEqual({
    table: "fk_messages",
    foreignCol: "id",
    onDelete: "cascade",
  });
  expect(jlFks.get("label_id")).toEqual({
    table: "fk_labels",
    foreignCol: "id",
    onDelete: "cascade",
  });
});

test("defineEntity defaults the FK action to NO ACTION when none is given", () => {
  const parent = defineEntity(
    "fk_noaction_parent",
    { id: field(textType, z.string(), "") },
    { primaryKey: "id" },
  );
  const child = defineEntity(
    "fk_noaction_child",
    {
      id: field(textType, z.string(), ""),
      parentId: field(textType, z.string(), ""),
    },
    {
      primaryKey: "id",
      columns: { parentId: { references: { column: () => parent.table.id } } },
    },
  );

  // drizzle normalizes a missing onDelete/onUpdate to "no action" (Postgres's
  // own default), so an action-less FK is identical to a hand-written bare FK.
  const fk = getTableConfig(child.table).foreignKeys[0]!;
  expect(fk.onDelete).toBe("no action");
  expect(fk.onUpdate).toBe("no action");
  expect(fk.reference().foreignColumns[0]!.name).toBe("id");
});

// ── The two storage arms ───────────────────────────────────────────────────
// A field type either has a FIXED column (`build`) or one narrowed by the
// field's own schema (`decode`), and defineEntity picks the arm. What the second
// arm buys is that the union in the column's type is what really runs: an
// out-of-set row throws where it is read, instead of being handed to typed code
// as if it matched. See
// `research/2026-08-25-global-decoded-entity-columns.md`.

const KIND_VALUES = ["user", "agent", "system"] as const;

test("a narrowed field's column really throws on an out-of-set read", () => {
  const ent = defineEntity(
    "ent_decoded",
    {
      id: field(textType, z.string(), ""),
      kind: field(
        decodedTextType as unknown as ReturnType<
          typeof defineFieldType<(typeof KIND_VALUES)[number]>
        >,
        z.enum(KIND_VALUES),
        "user",
      ),
    },
    { primaryKey: "id" },
  );

  // In-set reads pass through untouched…
  expect(ent.table.kind.mapFromDriverValue("agent")).toBe("agent");
  // …and the DDL is still a plain `text`, which is what makes adopting the
  // decoder generate no migration.
  expect(ent.table.kind.getSQLType()).toBe("text");

  let err: unknown;
  try {
    ent.table.kind.mapFromDriverValue("wizard");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(SqlColumnError);
  expect((err as SqlColumnError).label).toBe("ent_decoded.kind");
});

test("a plain-string field's column carries NO decoder", () => {
  // The cost claim, as a test: decoding a column that is not narrowed costs the
  // same as decoding one that is, for zero guarantee. A `z.string()` field must
  // therefore keep a bare `text` column whose read is the identity.
  const ent = defineEntity(
    "ent_undecoded",
    {
      id: field(textType, z.string(), ""),
      note: field(decodedTextType, z.string(), ""),
    },
    { primaryKey: "id" },
  );

  expect(is(ent.table.note, PgCustomColumn)).toBe(false);
  expect(ent.table.note.mapFromDriverValue("anything at all")).toBe(
    "anything at all",
  );
});

test("a NULLABLE plain-string field still carries no decoder", () => {
  // The case most likely to regress silently: if `splitNullability` stopped
  // unwrapping, the storage arm would see a `ZodNullable` rather than a
  // `ZodString`, take the decoding branch, and quietly put a parse on every
  // nullable text column in the repo — 345 ns per value, verifying nothing.
  const ent = defineEntity(
    "ent_undecoded_nullable",
    {
      id: field(textType, z.string(), ""),
      note: field(
        decodedTextType as unknown as ReturnType<
          typeof defineFieldType<string | null>
        >,
        z.string().nullable(),
        null,
      ),
    },
    { primaryKey: "id" },
  );

  expect(is(ent.table.note, PgCustomColumn)).toBe(false);
  expect(ent.table.note.notNull).toBe(false);
  expect(ent.table.note.mapFromDriverValue("anything at all")).toBe(
    "anything at all",
  );
});

test("a nullable narrowed field decodes its UNWRAPPED schema and stays nullable", () => {
  // A decoder never sees `null` in either direction, so it must be handed the
  // schema for the column's VALUES — never the `.nullable()` wrapper, which
  // would make every real value fail one half of the round trip. Nullability
  // stays drizzle's, derived from the same split.
  const ent = defineEntity(
    "ent_decoded_nullable",
    {
      id: field(textType, z.string(), ""),
      kind: field(
        decodedTextType as unknown as ReturnType<
          typeof defineFieldType<(typeof KIND_VALUES)[number] | null>
        >,
        z.enum(KIND_VALUES).nullable(),
        null,
      ),
    },
    { primaryKey: "id" },
  );

  // The column is nullable (no `.notNull()`)…
  expect(ent.table.kind.notNull).toBe(false);
  // …and its decoder is the ENUM, not the nullable wrapper: an in-set value
  // passes, an outsider throws. (drizzle guards `null` before the decoder ever
  // runs, so the decoder is never asked about it.)
  expect(ent.table.kind.mapFromDriverValue("system")).toBe("system");
  expect(() => ent.table.kind.mapFromDriverValue("wizard")).toThrow(
    SqlColumnError,
  );
});

// ── The jsonb arm ──────────────────────────────────────────────────────────
// The same two arms, one tier down. `jsonField<T>` used to get its `T` from the
// `EntityColumns` cast and from nothing that ran — Postgres decodes the JSON, so
// the value was real but its SHAPE was a claim about rows nobody checked. See
// `research/2026-08-26-global-decoded-jsonb-entity-columns.md`.

test("a narrowed jsonb field's column really throws on an out-of-shape read", () => {
  const ent = defineEntity(
    "ent_json_decoded",
    {
      id: field(textType, z.string(), ""),
      callers: field(
        jsonType<CallerBreakdown[]>(),
        z.array(
          z.object({ caller: z.string(), count: z.number() }),
        ) as z.ZodType<CallerBreakdown[]>,
        [],
      ),
    },
    { primaryKey: "id" },
  );

  // In-shape reads pass through…
  expect(
    ent.table.callers.mapFromDriverValue([{ caller: "boot", count: 2 }]),
  ).toEqual([{ caller: "boot", count: 2 }]);
  // …and the DDL is still a plain `jsonb`, which is what makes adopting the
  // decoder generate no migration.
  expect(ent.table.callers.getSQLType()).toBe("jsonb");

  let err: unknown;
  try {
    ent.table.callers.mapFromDriverValue([{ caller: "boot", count: "two" }]);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(SqlColumnError);
  expect((err as SqlColumnError).label).toBe("ent_json_decoded.callers");
});

test("a bare jsonb default carrying a `kind` key is a value, not a marker", () => {
  // Markers are branded, never recognised by shape: a `{ kind: … }` default
  // read as one matched no marker arm and built no column at all.
  const Spec = z.object({ kind: z.literal("worktree") });
  const ent = defineEntity(
    "ent_json_kind_default",
    {
      id: field(textType, z.string(), ""),
      spec: field(jsonType<{ kind: "worktree" }>(), Spec, { kind: "worktree" }),
    },
    { primaryKey: "id", columns: { spec: { default: { kind: "worktree" } } } },
  );

  expect(ent.table.spec.hasDefault).toBe(true);
  expect(ent.table.spec.default).toEqual({ kind: "worktree" });
});

test("a `z.unknown()` jsonField's column carries NO decoder", () => {
  // The cost claim, as a test — and the design's central one: the schema is the
  // dial. A field whose schema declares nothing keeps a bare `jsonb` column
  // whose read is the identity, so it pays nothing.
  const ent = defineEntity(
    "ent_json_unknown",
    {
      id: field(textType, z.string(), ""),
      blob: field(jsonType<unknown>(), z.unknown(), null),
    },
    { primaryKey: "id" },
  );

  expect(is(ent.table.blob, PgCustomColumn)).toBe(false);
  expect(ent.table.blob.getSQLType()).toBe("jsonb");
  expect(ent.table.blob.mapFromDriverValue({ any: ["shape"] })).toEqual({
    any: ["shape"],
  });
});

test("a nullable narrowed jsonb field decodes its UNWRAPPED schema and stays nullable", () => {
  // Same rule as the text tier: a decoder never sees `null` in either
  // direction, so it must be handed the schema for the column's VALUES — never
  // the `.nullable()` wrapper, which would make every real value fail one half
  // of the round trip.
  const ent = defineEntity(
    "ent_json_decoded_nullable",
    {
      id: field(textType, z.string(), ""),
      lastCaller: field(
        jsonType<CallerBreakdown | null>(),
        z
          .object({ caller: z.string(), count: z.number() })
          .nullable() as z.ZodType<CallerBreakdown | null>,
        null,
      ),
    },
    { primaryKey: "id" },
  );

  // The column is nullable (no `.notNull()`)…
  expect(ent.table.lastCaller.notNull).toBe(false);
  // …and its decoder is the OBJECT schema, not the nullable wrapper: an
  // in-shape value passes, a wrong one throws. (drizzle guards `null` before
  // the decoder ever runs, so the decoder is never asked about it.)
  expect(
    ent.table.lastCaller.mapFromDriverValue({ caller: "boot", count: 1 }),
  ).toEqual({ caller: "boot", count: 1 });
  expect(() =>
    ent.table.lastCaller.mapFromDriverValue({ caller: "boot" }),
  ).toThrow(SqlColumnError);
});
