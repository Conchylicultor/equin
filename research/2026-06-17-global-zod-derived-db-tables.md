# Zod-derived DB tables: a single source of truth for table-backed live-state resources

## Context

Adding a column to the `slow_ops` table today requires editing it in **three** hand-synced places:

1. **`server/internal/tables.ts`** — the Drizzle `pgTable` column (storage / migrations).
2. **`core/resources.ts`** — the zod `SlowOpSchema` field (wire contract + TS type).
3. **`server/internal/resources.ts`** — a hand-written `rows.map(r => ({ ... }))` projection in the live-state loader.

Place 3 is the dangerous one: it is a property-by-property copy (not `...r`), and TypeScript does **not** warn when a column present on the DB row is simply omitted from the projection object. A newly added `recentSamples` column was missed on first pass and only caught later by `type-check`. The projection silently drops any column a contributor forgets to forward — a footgun every future contributor inherits.

The projection is, in fact, a **pure identity map**: every field is `r.<name>` with no transform, and Drizzle already returns `Date` for timestamps and typed arrays for the jsonb columns. So `db.select().from(_slowOps)` rows are *already* `SlowOp`-shaped. The third place exists only to be forgotten.

### Why we can't just collapse to one file

The zod schema must live in `core/` (the browser imports it via `resourceDescriptor` for client-side wire validation). The Drizzle table naturally lives in `server/` (drizzle-kit migrations + DB queries). `core/` cannot import `server/`. So table and wire-schema are necessarily two artifacts — but only one needs to be *authored*.

### The chosen model: author the zod schema, derive the table

Invert the derivation direction. The **zod schema in `core/` is the single authored source of truth.** A new generic server-side factory `dbTable(name, schema, meta)` derives the Drizzle table *from* the schema. This:

- keeps `drizzle-orm/pg-core` entirely server-side (boundary preserved; nothing new in the browser bundle);
- reuses the schema that must exist anyway (no third artifact to author);
- makes `dbTable` generic so the table's `$inferSelect` **is** `z.infer<schema>` — the loader's `return rows` is `SlowOp[]` *by construction*, the projection ceases to exist, and field-set drift becomes **unrepresentable**, not merely guarded.

Field-set divergence — the entire silent-omission class — becomes impossible: there is one field list (the schema), and the table + the loader's row shape are both functions of it.

### Precedent (this is not novel infrastructure)

The repo already has three server-side factories that wrap `pgTable(...)` and are re-exported from `tables.ts`, all picked up correctly by drizzle-kit (10+ committed migrations prove it):

- `defineExtension` — `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts`
- `defineLink` — `plugins/infra/plugins/attachments/server/internal/define-link.ts`
- `defineCollection` / `buildTable` — `plugins/primitives/plugins/collections/core/internal/table-builder.ts`

drizzle-kit discovers tables by **evaluating** the glob-matched `tables.ts` modules at runtime (not by parsing AST — see `plugins/database/plugins/migrations/drizzle.config.ts`), so a table returned by a helper and re-exported is indistinguishable from a literal `pgTable({...})`.

The only difference from the existing three: they are driven by *field-definition records*; `dbTable` is driven by a *zod schema*. Zod-driven is leaner here because the wire schema already exists.

---

## Plan

### 1. New primitive: `dbTable(name, schema, meta)`

**Location:** `plugins/database/plugins/schema-table/server/` (umbrella `database`), implementation in `server/internal/db-table.ts`, exported from the sub-plugin's `server/index.ts`. Importable by any plugin's `tables.ts` as `@plugins/database/plugins/schema-table/server`.

> Rationale for home: pure DB-schema concern, sits alongside the other `database/*` sub-plugins. Importing a DB primitive into `tables.ts` is already the norm (`db` from `@plugins/database/server`).

**Signature (shape):**

```ts
export function dbTable<S extends z.ZodObject<z.ZodRawShape>>(
  name: string,
  schema: S,
  meta: TableMeta<S>,
): PgTableWithColumns</* row type === z.infer<S> */>;
```

**Field set** comes from `schema.shape` — iterate its keys. For each key derive the column:

| zod node (v3 `._def` / checks) | Drizzle column |
| --- | --- |
| `ZodString` + `.uuid()` check | `uuid(col)` |
| `ZodString` | `text(col)` |
| `ZodNumber` + `.int()` check | `integer(col)` |
| `ZodNumber` (float) | `doublePrecision(col)` *(default; `meta` can override)* |
| `ZodBoolean` | `boolean(col)` |
| `ZodDate` or `ZodEffects` wrapping a coerced date | `timestamp(col, { withTimezone: true })` |
| `ZodArray` / `ZodObject` | `jsonb(col).$type<z.infer<field>>()` |
| `.nullable()` / `.optional()` | nullable column; otherwise `.notNull()` |

- **Column name** = `snake_case(key)` by default (`operationKind` → `operation_kind`), overridable via `meta`.
- **Return type** carries `z.infer<S>` as the inferred select type (typed via the generic + an internal `as unknown as` cast, exactly as `collections/buildTable` does), so `db.select()` is typed as the resource shape by construction.

**`meta` — the storage-only dimension** (per-column + table-level):

```ts
type TableMeta<S> = {
  columns?: Partial<Record<keyof z.infer<S>, {
    primaryKey?: boolean;
    default?: "random" | "now" | (string | number | boolean | unknown[]);
    type?: "integer" | "double" | "bigint";   // disambiguate ZodNumber / ZodArray storage
    columnName?: string;                        // override snake_case default
  }>>;
  indexes?: (t: AnyColumns) => PgIndex[];        // unique / composite indexes, mirrors pgTable's 3rd arg
};
```

- `default: "random"` → `.defaultRandom()`; `"now"` → `.defaultNow()`; literal → `.default(value)`.
- **Escape hatch:** anything not expressible from zod + meta (custom column types like `rankText`, generated columns, check constraints) stays a literal `pgTable` in that plugin's `tables.ts`. `dbTable` covers the common 1:1 case; it does not have to cover everything.

**Co-located unit test** (`server/internal/db-table.test.ts`, `bun:test`): assert that a representative schema yields the expected column set, types, nullability, names, and defaults. This is the regression anchor for the mapping logic.

### 2. Register the factory with the boundary check

Add to `TABLE_FACTORIES` in
`plugins/framework/plugins/tooling/plugins/checks/plugins/table-defs-in-schema-glob/check/index.ts`:

```ts
{ name: "dbTable", definedIn: "plugins/database/plugins/schema-table/server/internal/db-table.ts" },
```

This exempts the helper body (which contains the literal `pgTable(` token) from Rule 1. Call sites in `tables.ts` are already exempt (glob-matched files fail `isCandidatePath`). Without this, the check fails on the helper file.

### 3. Migrate `slow-ops` to the new primitive (first adopter)

**`plugins/debug/plugins/slow-ops/server/internal/tables.ts`** — replace the literal `pgTable` with:

```ts
import { uniqueIndex } from "drizzle-orm/pg-core";
import { dbTable } from "@plugins/database/plugins/schema-table/server";
import { SlowOpSchema } from "../../core";

export const _slowOps = dbTable("slow_ops", SlowOpSchema, {
  columns: {
    id: { primaryKey: true, default: "random" },
    count: { default: 0 },
    totalMs: { type: "double", default: 0 },
    maxMs: { type: "double", default: 0 },
    lastMs: { type: "double", default: 0 },
    thresholdMs: { type: "double", default: 0 },
    callers: { default: [] },
    recentSamples: { default: [] },
    firstSeenAt: { default: "now" },
    lastSeenAt: { default: "now" },
  },
  indexes: (t) => [
    uniqueIndex("slow_ops_kind_op_worktree_idx").on(
      t.operationKind, t.operation, t.worktree,
    ),
  ],
});
```

> **Hard requirement: zero schema drift.** The derived DDL must be byte-identical to the existing `slow_ops` table (same column names, types, nullability, defaults, and the existing unique index). Goal: `./equin build` generates **no new migration** and `migrations-in-sync` passes clean. If a diff appears, adjust the mapping/`meta` to match the existing table exactly — do not just commit a generated migration.

**`plugins/debug/plugins/slow-ops/server/internal/resources.ts`** — delete the projection:

```ts
loader: async (): Promise<SlowOp[]> =>
  db.select().from(_slowOps).orderBy(desc(_slowOps.totalMs)),
```

Remove the now-unused per-field mapping and any imports it leaves dangling.

**`plugins/debug/plugins/slow-ops/core/resources.ts`** — unchanged (it is the source of truth).

No import cycle is introduced: `core/resources.ts` imports nothing from `server/`; `server/tables.ts` now imports the `SlowOpSchema` *value* from `core` (previously it imported the `CallerBreakdown`/`SlowOpSample` *types* from `core`).

### 4. (Out of scope, note only) Other adopters

Other 1:1 table→resource loaders (`conversations/summary`, etc.) can adopt `dbTable` incrementally. Loaders that genuinely transform rows (e.g. `sonata/library` converts `Date`→ISO string) are not 1:1 and are intentionally left alone. Do **not** refactor them in this change.

---

## Critical files

- **New:** `plugins/database/plugins/schema-table/server/internal/db-table.ts` (+ `index.ts`, `db-table.test.ts`)
- **Edit:** `plugins/framework/plugins/tooling/plugins/checks/plugins/table-defs-in-schema-glob/check/index.ts` (register factory)
- **Edit:** `plugins/debug/plugins/slow-ops/server/internal/tables.ts` (use `dbTable`)
- **Edit:** `plugins/debug/plugins/slow-ops/server/internal/resources.ts` (delete projection)
- **Reference / reuse:** `plugins/primitives/plugins/collections/core/internal/table-builder.ts` (field→column builder + `as unknown as` typing trick), `plugins/database/plugins/migrations/drizzle.config.ts` (schema glob)

## Verification

1. `./equin build` — regenerates migrations. **Confirm no new migration is produced** (DDL identical to existing `slow_ops`). If one is, fix the mapping until the diff is empty.
2. `./equin check` — `migrations-in-sync`, `type-check`, `table-defs-in-schema-glob`, and boundary checks all pass.
3. `bun test plugins/database/plugins/schema-table/server/internal/db-table.test.ts` — mapping unit test passes.
4. Open the Slow Ops debug pane at `http://<worktree>.localhost:9000` (Debug → Slow Ops) and confirm rows render with all fields, including `recentSamples`. Use `mcp__singularity__query_db` to confirm the `slow_ops` table structure is unchanged.
5. **Footgun gone:** adding a field to `SlowOpSchema` now makes the column appear in the table and flow to the client with no other edits — there is no projection to forget and no second field list to drift from.
