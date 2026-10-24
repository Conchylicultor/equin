# Stage C — `defineEntity(name, fields, meta)`: one field record → table + wire schema + row type

> Stage C of the fields-unified-entities roadmap
> ([`2026-06-17-global-fields-unified-entities.md`](./2026-06-17-global-fields-unified-entities.md)).
> Stages A (`fields.storage` capability) and B (the `FieldDef` atom + `fieldsToZodObject`) have
> landed. This stage builds the general entity factory that composes both.

## Context

Adding a column to a table-backed live-state resource today means hand-syncing **three** artifacts
that nothing forces to agree: the Drizzle table, the zod wire schema, and a row projection in the
loader. The projection is a pure identity map that silently drops any column a contributor forgets
to forward (TypeScript does not warn on an omitted property) — `slow_ops.recentSamples` was missed
on first pass. Stage 0 papered over this for `slow_ops` with a compile-time `Equal<$inferSelect,
SlowOp>` guard, but the underlying gap remains: **there is no single artifact from which a table's
storage, its wire contract, and its row type all derive.**

Stages A/B gave us the two halves keyed off one `FieldsRecord`:
- `fieldsToZodObject(fields)` (`@plugins/fields/core`) → the wire `z.ZodObject`.
- `resolveFieldStorage(typeId)` / `fieldsToColumns(fields)` (`@plugins/fields/server`) → bare Drizzle
  column builders.

Stage C ties them into one primitive — `defineEntity(name, fields, meta)` — so that
`entity.table.$inferSelect` is **identical by construction** to `z.infer<entity.schema>`. A loader
becomes `db.select().from(entity.table)` with no projection, and field-set drift becomes
unrepresentable (a column whose nullability/type disagreed with its field's schema is a `tsc` error).

**Scope: Stage C only.** Build the primitive, unit-test that it reproduces the exact `slow_ops` DDL +
wire schema, and register it with the `table-defs-in-schema-glob` check. The live `slow_ops` table is
**not** touched — migrating it (Stage D) is a separate follow-up.

**Home (decided):** `plugins/infra/plugins/entities/`, beside its sibling table-factory primitives
`defineExtension` (entity-extensions) and `defineLink` (attachments).

## API surface

```ts
// @plugins/infra/plugins/entities/server
export const slowOps = defineEntity(
  "slow_ops",
  {
    id:            uuidField(),    // FieldDef literals (Stage C tests build them inline;
    worktree:      textField(),    // real adopters use the fields' factories in Stage D)
    operationKind: textField(),
    count:         intField(),
    totalMs:       floatField(),
    callers:       jsonField<CallerBreakdown[]>(),
    recentSamples: jsonField<SlowOpSample[]>(),
    firstSeenAt:   dateField(),
    lastSeenAt:    dateField(),
  },
  {
    primaryKey: "id",
    columns: {
      id:            { default: defaultRandom() },
      count:         { default: 0 },
      totalMs:       { default: 0 },
      callers:       { default: [] },
      recentSamples: { default: [] },
      firstSeenAt:   { default: defaultNow() },
      lastSeenAt:    { default: defaultNow() },
    },
    indexes: (t) => [
      uniqueIndex("slow_ops_kind_op_worktree_idx").on(t.operationKind, t.operation, t.worktree),
    ],
  },
);

// drizzle-kit discovery — same convention as entity-extensions/attachments:
export const _slowOpsTable = slowOps.table;
```

Payoff (the loader, Stage D — shown only to motivate):

```ts
const loader = () => db.select().from(slowOps.table);
//    ^? Promise<{ id: string; callers: CallerBreakdown[]; recentSamples: SlowOpSample[]; ... }[]>
//       ≡ z.infer<typeof slowOps.schema>[]   — no projection, drift unrepresentable
```

### Types

```ts
import type { SQL } from "drizzle-orm";

// Storage-only DB default. ABSENT ⇒ no DB default (even when field.defaultValue exists —
// the wire/backfill default and the DB-column default are DISTINCT concepts).
type DbDefault<T> =
  | { kind: "literal"; value: T }   // .default(value)
  | { kind: "now" }                 // .defaultNow()    (timestamp only)
  | { kind: "random" }              // .defaultRandom() (uuid only)
  | { kind: "sql"; sql: SQL };      // .default(sql`...`)
type ColumnDefault<T> = T | DbDefault<T>;            // bare value = literal sugar

interface EntityColumnMeta<T> {
  name?: string;                    // DB column name; default = snakeCase(key)
  default?: ColumnDefault<T>;       // opt-in per column
}

export interface EntityMeta<F extends FieldsRecord> {
  // single key → .primaryKey() on the column; array → composite primaryKey({columns}); absent → junction
  primaryKey?: (keyof F & string) | (keyof F & string)[];
  columns?: { [K in keyof F]?: EntityColumnMeta<InferFieldValue<F[K]>> };
  // passthrough to pgTable's 3rd arg; `t` is keyed by JS property name; merged with composite-PK entry
  indexes?: (t: BuildExtraConfigColumns<string, EntityColumns<F>, "pg">) => AnyIndexBuilder[];
}

export interface Entity<F extends FieldsRecord> {
  readonly name: string;
  readonly table: PgTableWithColumns<{                       // inferred from the pgTable(...) call
    name: string; schema: undefined; dialect: "pg";
    columns: BuildColumns<string, EntityColumns<F>, "pg">;
  }>;
  readonly schema: z.ZodObject<{ [K in keyof F]: F[K]["schema"] }>;  // = fieldsToZodObject(fields)
}

// sugar so consumers needn't import zod:  type SlowOpRow = EntityRow<typeof slowOps>;
export type EntityRow<E> = E extends Entity<infer F> ? z.infer<Entity<F>["schema"]> : never;

// default-marker constructors (exported):  defaultNow(), defaultRandom(), sqlDefault(sql`...`)
```

## The crux — precise `$inferSelect` typing (solved)

The runtime builders come from `resolveFieldStorage`, typed `StorageColumnBuilder = (name) =>
PgColumnBuilderBase` — **T erased**. To make `pgTable`'s own `BuildColumns` infer the right select
type, assemble the runtime builders loosely, then **cast the map once** to a precise mapped type and
let `pgTable` infer:

```ts
type EntityColumns<F extends FieldsRecord> = {
  // $Type + NotNull are exported from drizzle-orm root; they brand `_.$type` / `_.notNull`,
  // which flow through MakeColumnConfig → GetColumnData to the select type.
  [K in keyof F]: NotNull<$Type<PgColumnBuilderBase<ColumnBuilderBaseConfig<ColumnDataType, string>>,
                                 InferFieldValue<F[K]>>>;
};
```

Key facts that make this correct (verified against `drizzle-orm/column-builder.d.ts` &
`table.d.ts`, drizzle 0.36.x):

- **`$inferSelect` is keyed by the camelCase JS property, never the snake_case DB column name**
  (`MapColumnName<..., dbColumnNames: false>`). So snake_case is purely a DDL concern that never
  touches the inferred type — `table.$inferSelect` and `z.infer<schema>` align by construction (both
  keyed by JS prop, both derived from `InferFieldValue<F[K]>`).
- `.$type<T>()` **overrides** the column's `data` type (`MakeColumnConfig`); `InferFieldValue<F[K]>`
  already encodes `T | null` for a nullable field, so branding `$type` from it carries nullability —
  no separate compile-time nullable flag is needed in `EntityColumns`.
- `.default()` / `.defaultNow()` / `.defaultRandom()` / `.primaryKey()` affect only the **insert**
  model (`hasDefault`/`isPrimaryKey`), not select — so they are deliberately omitted from the cast,
  keeping it minimal and the select type exact.

**Nullability** is derived from the **raw** `field.schema` (defineEntity has it before
`fieldsToZodObject` wraps it with `.default()`): `schema instanceof z.ZodOptional || schema instanceof
z.ZodNullable` ⇒ leave the column nullable; else `.notNull()`. This is runtime-only (drives the DDL +
insert optionality); the select union is already carried by `$type`. Deriving notNull from the schema
is what prevents wire/column nullability drift.

Approach (a) above (re-brand + cast the columns map) is chosen over (b) hand-building
`PgTableWithColumns<{...}>` — (b) forces reproducing `MakeColumnConfig` per column and discards the
real `columnType`/`dataType` that `db.select()`/`.where()` need.

## Column-assembly algorithm (`defineEntity`)

For each `[key, field]` in `fields`:
1. `build = resolveFieldStorage(field.type.id)`; throw loudly (naming key + type id) if absent —
   mirror the `fieldsToColumns` error. **Do not use `fieldsToColumns`**: it hardcodes the JS key as
   the column name (camelCase) and applies no modifiers.
2. `columnName = meta.columns?.[key]?.name ?? snakeCase(key)`; `let b = build(columnName) as any`
   (one `as any` at the runtime/type boundary — `PgColumnBuilderBase` doesn't surface the chain
   methods; entity-extensions sets the `as unknown as` precedent).
3. `b = b.$type()` (runtime no-op; the brand lives in the cast — needed so the jsonb DDL carries
   `$type<T>()`).
4. `if (!isNullableSchema(field.schema)) b = b.notNull()`.
5. `if (meta.primaryKey === key) b = b.primaryKey()`.
6. `if (meta.columns?.[key] && "default" in ...) b = applyDefault(b, default)` — `literal`→`.default(v)`,
   `now`→`.defaultNow()`, `random`→`.defaultRandom()`, `sql`→`.default(sql)`, bare value→`.default(v)`.

Third-arg callback (composite PK + index passthrough), `t` keyed by JS prop:
```ts
const extraConfig = (t) => [
  ...(Array.isArray(meta.primaryKey) ? [primaryKey({ columns: meta.primaryKey.map((k) => t[k]) })] : []),
  ...(meta.indexes?.(t) ?? []),
];
const table = pgTable(name, builders as unknown as EntityColumns<F>, extraConfig);
const schema = fieldsToZodObject(fields);
return Object.freeze({ name, table, schema });
```

**snake_case:** no global drizzle `casing` is set (`plugins/database/server/internal/client.ts` is
plain `drizzle(pool)`), and no reusable snake util exists. Add a tiny local one in the plugin —
`key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())` (covers `operationKind→operation_kind`,
`totalMs→total_ms`, `firstSeenAt→first_seen_at`) — with its own unit test. (Re-check `client.ts`
before shipping: if someone added `casing: 'snake_case'`, the manual snake becomes redundant.)

**Soundness gap to document:** `defaultRandom`/`defaultNow` only exist on the uuid/timestamp builders;
because we chain on an `as any` builder they compile but throw at runtime if mis-targeted. Document
that `random`/`now` are valid only for uuid/date fields; optionally add a `typeof b.defaultRandom ===
"function"` guard for a clear error.

## Files

New plugin `plugins/infra/plugins/entities/` (server runtime only — keeps `drizzle-orm/pg-core` off
the browser, mirroring `fields/server`):

- `server/internal/define-entity.ts` — the factory (assembly loop + the one load-bearing cast).
- `server/internal/types.ts` — `Entity`, `EntityMeta`, `EntityColumns`, `EntityRow`, `DbDefault`,
  and the `defaultNow()` / `defaultRandom()` / `sqlDefault()` constructors.
- `server/internal/snake-case.ts` + `snake-case.test.ts`.
- `server/internal/define-entity.test.ts` — the slow_ops-shape reproduction test.
- `server/index.ts` — barrel: `defineEntity`, `EntityMeta`, `Entity`, `EntityRow`, `defaultNow`,
  `defaultRandom`, `sqlDefault`.
- `package.json`, `CLAUDE.md`.

Register the factory with the table-discovery check:
- `plugins/framework/plugins/tooling/plugins/checks/plugins/table-defs-in-schema-glob/check/index.ts`
  — add to `TABLE_FACTORIES`:
  `{ name: "defineEntity", definedIn: "plugins/infra/plugins/entities/server/internal/define-entity.ts" }`.
  (`definedIn` exempts the factory body — which contains `pgTable(` — from Rule 1; `name` makes Rule 2
  flag any `defineEntity(` call outside a schema-glob file.) No co-located test edit is required (the
  `defineCollection` removal in Stage 1 already cleaned its assertion); add a `definedIn`-exempt
  assertion only if mirroring the existing per-factory test cases.

Reuse (do not reimplement):
- `resolveFieldStorage` — `plugins/fields/server/internal/storage.ts`
- `fieldsToZodObject`, `FieldDef`/`FieldsRecord`/`InferFieldValue`/`InferFieldsObject` —
  `plugins/fields/core`
- `$Type`, `NotNull`, `BuildColumns`, `BuildExtraConfigColumns`, `PgTableWithColumns` — `drizzle-orm`
- handle/`as unknown as` + drizzle-kit `_<name>Table` re-export convention —
  `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts`

## Unit tests

Mirror `plugins/fields/server/internal/fields-to-columns.test.ts`: register throwaway storage
builders via `collectContributions([{ id, contributions: [Fields.Storage({type, build}), ...] }])`
for local `defineFieldType` tokens (text/uuid/int/float/json/date), build the slow_ops shape, and
assert the **built table** introspectively:

- column count + names (`table.operationKind.name === "operation_kind"`, `total_ms`, `first_seen_at`).
- per-column `notNull` / `primary` / `hasDefault` / SQL type (`getSQLType()` → `uuid`, `double
  precision`, `jsonb`, `timestamp with time zone`, `integer`, `text`).
- the unique index present on `(operation_kind, operation, worktree)` (read the table's index config).
- `entity.schema` validates a sample row and `z.infer` matches `table.$inferSelect` (a
  `type _Check = Expect<Equal<...>>` line in the test).
- the throw path: a field whose type has no storage contribution throws naming the key + type id.
- snake-case util cases.

Run: `bun test plugins/infra/plugins/entities` (after a build/`bun install` so `node_modules` exists).

## Verification

1. `bun test plugins/infra/plugins/entities` — all units green (DDL introspection + schema + snake).
2. `./equin build` — compiles; regenerates docs (`plugins-compact.md`, `plugins-details.md`,
   `infra/CLAUDE.md`, registries) for the new plugin.
3. `./equin check` green — specifically:
   - `type-check` (the cast + mapped types compile; boundary imports legal: entities → fields/core,
     fields/server, drizzle).
   - `plugin-boundaries` (only runtime barrels imported; table stays in `internal/`).
   - `table-defs-in-schema-glob` (factory registered; no stray `pgTable`/`defineEntity` outside
     schema-glob files).
   - `plugins-doc-in-sync`, `plugins-registry-in-sync`.
4. No new migration is generated by the build (Stage C adds no live table — only the test builds
   entities; `migrations-in-sync` stays clean).

## Out of scope (follow-ups)

- **Stage D** — re-express the live `slow_ops` table as a `defineEntity` field record, delete the
  loader projection + `Equal` guard, verify `./equin build` emits no new migration (DDL
  byte-identical). This plan's tests prove the shape is reproducible; the migration itself is Stage D.
- **Stage E/F** — opt-in list semantics (`rank`/`createdAt` presets, create/update schema variants,
  bundled live-state resource) and broader adoption, added only when a real consumer earns them.
