# entities

`defineEntity(ref, meta)` — the ref (`entityRef(name, fields)`, declared in the plugin's browser-safe `core/`) is the ONLY spelling; there is no string-name form — derives BOTH a Drizzle `pgTable` AND a zod
wire schema from one `FieldsRecord`, so `entity.table.$inferSelect` is
**identical by construction** to `z.infer<entity.schema>`. A loader becomes
`db.select().from(entity.table)` with no row projection, and field-set drift
(a column whose nullability/type disagrees with its field's schema) becomes a
`tsc` error instead of a silently dropped field.

This is Stage C of the fields-unified-entities roadmap
(`research/2026-06-18-global-define-entity-stage-c.md`), built on the Stage A
`fields.storage` capability and the Stage B `FieldDef` atom + `fieldsToZodObject`.
Server-only runtime — keeps `drizzle-orm/pg-core` off the browser bundle, like
`fields/plugins/server-capabilities/server` (from which it imports
`resolveFieldStorage`). Its server barrel also side-effect-imports
`fields/plugins/server-capabilities-loader/server` so every storage capability
barrel is evaluated before any `defineEntity` body runs.

## API

```ts
import { defineEntity, defaultNow, defaultRandom } from "@plugins/infra/plugins/entities/server";

// core/: the table name + browser-safe field record, declared once.
export const slowOpsEntityRef = entityRef("slow_ops", {
  id:            uuidField(),
  worktree:      textField(),
  operationKind: textField(),
  count:         intField(),
  // The schema is not decoration: it is what decodes the jsonb column, so
  // `VariantBreakdown[]` is inferred from it rather than declared beside it.
  variants:      jsonField({ schema: z.array(VariantBreakdownSchema), default: [] }),
  firstSeenAt:   dateField(),
});

// server/: the table, built from the ref.
export const slowOps = defineEntity(
  slowOpsEntityRef,
  {
    primaryKey: "id",                 // string → .primaryKey(); array → composite primaryKey({columns})
    columns: {
      id:          { default: defaultRandom() },
      count:       { default: 0 },    // bare value = .default(value) sugar
      firstSeenAt: { default: defaultNow() },
    },
    indexes: (t) => [
      uniqueIndex("slow_ops_kind_op_worktree_idx").on(t.operationKind, t.operation, t.worktree),
    ],
  },
);

// drizzle-kit discovery — same convention as entity-extensions / attachments:
export const _slowOpsTable = slowOps.table;

type SlowOpRow = EntityRow<typeof slowOps>;   // = z.infer<typeof slowOps.schema>
```

### From an entity ref — `defineEntity(ref, meta)`

An entity browser code must name (a collection's `exposes`, an extension's
`exposes.parent`, a list deriving its fields) is declared as a ref in the
owning plugin's `core/`: `entityRef(name, fields)` (`entities/core`) — the
table name plus the browser-safe field record. The server builds the table
FROM it, `defineEntity(ref, meta)` (or `defineEntity(ref)` with no `meta`),
so the fields a browser list reads off `ref.fields` and the table a server
reads are one declaration. A column only the server may see (a dedup key, a
pid) is NOT on the ref: it is the middle argument,
`defineEntity(ref, serverFields, meta)` — a column of the table, absent from
the wire schema and `wireColumns`; `meta.serverOnly` has no spelling. tasks-core's `tasksEntityRef` /
`attemptsEntityRef` / `conversationsEntityRef` are the reference.

## How it derives the two artifacts from one field record

- **Columns** — `resolveFieldStorage(field.type.id)` gives the storage
  CONTRIBUTION, and the factory picks its arm (see below) and applies the
  modifiers (`.notNull()`, `.primaryKey()`, `.default()`). The DB column name is
  `meta.columns.<key>.name ?? snakeCase(key)` — a JS-prop-keyed `$inferSelect`
  is unaffected by snake_case (purely a DDL concern).
- **Schema** — `fieldsToZodObject(fields)`, keyed by the same JS props.

## The storage arms — and why nothing is asserted

A field type either has a **fixed** column (`build`), one **narrowed by the
field's own schema** (`decode`), or one that **stores another value than the
field's** (`stored`), and `defineEntity` picks the arm:

```ts
storage.build ? storage.build(columnName)
  : storage.stored ? storage.stored(columnName)
  : storage.decode(columnName, value)
```

The `stored` arm is the one place a table's select type and the entity's wire
schema differ, by declaration: the field's value is its WIRE form (a `bytes`
field's base64 string), its def is marked `StoredAs<S>` (fields/core — the
bytes stored), `EntityColumns` types the column by `InferStoredValue` (so
`table.$inferSelect.state` is a `Uint8Array`), and the storage's column
declares its wire form (sql-column `withWire`), which `serveCollection`
encodes on every served row. Everywhere else `$inferSelect ≡ z.infer<schema>`.

`value` is the field schema with its nullability peeled off (`splitNullability`),
because a decoder never sees `null` in either direction — drizzle guards it on
both — so handing it the `.nullable()` wrapper would make every real value fail
one half of the round trip. One helper returns both answers so the column's
declared nullability and its decoder cannot disagree.

That distinction is what turns the `EntityColumns` cast below into a pure
*re-statement*. **No column in any entity is asserted any more:**

| columns | the cast |
|---|---|
| every `text` field — so every `enumTextField` union | **DERIVED**: the builder was already typed off the schema that really decodes the column |
| every `jsonb` column — so every `jsonField<T>` and `tagsField` | **DERIVED**: same, one tier down; the field's schema decodes the shape on every read and every write, and normalizes it |
| `bool` / `int` / `float` / `date` / `uuid` / `rank` | **DERIVED**: the builder's type is pinned to its token's value type |

The jsonb tier was deferred once, on a worry that a zod parse roughly doubles a
jsonb column's decode cost for a weaker guarantee. Measuring the actual columns
retired it: the cost tracks the **schema's** depth, not the payload's size, and
the schemas on the big payloads are shallow because their authors already
declined to describe them. The largest jsonb value in the repo (`traces.snapshot`,
avg 123 KB) decodes in 1.7 µs against the 561 µs `JSON.parse` pg already pays. So
the per-field opt-in dial that tier seemed to need already existed — it is the
schema — and a `jsonField({ schema: z.unknown() })` still gets a bare `jsonb`
column with no decoder at all
(`research/2026-08-26-global-decoded-jsonb-entity-columns.md`).

The `b.$type()` call this factory used to make is gone: it was a runtime no-op
(`$type() { return this; }` in drizzle 0.36.4), and the type now comes from the
builder.

The precise select-type alignment is the one load-bearing cast:
`builders as unknown as EntityColumns<F>` fed to `pgTable`, which lets drizzle's
own `BuildColumns` infer the right select type. `EntityColumns` brands each
column with `$Type<…, InferFieldValue<F[K]>>` + `NotNull` — `$type` carries
nullability (`InferFieldValue` already encodes `T | null`), and `.default()` /
`.primaryKey()` are deliberately omitted from the cast (they affect only the
INSERT model, not select), keeping the select type exact.

## Nullability & defaults — two distinct concepts

- **Nullability** is derived from the RAW `field.schema` by `splitNullability`:
  a `ZodOptional` / `ZodNullable` (nested to any depth) leaves the column
  nullable; anything else gets `.notNull()`. Deriving it from the schema is what
  prevents wire/column nullability drift — and the same call yields the value
  schema a decoding storage arm is handed, so those two cannot drift either.
- **DB defaults are OPT-IN per column** via `meta.columns.<key>.default` — they
  are a DISTINCT concept from a field's wire/backfill default
  (`field.defaultValue`). `defineEntity` never auto-applies `field.defaultValue`
  (e.g. `worktree` has a `""` wire default but no DB default). Markers:
  `defaultNow()` (timestamp), `defaultRandom()` (uuid), `sqlDefault(sql\`…\`)`,
  or a bare value = `.default(value)` sugar.

> `defaultNow()` / `defaultRandom()` are valid only for date/uuid fields (the
> builder must actually expose the method). Mis-targeting throws a clear error
> naming the column.

## Foreign keys & cascade deletes

FKs are **opt-in per column** via `meta.columns.<key>.references`, carrying a
**lazy column thunk** plus optional `onDelete` / `onUpdate` — the exact shape of
drizzle's native `.references(() => other.id, { onDelete })`, so a relational
cluster reads the same as hand-written drizzle while keeping the
`$inferSelect ≡ z.infer<schema>` guarantee:

```ts
export const mailThreads = defineEntity(mailThreadsEntityRef, {
  primaryKey: "id",
  columns: {
    accountId: { references: { column: () => mailAccounts.table.id, onDelete: "cascade" } },
  },
});
```

- The thunk is **lazy** so **forward references** (target defined later) and
  **self references** (target is the entity being defined) both resolve after
  every table is built — drizzle wires FKs up at config time, not call time.
- A **self reference** needs the `AnyPgColumn` return annotation to break
  TypeScript's circular inference, mirroring the raw-drizzle precedent:
  `parentId: { references: { column: (): AnyPgColumn => labels.table.id, onDelete: "set null" } }`.
  A `set null` target column must be nullable (its field schema `ZodOptional` /
  `ZodNullable`), exactly as Postgres requires.
- `onDelete` / `onUpdate` take drizzle's `UpdateDeleteAction`
  (`"cascade" | "set null" | "restrict" | "no action" | "set default"`); omitted
  ⇒ NO ACTION (Postgres's default).
- **Composite-PK junctions** combine `primaryKey: ["a", "b"]` with a
  `references` on each column — see the unit test's `fk_message_labels`.

FKs touch only the DDL — never the select/insert row shape — so they are
deliberately absent from the `EntityColumns` cast (like `.primaryKey()`).

## Derived `updatedAt`

A record with an `updatedAt` field MUST declare how it moves — `meta.updatedAt`
is required by the types exactly when the field exists (and `meta` itself may
then not be omitted):

```ts
updatedAt: {
  touchedBy: {                       // TOTAL over every other column: a new column is a tsc error
    title:        true,              // any change of value counts
    status:       { into: ["working", "done"], outOf: ["working"] }, // only these transitions
    lastViewedAt: false,             // never counts
    // …every other column
  },
},
```

There is no hand-stamped opt-out: every entity with an `updatedAt` field is
derived, and no app code writes the column.

Transition values are typed against the column's own value type, so a
misspelled one is a tsc error. `defineEntity` compiles `touchedBy` against the
PHYSICAL column names into a BEFORE UPDATE trigger that bumps `updated_at` to
`now()` only when a counted column really changed (a no-op write never bumps)
and RAISEs on any app write to `updated_at`, then registers it; the database
plugin installs every registered trigger at boot, right after migrations. The
compiler, registry and installer live in
[`database/derived-updated-at`](../../../database/plugins/derived-updated-at/CLAUDE.md)
(the database plugin cannot import entities without a cycle). The compiled
spec is also on `entity.derivedUpdatedAt`. Runtime backstops mirror the types
for callers typed against the widened `FieldsRecord` (entity-extensions, which
builds each side-table's total `touchedBy` itself — own columns count unless
overridden).

A raw drizzle `pgTable` (not built by `defineEntity`) declares the same thing
with `deriveUpdatedAt(pgTable(…), { touchedBy })` from
`database/derived-updated-at` — both go through its one `compileFromTable`.

## Boundary casts

Casts cross the runtime/type boundary in two places (the rest is precisely
typed): the per-builder `as any` for the modifier chain (`PgColumnBuilderBase`
doesn't surface chain methods), and the loosely-typed implementation behind
`defineEntity`'s overloads — `builders as unknown as EntityColumns` fed to
`pgTable`, restated by the overload return types so `pgTable` infers the select
type. The pgTable stays in `internal/`; only the
`defineEntity` factory + types leave via the barrel (cross-plugin imports of the
table are blocked by the boundary checker, like entity-extensions).

## Stage C scope

This plugin builds the primitive and unit-tests that it reproduces the exact
`slow_ops` DDL + wire schema. The live `slow_ops` table is NOT migrated here —
re-expressing it as a field record (and deleting its loader projection +
`Equal` guard) is Stage D. Registered with the `table-defs-in-schema-glob` check
so a stray `defineEntity(` outside a schema-glob file is flagged.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Derives a Drizzle pgTable AND a zod wire schema from one FieldsRecord, so entity.table.$inferSelect is identical by construction to z.infer<entity.schema>. Field-set drift becomes a tsc error; loaders drop their row projection.
- Server:
  - Uses:
    - `database/derived-updated-at.compileFromTable`
    - `database/derived-updated-at.DerivedUpdatedAtSpec`
    - `database/derived-updated-at.registerDerivedUpdatedAt`
    - `database/derived-updated-at.TouchRule`
    - `fields/server-capabilities-loader`
    - `fields/server-capabilities.resolveFieldStorage`
  - DB schema: `plugins/infra/plugins/entities/server/internal/define-entity.ts`
  - Exports (types):
    - `ColumnDefault`
    - `DbDefault`
    - `DefaultedKeys`
    - `Entity`
    - `EntityColumnMeta`
    - `EntityColumns`
    - `EntityMeta`
    - `EntityMetaBase`
    - `EntityReference`
    - `EntityRow`
    - `EntityTable`
    - `ServerOnlyKeys`
    - `TouchedBy`
    - `UpdatedAtMeta`
  - Exports (values):
    - `defaultNow`
    - `defaultRandom`
    - `defineEntity`
    - `isDbDefault`
    - `sqlDefault`
- Core:
  - Uses: `fields.fieldsToZodObject`
  - Exports (types): `EntityRef`
  - Exports (values):
    - `entityRef`
    - `wireSchema`
- Cross-plugin:
  - Imported by: 38 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×8
    - `conversations` ×7
    - `infra` ×5
    - `debug` ×4
    - `page` ×4
    - `backup`
    - `build/run-ledger`
    - `hints`
    - `history/engine`
    - `plugin-meta/plugin-health`
    - `primitives/usage-rank`
    - `release`
    - `reports`
    - `shell/notifications`
    - `tasks/tasks-core`

<!-- AUTOGENERATED:END -->
