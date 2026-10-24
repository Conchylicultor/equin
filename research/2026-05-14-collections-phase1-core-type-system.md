# Phase 1: `defineCollection` core type system

## Context

Five plugins repeat the same 4-layer boilerplate for user-editable lists (see `research/2026-05-13-global-define-collection.md`). This phase builds just the **core type system** — the `plugins/collections/core/` barrel that everything else (server layer, web layer, field sub-plugins, settings UI) will compose on top of.

The goal: a single `defineCollection()` call that produces a drizzle `pgTable`, Zod schemas (row/create/update), and a `resourceDescriptor` — all with full end-to-end TypeScript inference.

## Files to create

```
plugins/collections/
├── package.json
├── core/
│   ├── index.ts                          # barrel
│   └── internal/
│       ├── field-types.ts                # FieldInstance<T>, createFieldInstance, type utilities
│       ├── types.ts                      # CollectionDefinition, CollectionOptions, CollectionSchemas
│       ├── table-builder.ts              # buildTable: pgTable from fields + options
│       ├── schema-builder.ts             # buildSchemas: Zod row/create/update from fields
│       └── define-collection.ts          # defineCollection: composes table + schemas + resourceDescriptor
```

No `CLAUDE.md` needed — `./equin build` autogenerates it.

## Implementation details

### 1. `package.json`

```json
{
  "name": "@singularity/plugin-collections",
  "description": "Typed collection primitive: defineCollection for managed user-editable lists.",
  "private": true,
  "version": "0.0.1"
}
```

Register in root `package.json` workspaces array.

### 2. `core/internal/field-types.ts` — Field instance types

```ts
import type { PgColumnBuilderBase } from "drizzle-orm/pg-core";
import type { z } from "zod";
```

**`FieldInstance<T>`** — the value a field factory (e.g. `textField()`) returns:

```ts
interface FieldInstance<T> {
  readonly kind: string;          // renderer dispatch key ("text", "multiline-text", etc.)
  readonly required: boolean;     // literal true/false, not boolean
  readonly label?: string;
  readonly defaultValue: T;
  readonly _columns: (name: string) => Record<string, PgColumnBuilderBase>;
  readonly _zodSchema: z.ZodType<T>;
  readonly _features?: { attachments?: boolean };
}
```

**`createFieldInstance<T, R>`** — factory that preserves the `required` literal type:

```ts
function createFieldInstance<T, R extends boolean = false>(def: {
  kind: string;
  required?: R;
  label?: string;
  defaultValue: T;
  columns: (name: string) => Record<string, PgColumnBuilderBase>;
  zodSchema: z.ZodType<T>;
  features?: { attachments?: boolean };
}): FieldInstance<T> & { readonly required: R }
```

The `R extends boolean` trick preserves the literal `true`/`false` so `InferCreateInput` can split required vs optional fields via conditional types.

**Type-level inference utilities:**

| Utility | Purpose |
|---------|---------|
| `FieldsRecord` | `Record<string, FieldInstance<unknown>>` — constraint for `fields` param |
| `InferFieldsRow<F>` | Maps each field key to its value type `T` |
| `InferRow<F>` | `{ id: string; rank: Rank } & InferFieldsRow<F>` (timestamps omitted from type — see note) |
| `InferCreateInput<F>` | Required fields mandatory, optional fields `?:` — uses conditional type split on `F[K]["required"] extends true` |
| `InferUpdatePatch<F>` | All fields `?:` |

**Note on timestamps in `InferRow`:** The existing `PromptTemplateSchema` does **not** include `createdAt`/`updatedAt`. The Zod `rowSchema` will include them (with `z.coerce.date()`) so parsing is robust, but `InferRow<F>` also includes them for completeness. The migration in Phase 6 will widen the type slightly — acceptable since no consumer references those fields.

### 3. `core/internal/types.ts` — Collection definition types

**Narrow table type** — catches column typos at compile time:

```ts
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

type CollectionTable<F extends FieldsRecord> =
  PgTable &
  { id: AnyPgColumn; createdAt: AnyPgColumn; updatedAt: AnyPgColumn } &
  { rank: AnyPgColumn } &  // always present for now; refine when ranked:false is used
  { [K in keyof F]: AnyPgColumn };
```

This gives typed column access: `collection.table.title` works, `collection.table.bogus` errors. Matches how the codebase already constrains tables (e.g. `nextRankIn` accepts `PgTable & { rank: AnyPgColumn }`).

`buildTable` returns `CollectionTable<F>` via an `as` cast on the `pgTable()` result — the cast is sound because we construct the columns to match.

```ts
interface CollectionOptions<F extends FieldsRecord> {
  key: string;           // resource + route key, e.g. "prompt-templates"
  tableName: string;     // PG table name, e.g. "prompt_templates"
  fields: F;
  primaryKey?: keyof F & string;   // reserved — throws at runtime if used
  ranked?: boolean;                // default true; false omits rank column
}

interface CollectionSchemas<F extends FieldsRecord> {
  rowSchema: z.ZodObject<any>;      // z.infer = InferRow<F>
  createSchema: z.ZodObject<any>;   // z.infer = InferCreateInput<F>
  updateSchema: z.ZodObject<any>;   // z.infer = InferUpdatePatch<F>
}

interface CollectionDefinition<F extends FieldsRecord> {
  readonly key: string;
  readonly tableName: string;
  readonly table: CollectionTable<F>;
  readonly fields: F;
  readonly schemas: CollectionSchemas<F>;
  readonly resourceDescriptor: ResourceDescriptor<InferRow<F>[]>;
  readonly options: CollectionOptions<F>;
}
```

### 4. `core/internal/table-builder.ts` — pgTable construction

**Column merge order** must match the existing hand-written table for migration compatibility:

```ts
{ id, ...fieldCols, rank?, createdAt, updatedAt }
```

This produces `{ id, title, prompt, rank, createdAt, updatedAt }` — exactly matching the existing `promptTemplatesTable`.

**Logic:**
1. Iterate `Object.entries(opts.fields)`, call `field._columns(jsName)` for each
2. Merge into `fieldCols`, checking no key conflicts with standard columns
3. Assemble: `pgTable(opts.tableName, { id: text("id").primaryKey(), ...fieldCols, rank: rankText("rank").notNull(), createdAt: timestamp(...), updatedAt: timestamp(...) })`
4. If `ranked === false`, omit the `rank` entry
5. If `primaryKey` is set, throw (deferred)

**Return type:** `CollectionTable<F>` — the `pgTable()` result is cast via `as unknown as CollectionTable<F>`. The cast is sound: we construct exactly the columns the type expects.

**Imports:** `pgTable`, `text`, `timestamp` from `drizzle-orm/pg-core`; `rankText` from `@plugins/primitives/plugins/rank/core`.

### 5. `core/internal/schema-builder.ts` — Zod schema construction

**`rowSchema`:** `z.object({ id: z.string(), ...fieldSchemas, rank?: RankSchema, createdAt: z.coerce.date(), updatedAt: z.coerce.date() })`

**`createSchema`:** For each field, `field.required ? field._zodSchema : field._zodSchema.optional()`

**`updateSchema`:** All fields `.optional()`

**Imports:** `z` from `zod`; `RankSchema` from `@plugins/primitives/plugins/rank/core`.

### 6. `core/internal/define-collection.ts` — Main assembly

```ts
function defineCollection<F extends FieldsRecord>(opts: CollectionOptions<F>): CollectionDefinition<F> {
  const table = buildTable(opts);
  const schemas = buildSchemas(opts);
  const descriptor = resourceDescriptor<InferRow<F>[]>(
    opts.key,
    z.array(schemas.rowSchema),
    [],
  );
  return Object.freeze({ key: opts.key, tableName: opts.tableName, table, fields: opts.fields, schemas, resourceDescriptor: descriptor, options: opts });
}
```

**Import:** `resourceDescriptor` from `@plugins/primitives/plugins/live-state/core`.

### 7. `core/index.ts` — Barrel

Pure re-exports only:

```ts
export { defineCollection } from "./internal/define-collection";
export { createFieldInstance } from "./internal/field-types";
export type { FieldInstance, FieldsRecord, InferRow, InferCreateInput, InferUpdatePatch } from "./internal/field-types";
export type { CollectionDefinition, CollectionOptions, CollectionSchemas } from "./internal/types";
```

## End-to-end type inference chain

```
textField({ required: true })
  → createFieldInstance<string, true>({ ... })
  → FieldInstance<string> & { required: true }
       ↓
defineCollection({ fields: { title: FI<string> & {required:true}, prompt: FI<string> & {required:false} } })
  TypeScript infers F = { title: ..., prompt: ... }
       ↓
InferRow<F> = { id: string; title: string; prompt: string; rank: Rank; createdAt: Date; updatedAt: Date }
InferCreateInput<F> = { title: string; prompt?: string }
InferUpdatePatch<F> = { title?: string; prompt?: string }
       ↓
CollectionDefinition<F>.resourceDescriptor : ResourceDescriptor<InferRow<F>[]>
  → useResource(collection.resourceDescriptor) returns live InferRow<F>[]
```

## Dependencies

| Import | From | Barrel OK for core? |
|--------|------|---------------------|
| `pgTable`, `text`, `timestamp`, `PgColumnBuilderBase`, `AnyPgColumn`, `PgTable` | `drizzle-orm/pg-core` | Yes — pure schema descriptors, no DB connection. Same pattern as `rankText` in `@plugins/primitives/plugins/rank/core`. |
| `rankText`, `RankSchema`, `Rank` | `@plugins/primitives/plugins/rank/core` | Yes — core barrel |
| `resourceDescriptor`, `ResourceDescriptor` | `@plugins/primitives/plugins/live-state/core` | Yes — core barrel |
| `z` | `zod` | Yes |

## Verification

1. **`tsc --noEmit`** — the collection infers `CollectionDefinition<F>` with correct field types; `resourceDescriptor` carries `InferRow<F>[]`
2. **`./equin check --plugin-boundaries`** — no boundary violations; only imports from core barrels and external packages
3. **Scratch type test** (not committed): define a collection matching prompt-templates fields, assert `InferRow<F>` matches the hand-written `PromptTemplate` type
4. **`./equin build`** — the new plugin is discovered and the barrel compiles

## Critical files (read before implementing)

| Purpose | Path |
|---------|------|
| Migration target table | `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/server/internal/tables.ts` |
| Migration target schema | `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/shared/resources.ts` |
| `resourceDescriptor` API | `plugins/primitives/plugins/live-state/core/resource.ts` |
| `Rank` + `RankSchema` | `plugins/primitives/plugins/rank/core/internal/rank.ts` |
| `rankText` column type | `plugins/primitives/plugins/rank/core/internal/types.ts` |
| Root workspaces | `package.json` (root) |
