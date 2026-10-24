# Stage A — `storage` capability in the fields matrix

> Stage A of the field-first unification roadmap
> ([`2026-06-17-global-fields-unified-entities.md`](./2026-06-17-global-fields-unified-entities.md)).
> Depends on Stage 1 (delete `collections`), already landed (commit `c22b1a8a8`).

## Context

The `fields/` primitive is a **TYPE × CAPABILITY matrix**: each field *type* is one canonical
identity (`FieldType` token + `FieldIdentity`), and its *capabilities* (data-view table cell,
filter control) are sparse per-type contributions resolved with an `extends`-chain fallback. The
matrix today covers UI capabilities only — **a field type cannot declare how its value is
persisted.** There is no artifact that says "an `int` is a Postgres `integer` column", so a DB
table can never be generated from a field record. This is the missing dimension that blocks the
whole `defineEntity(name, fieldRecord)` line of work (Stages B–F), where a table, a zod wire schema,
and a live-state row-shape all derive from one field record — killing the hand-synced
table/zod/projection triple that silently dropped `recentSamples` from `slow_ops`.

This stage adds the **`storage` capability** to the matrix: per field type, a server-runtime
contribution of the Drizzle column builder for that type. It lives on the **server** runtime
specifically to keep `drizzle-orm/pg-core` out of the browser bundle — the boundary win the roadmap
calls for. **No consumer is built here** (`defineEntity` is Stage C); Stage A ships the registry,
the per-type column builders, and unit tests proving each one's column output.

## Decisions (settled with the user)

1. **Registry owner = a new `fields/server` barrel.** Symmetric to `fields/core` (owns the type
   tokens + `extends`) and `fields/web` (owns the `fields.identity` UI registry). `fields/server`
   owns the `Fields.Storage` server-contribution token and the generic `resolveFieldStorage`
   resolver. Storage is treated as **intrinsic to a type's identity** — there is exactly one column
   mapping per type, system-wide, unlike per-surface UI capabilities (cell/filter) which legitimately
   belong to their consuming surface (data-view). The `plugins/fields/CLAUDE.md` line "capability
   slots [are] owned by the consuming surface — never owned by fields" gets a carve-out documenting
   that **storage is the one universal, non-surface capability the fields plugin owns directly**, on
   the server runtime.
2. **Add a `uuid` field type.** Needed for the `slow_ops` PK (Stage D) and to give uuid a token to
   key storage on. New `plugins/fields/plugins/uuid/` with `core` (token + identity, `extends: text`
   so its values render via text's data-view cell/filter) and a `storage` sub-plugin → `uuid(name)`.
3. **Exact-token resolution (no `extends` inheritance).** Every persisted type declares its own
   column builder; `resolveFieldStorage(typeId)` does a direct keyed lookup. Keeps storage fully
   self-contained on the server (no need to mirror the web identity/`extends` map server-side). All
   Stage A types are concrete, so nothing would inherit anyway; a future derived type that wants the
   same storage re-declares a one-line builder.

## Design

### New registry: `plugins/fields/server`

`server/internal/storage.ts` — the capability token + resolver:

```ts
import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { PgColumnBuilderBase } from "drizzle-orm/pg-core";
import type { FieldType } from "@plugins/fields/core";

/** Builds the BARE column for a field's value. Modifiers (notNull, default,
 *  primaryKey, json `$type<T>` branding) are applied by the entity builder
 *  (Stage C) from the field spec + entity meta — never baked in here. */
export type StorageColumnBuilder = (name: string) => PgColumnBuilderBase;

export interface FieldStorageContribution {
  type: FieldType;
  build: StorageColumnBuilder;
}

export const Fields = {
  /** Per-type DB column. Contribute `{ type, build }`; keyed by type token. */
  Storage: defineServerContribution<FieldStorageContribution>("fields.storage", {
    docLabel: (p) => p.type.id,
  }),
};

/** Resolve a field type's column builder by exact token (no `extends` fallback). */
export function resolveFieldStorage(
  typeId: string,
): StorageColumnBuilder | undefined {
  return Fields.Storage.getContributions().find((c) => c.type.id === typeId)?.build;
}
```

`server/index.ts` — barrel (mirrors `fields/web`'s shape; `derived-views/server` is the registry-only
precedent):

```ts
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { Fields, resolveFieldStorage } from "./internal/storage";
export type { StorageColumnBuilder, FieldStorageContribution } from "./internal/storage";

export default {
  description:
    "Storage-dimension registry: owns the fields.storage server slot where each field type contributes its Drizzle column builder, keyed by type token.",
} satisfies ServerPluginDefinition;
```

### Per-type `storage` sub-plugins

One `plugins/fields/plugins/<type>/plugins/storage/` per persisted type, structurally identical to
the existing `int/plugins/config` capability sub-plugin (collapsed `package.json` + a barrel):

```
plugins/fields/plugins/<type>/plugins/storage/
├── package.json                 # @singularity/plugin-fields-<type>-storage, { singularity: { collapsed: true } }
├── CLAUDE.md
├── server/
│   ├── index.ts                 # default ServerPluginDefinition, contributions: [Fields.Storage({ type, build })]
│   └── internal/
│       ├── storage.ts           # export const build = (name) => <drizzle col>
│       └── storage.test.ts      # bun:test — asserts getSQLType()
```

`server/index.ts` (int shown; others identical modulo type/build):

```ts
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/server";
import { intFieldType } from "@plugins/fields/plugins/int/core";
import { build } from "./internal/storage";

export default {
  description: "Integer field type: DB storage capability — maps to a Postgres integer column.",
  contributions: [Fields.Storage({ type: intFieldType, build })],
} satisfies ServerPluginDefinition;
```

Column builders (`internal/storage.ts`), one per type — chosen to match the existing hand-written
`slow_ops` table (`plugins/debug/plugins/slow-ops/server/internal/tables.ts`) exactly, so Stage D
generates **zero migration drift**:

| Field type | `build(name)` | `getSQLType()` |
|---|---|---|
| `text`  | `text(name)`                              | `text` |
| `int`   | `integer(name)`                           | `integer` |
| `float` | `doublePrecision(name)`                   | `double precision` |
| `bool`  | `boolean(name)`                           | `boolean` |
| `date`  | `timestamp(name, { withTimezone: true })` | `timestamp with time zone` |
| `uuid`  | `uuid(name)`                              | `uuid` |
| `json`  | `jsonb(name)`                             | `jsonb` |

Notes:
- **`date` → timestamptz.** The existing `date` field type (`Date`-valued) is the timestamp
  primitive; no separate `timestamp` type. Matches `slow_ops`' `withTimezone: true` columns.
- **`json` branding deferred.** The bare runtime column is `jsonb(name)`; the compile-time
  `$type<z.infer<…>>()` brand is a type-only concern with no runtime artifact, applied generically by
  the entity builder (Stage C) from the field's wire zod (Stage B). Stage A asserts only the `jsonb`
  column.
- **`number` gets no storage.** It is the abstract numeric base (`int`/`float` differ in column);
  with exact-token resolution it simply never resolves, which is correct.

### New `uuid` field type

`plugins/fields/plugins/uuid/core/internal/uuid.ts` (mirrors `int`'s `extends` shape):

```ts
import { MdFingerprint } from "react-icons/md";
import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { textFieldType } from "@plugins/fields/plugins/text/core";

export const uuidFieldType = defineFieldType<string>("uuid");

export const uuidIdentity = defineFieldIdentity<string>({
  type: uuidFieldType,
  label: "UUID",
  icon: MdFingerprint,
  extends: textFieldType, // string value → reuse text's data-view cell/filter
});
```

`uuid/web/index.ts` contributes `Fields.Identity({ identity: uuidIdentity })` (mirrors
`int/web/index.ts`); `uuid/core/index.ts` re-exports the token + identity. The `storage` sub-plugin
under it contributes `Fields.Storage({ type: uuidFieldType, build: (n) => uuid(n) })`.

## Why this honors the plugin rules

- **Collection–consumer separation.** `fields/server` owns the `fields.storage` registry + the
  generic `resolveFieldStorage`; each type contributes via the generic token. Stage C's
  `defineEntity` will consume **only** `resolveFieldStorage` — never naming a type. Adding/removing a
  field type updates the matrix with zero consumer edits.
- **Boundaries.** Each storage barrel imports only runtime barrels: `@plugins/fields/server` (named
  `Fields`/`resolveFieldStorage` — not a default-plugin import, so registry-exclusivity is untouched)
  and `@plugins/fields/plugins/<type>/core` (the token). `drizzle-orm/pg-core` is a root dependency.
  No cross-plugin `shared/` or deep-path imports.
- **No table glob / TABLE_FACTORIES impact.** Builders live in `internal/storage.ts`; the drizzle-kit
  glob only matches `internal/{tables,schema}{,-*}.ts`. `defineEntity` registration in
  `TABLE_FACTORIES` is Stage C, not here.

## ⚠️ Flag for Stage C (not solved here)

`collectContributions(ordered)` runs at **server boot** (`server-core/bin/index.ts`), and
`Token.getContributions()` is meant to be read in `onReady`. But drizzle-kit discovers tables by
**evaluating `tables.ts` modules standalone** at generate time — when the contribution registry is
**empty**. So Stage C's `defineEntity` **cannot** call `resolveFieldStorage` at table-construction
(module-eval) time via the boot-collected registry. Stage C must resolve storage synchronously —
most likely by having the Stage B field-spec atom carry its resolved `build` (the way the deleted
`collections.FieldInstance._columns` attached the builder to the instance), with the
`Fields.Storage` registry serving introspection/validation rather than table assembly. This stage
deliberately ships the registry as the generic API and flags the timing so Stage C designs the
consumption path with eyes open; Stage A's own unit tests populate the registry via
`collectContributions([...])` in-test (or import `build` directly).

## Critical files

- **New** `plugins/fields/server/{index.ts,internal/storage.ts,internal/storage.test.ts}`, `package.json`
- **New** `plugins/fields/plugins/uuid/` — `core/{index.ts,internal/uuid.ts}`, `web/index.ts`, `package.json`, `CLAUDE.md`
- **New** `plugins/fields/plugins/{text,int,float,bool,date,json,uuid}/plugins/storage/` — 7 sub-plugins (barrel + `internal/storage.ts` + `storage.test.ts` + `package.json` + `CLAUDE.md`)
- **Edit** `plugins/fields/CLAUDE.md` — document the storage carve-out + the new `fields/server` runtime
- Reference (no edit): `plugins/debug/plugins/slow-ops/server/internal/tables.ts` (column-type source of truth), `plugins/database/plugins/derived-views/server/` (registry-only server-plugin precedent), `git show c22b1a8a8^:plugins/primitives/plugins/collections/core/internal/{field-types,table-builder}.ts` (mined `_columns` shape)

## Verification

- **Unit (column output).** Each `storage.test.ts` builds a throwaway table and asserts the SQL type:
  ```ts
  import { pgTable } from "drizzle-orm/pg-core";
  import { build } from "./storage";
  test("int → integer", () => {
    const t = pgTable("t", { c: build("c") });
    expect(t.c.getSQLType()).toBe("integer");
  });
  ```
  Run: `bun test plugins/fields/plugins/int/plugins/storage` (and per type). Expected SQL types per
  the table above.
- **Unit (resolver).** A `fields/server/internal/storage.test.ts` calls
  `collectContributions([{ id: "t", contributions: [Fields.Storage({ type: intFieldType, build })] }])`
  then asserts `resolveFieldStorage("int")` returns the builder and `resolveFieldStorage("number")`
  (no contribution) returns `undefined`.
- **Build + checks.** `./equin build` (regenerates the plugin registries + autogen docs for the
  new plugins) then `./equin check` — `type-check`, `plugin-boundaries`, `plugins-registry-in-sync`,
  `plugins-doc-in-sync` all green. **No new migration** is generated (no `tables.ts`/`schema.ts`
  added), so `migrations-in-sync` stays clean.
- **No consumer / no UI surface to click** in this stage — correctness is the unit tests + a green
  build/check. The first end-to-end proof is Stage D (slow_ops adopter), out of scope here.
