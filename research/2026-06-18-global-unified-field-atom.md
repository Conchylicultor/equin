# Stage B — Unified field atom in `fields/core` + `fieldsToZodObject`

> Stage B of the fields-unified-entities roadmap
> ([`2026-06-17-global-fields-unified-entities.md`](./2026-06-17-global-fields-unified-entities.md)).
> Depends on Stage A (storage capability, landed) and Stage 1 (collections deleted, landed).

## Context

The roadmap's north star is that the **`fields/` registry is the single canonical home** where a
field type declares storage + wire + UI, and an *entity* is a record of fields from which the table,
the zod wire schema, and the row-shape all derive. Stage A added the `storage` capability
(`resolveFieldStorage(typeId)` on `fields/server`). Stage C will add `defineEntity`.

Exploration revealed the codebase is **further along than the roadmap's table suggested**:

- The "field atom" already exists as **`FieldDef<T> = { type: FieldType<T>; schema: z.ZodType<T>;
  defaultValue: T; meta: FieldMeta }`** — it already bundles the type token (→ UI via `fields/`
  identity), the wire zod fragment, a default, and meta. Its `type` already references `FieldType`
  **directly from `@plugins/fields/core`** (the task-8 shim was removed).
- **`buildFieldsSchema<F>(fields): z.ZodObject`** already *is* `fieldsToZodObject` — it iterates a
  record, wraps each `field.schema.default(field.defaultValue)`, and returns an object schema.

But all of this lives in **`config_v2/core`**, and the 16 field factories
(`fields/plugins/<type>/plugins/config/core`) reach **up** into `config_v2/core` to import their own
atom (`FieldDef`/`FieldMeta`/`pickMeta`/`FieldsRecord`/`buildFieldsSchema`/`fieldSchemaWithDefault`).
That is a backwards dependency: the *config* plugin owns the canonical field type, and `fields/`
depends on it. It also means Stage C's `defineEntity` (a DB/infra primitive) would have to import its
field type from the config plugin.

**Stage B fix:** relocate the canonical field atom and its zod-derivation **down into `fields/core`**,
making `config_v2` a consumer. The cross-plugin edge already points this way
(`config_v2/core → fields/core`; `fields/core` imports zero `@plugins` and is a sink), so this is a
strict DAG improvement, not a new edge.

## Decisions (confirmed)

- **Relocate the atom to `fields/core`** (not the minimal rename-only variant).
- **Add the server twin `fieldsToColumns(record)`** in `fields/server` now (Stage C will consume it).
- Keep the name **`FieldDef`** (established across ~40 sites; renaming to `FieldSpec` is needless churn).
- **`fieldsToZodObject` does NOT bake in `.passthrough()`.** It returns a plain `z.object(shape)`.
  `config_v2`'s `defineConfig` applies `.passthrough()` itself (config needs unknown-key tolerance
  across schema evolution); Stage C's `defineEntity` gets a clean strict base. This keeps the
  config-specific concern in config_v2 — see Risk in the source doc.
- **Move `getFieldResolver`/`registerFieldResolver` to `fields/core` too** — a dependency-free,
  field-type-keyed value-resolver registry; moving it removes the last `fields/*/config → config_v2`
  edge (avatar's). Cheap (~4 line edits).

## What moves vs. stays

**Move `config_v2/core → fields/core`:**
- Types: `FieldDef`, `FieldsRecord`, `InferFieldValue`, `InferFieldsObject` (from
  `config_v2/core/internal/types.ts`). Delete `config_v2`'s **duplicate** `FieldMeta` — reuse the
  byte-identical one already in `fields/core/internal/types.ts`.
- Values: `pickMeta` (companion to `FieldMeta`); `fieldSchemaWithDefault`; `buildFieldsSchema`
  **renamed → `fieldsToZodObject`** (and drop the `.passthrough()` it currently bakes in);
  `getFieldResolver`/`registerFieldResolver`.

**Stays in `config_v2/core`:** `defineConfig`, all `configV2*` resources/schemas, tier logic,
`ConfigDescriptor`/`ConfigSource`/`JsonValue`/`Disposable`, and **`ConfigValues`** — redefined as a
**local type alias** `export type ConfigValues<F extends FieldsRecord = FieldsRecord> =
InferFieldsObject<F>` (importing `FieldsRecord`/`InferFieldsObject` from `@plugins/fields/core`). A
local alias is legal; a `cross-plugin-reexport` (`export { … } from "@plugins/fields/core"`) is
**banned** by the boundary checker — leave a comment on the alias so nobody "simplifies" it into one.

## Implementation steps (one PR — a partial move leaves type errors)

1. **`fields/core/internal/`**: add `field-spec.ts` (or extend `types.ts`) with `FieldDef`,
   `FieldsRecord`, `InferFieldValue`, `InferFieldsObject`. `FieldDef.type` now references the local
   `FieldType` (drop the cross-plugin import). Keep the existing `FieldMeta` in
   `fields/core/internal/types.ts`.
2. Move `pickMeta` → `fields/core/internal/pick-meta.ts` (imports `FieldMeta` from `./types`).
3. Move `schema-builder.ts` → `fields/core/internal/`; rename `buildFieldsSchema` → `fieldsToZodObject`
   and **remove `.passthrough()`** (return `z.object(shape)`). Keep `fieldSchemaWithDefault`.
4. Move `field-resolvers.ts` → `fields/core/internal/`.
5. **`fields/core/index.ts`** — export: `FieldDef`, `FieldsRecord`, `InferFieldValue`,
   `InferFieldsObject`, `FieldMeta` (already), `pickMeta`, `fieldsToZodObject`, `fieldSchemaWithDefault`,
   `getFieldResolver`, `registerFieldResolver`.
6. **`fields/server`** — add `fieldsToColumns(record): Record<string, PgColumnBuilderBase>` in
   `internal/` (new file, e.g. `fields-to-columns.ts`): for each `[key, field]`, call
   `resolveFieldStorage(field.type.id)`; **throw loudly** (not silent-skip) if it returns `undefined`,
   naming the field + type. Export from `fields/server/index.ts`. Unit-test alongside
   `storage.test.ts`. This is the server twin of `fieldsToZodObject`, both reading the same record.
7. **`config_v2/core/internal/types.ts`** — delete the moved types + the duplicate `FieldMeta`; add
   `import type { FieldsRecord, InferFieldsObject } from "@plugins/fields/core"`; define the local
   `ConfigValues` alias. Keep `ConfigDescriptor` etc.
8. **`config_v2/core/internal/define-config.ts`** — import `fieldsToZodObject` from
   `@plugins/fields/core`; apply `.passthrough()` here (where `buildFieldsSchema` used to bake it in).
9. **`config_v2/core/index.ts`** — remove the moved symbols from the barrel; **keep** `ConfigValues`
   (local alias). Do **not** re-export moved symbols.
10. **`config_v2/server/internal/registry.ts`** — split imports: `FieldsRecord`/`InferFieldValue` from
    `@plugins/fields/core`; keep `ConfigValues`/`ConfigDescriptor` from `@plugins/config_v2/core`.
11. **Flip the 16 factories** (`fields/plugins/<type>/plugins/config/core/internal/<type>.ts`):
    source `FieldDef`/`FieldMeta`/`pickMeta`/`FieldsRecord`/`InferFieldsObject`/`fieldSchemaWithDefault`
    from `@plugins/fields/core`. `variant.ts` call site `buildFieldsSchema(...)` → `fieldsToZodObject`.
    `avatar.ts` `getFieldResolver` → from `@plugins/fields/core`.
12. **Flip the 4 external importers** (split mixed imports — do not blind-sed):
    - `primitives/data-view/web/slots.ts` — `FieldsRecord` → fields/core.
    - `ui/variant-region/core/define-variant-region.ts` — `FieldDef` → fields/core; keep
      `defineConfig`/`ConfigDescriptor` from config_v2.
    - `framework/.../codegen/core/config-origin-gen.ts` — `FieldDef` → fields/core; keep
      `ConfigDescriptor`/`ConfigProxy`/`JsonValue` + value imports from config_v2.
    - `debug/slow-ops/server/internal/install-slow-span.ts` — `ConfigValues` **unchanged** (local alias).
    - Also update `primitives/avatar/server/internal/register-resolver.ts` (`registerFieldResolver` →
      fields/core).
13. **Prose-only CLAUDE.md edits** (let `./equin build` regen the `## Plugin reference` blocks):
    - `fields/core/CLAUDE.md` — now owns the field atom + zod-derivation; note "zod permitted
      (browser-safe, pure)".
    - `fields/CLAUDE.md` — extend the "sources FieldType from fields/core" blurb to "sources the field
      atom + zod-derivation from fields/core".
    - `config_v2/CLAUDE.md` — retarget the "Schema evolution"/"Declaring config" prose naming
      `buildFieldsSchema`/`fieldSchemaWithDefault` to `@plugins/fields/core` + `fieldsToZodObject`.
14. `./equin build` then `./equin check`.

## Critical files

- `plugins/fields/core/{index.ts,internal/types.ts}` — atom new home (+ `field-spec.ts`,
  `pick-meta.ts`, `schema-builder.ts`, `field-resolvers.ts` moved in)
- `plugins/fields/server/{index.ts,internal/}` — new `fieldsToColumns` (+ test)
- `plugins/config_v2/core/{index.ts,internal/{types.ts,define-config.ts,schema-builder.ts}}`
- `plugins/config_v2/server/internal/registry.ts`
- 16 × `plugins/fields/plugins/<type>/plugins/config/core/internal/<type>.ts`
- `plugins/primitives/data-view/web/slots.ts`, `plugins/ui/variant-region/core/define-variant-region.ts`,
  `plugins/framework/.../codegen/core/config-origin-gen.ts`,
  `plugins/primitives/avatar/server/internal/register-resolver.ts`
- `plugins/fields/core/CLAUDE.md`, `plugins/fields/CLAUDE.md`, `plugins/config_v2/CLAUDE.md`

## Boundary / cycle safety (verified in design)

- Zones are per-node, keyed `${zone}.${runtime}`; nested sub-plugins are independent nodes.
- `fields/core` imports zero `@plugins` (only `zod`, a workspace dep invisible to the checker) → stays
  a sink. As long as it imports nothing from `config_v2`, **a cycle is structurally impossible**.
- After the move: `config_v2/core → fields/core` (unchanged direction); ~14 of 16
  `fields/*/config/core → config_v2/core` edges are *removed*; the `plugin.** → plugin.**` allow edge
  already permits everything → **no `boundary-config.ts` edit needed**.
- zod in a `core` runtime is already precedented (`config_v2/core/internal/schema-builder.ts`).

## Verification

- `./equin check` green: **`type-check`** (the backstop for every flipped import),
  **`plugin-boundaries`** (no new cycle, no `cross-plugin-reexport` — confirm the `ConfigValues` alias
  is a local declaration), **`plugins-doc-in-sync`** (barrels shifted between the two plugins),
  **`config-origins-in-sync`**.
- **`git diff config/` must be empty** — this is a *type-only* relocation; the atom's runtime shape is
  unchanged, so `config-origin-gen` produces byte-identical origins and no `// @hash` moves. A
  non-empty `config/` diff means a behavior change leaked in (investigate before proceeding).
- `bun test plugins/fields/server` — new `fieldsToColumns` unit test: returns a column builder per
  field for a record of storage-backed types; **throws** on a field whose type has no storage
  contribution (e.g. `enum`).
- `bun test plugins/fields/core` (if a schema-builder test exists / add one) — `fieldsToZodObject`
  returns a strict `z.object` (no passthrough): parsing strips/ rejects unknown keys.
- Pre-flight before finalizing: repo-wide `rg 'from "@plugins/config_v2/core"'` and confirm every
  importer of a *moved* symbol is in the step-11/12 list (type-check is the backstop, but enumerate to
  size the diff).

## Follow-ups (out of scope for Stage B)

- Stage C `defineEntity(name, record, meta)` consumes `fieldsToZodObject` (core) + `fieldsToColumns`
  (server) directly — both now live in `fields/`.
- Optional: dedupe the local `pickMeta` definitions in `object.ts`/`list.ts` against the moved one.
