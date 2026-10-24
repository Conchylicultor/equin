# Migrate relational clusters (mail-core, tasks-core) onto defineEntity

Stage E of the fields-unified-entities roadmap. `defineEntity`
(`infra/plugins/entities/server`) now supports FK / cascade / set-null via
`meta.columns.<key>.references`. The two clusters that fell back to raw
`pgTable` purely because FK/cascade was unexpressible can now adopt the
primitive and regain `table.$inferSelect ≡ z.infer<schema>`.

## Precedent

`slow_ops` (`debug/slow-ops`) and `boot_traces` (`debug/boot-profile`) are
already migrated. The proven shape:

- A `FieldsRecord` lives in **`core/`** (web-safe — uses only `fields/*/config`
  factories + `fieldsToZodObject`).
- `defineEntity(name, fields, meta)` is called **only in
  `server/internal/tables.ts`** (server-only — `resolveFieldStorage` needs the
  `fields.storage` contributions, which are NOT registered in the browser).
- `export const _x = entity.table` for drizzle-kit's `schema*/tables*` glob.
- The wire schema is `fieldsToZodObject(fields)` in core — **never**
  `createSelectSchema(table)`, which would drag the server-only table into web.

**Hard constraint:** `defineEntity` must never be reachable from a web-imported
path. Today `tasks-core/core` re-exports `server/internal/schema` →
`tables.ts`; web evaluates that pgTable at runtime. Swapping it for
`defineEntity` as-is would crash the browser (`resolveFieldStorage` → undefined
→ throw). So tasks-core MUST move its schema derivation off the table.

## Feasibility gaps (and the additive fixes)

The stdlib field factories cover text / json<T> / uuid / int / bool / date(tz)
/ float, all non-nullable. Three shapes are missing:

1. **Nullable columns** (~25 in mail, ~12 in tasks). `defineEntity` reads
   nullability from the raw `field.schema` (`ZodNullable`/`ZodOptional` ⇒ no
   `.notNull()`). Fix: a pure combinator
   `nullable<T>(def: FieldDef<T>): FieldDef<T|null>` in **`fields/core`** —
   `{ ...def, schema: def.schema.nullable(), defaultValue: null }`. Composes
   with every factory: `nullable(textField())`, `nullable(dateField())`,
   `nullable(jsonField<MailAddress[]>({...}))`. Purely additive.

2. **Enum-branded text** (`text().$type<MailLabelType>()`). The existing
   `enumField` erases the union (`FieldDef<string>`) and the `enum` type has no
   storage. `$type<T>()` is a **TS-only brand — invisible in DDL** — so a plain
   `text` column reproduces the DDL byte-for-byte; only type-equivalence needs
   the brand. Fix: a union-preserving `enumTextField` co-located with
   `textField` (`fields/plugins/text/plugins/config/core`) reusing
   `textFieldType` (→ existing `text` storage):
   `enumTextField(values, opts?) : FieldDef<values[number]>` with
   `schema: z.enum(values)`. Additive; does not touch `enumField`.

3. **`rank_text` custom-domain column** (tasks `rank` only). No field type maps
   to `rankText`. Fix (tasks step): a new `rank` field type — identity (core) +
   `rankField()` factory (`schema: RankSchema`) + a `fields.storage`
   contribution `(n) => rankText(n)`. Home: `fields/plugins/rank/{core,
   plugins/config, plugins/storage}` mirroring the other types.

## Byte-identical DDL — the green-migration invariant

Verification gate: after `./equin build`, **no new migration file appears
under `migrations/data/`** and `migrations-in-sync` stays green. Drizzle DDL is
a pure function of: column order, column name, sql-type, notNull, default,
PK/FK/index. So the field record must preserve, per table:

- **Column order** = `Object.entries(fields)` insertion order = original
  pgTable order.
- **DB column name** = `meta.columns.<key>.name ?? snakeCase(key)`. The mail
  address columns use bespoke names (`from_addr`, `to_addrs`, `reply_to`, …) —
  set `meta.columns.<key>.name` explicitly. Any key whose snake_case ≠ the
  committed column name needs an explicit `name`.
- **Defaults** — `.default(0|false|[]|{})`, `defaultNow()`, `defaultRandom()`
  reproduced via `meta.columns.<key>.default`. Nullable-without-DB-default
  columns get NO `default` entry (nullability ≠ DB default).
- **FKs** — `references: { column: () => target.table.col, onDelete }`. Drizzle
  auto-names `<table>_<col>_<ref>_<refcol>_fk`, identical to raw `.references()`.
- **Indexes / composite PK** — reproduce names + column lists exactly via
  `meta.indexes` and `primaryKey: [...]`.

If a new migration DOES appear, diff it, fix the field record to eliminate the
drift (do NOT accept a spurious migration).

## Step 1 — mail-core (self-contained, not load-bearing)

9 tables rooted at `mail_accounts`; CASCADE/SET NULL edges; self-ref
`mail_labels.parent_id` (SET NULL); composite-PK junction
`mail_message_labels`. No web table-eval today (core has only hand-authored
interfaces, no zod). Lowest risk.

- Build `nullable` (fields/core) + `enumTextField` (text/config) capabilities
  with bun:tests.
- `core/internal/fields.ts` — one `FieldsRecord` per table (web-safe). Add
  `MailAddressSchema` (zod) for the jsonb payloads.
- `core/internal/types.ts` — replace the 10 hand-authored interfaces with
  `z.infer<typeof XSchema>` derived from the field records (eliminates drift).
  Keep the same exported names. Enum unions stay sourced from `enums.ts` and
  fed into `enumTextField`.
- `server/internal/tables.ts` — `defineEntity` per table; `export const _x =
  entity.table`. `schema-attachments.ts` (`Attachments.defineLink(_mailDrafts)`)
  works unchanged (entity.table is a pgTable).
- Verify build → zero new migration; `migrations-in-sync`, `type-check`,
  `boundaries` green.

## Step 2 — tasks-core (load-bearing — separate, carefully reviewed)

5-table FK cluster (tasks self-ref folder/group, attempts, task_dependencies
composite junction, pushes, conversations) imported by ~60 plugins; web
evaluates its schemas. Extra work vs mail:

- Build the `rank` field type (gap #3).
- Break the web-bundling chain: move field records to `core`; derive the public
  schemas from `fieldsToZodObject(fields)` **plus** `.extend()` for the
  computed *view* columns (`status`, `active`, `finishedAt`, `dependencies`,
  `worktreePath`, `taskId`) and the transform overrides (`rank`→`RankSchema`,
  `model`→`StoredModelSchema` tolerant, the enum-branded `status`/`kind`). The
  base `tasks/attempts/pushes/conversations` columns come from the field
  records; the views layer stays. `defineEntity` stays server-only.
- Note: tasks-core's public schemas are intentionally *richer* than the base
  row (transforms + view columns), so `entity.schema` ≠ public schema here. The
  by-construction win is `table.$inferSelect` over the base columns + FK/cascade
  expressed through the primitive, not a full schema-equivalence.
- Same byte-identical-DDL gate. `task_dependencies` / `attempts` / `pushes` /
  `conversations` indexes + `pushes_sha_unique` reproduced exactly.

If tasks-core cannot land cleanly (e.g. an unforeseen drift in the view layer or
a rank type-lie that breaks a loader), file a follow-up rather than shipping a
hacky migration.
