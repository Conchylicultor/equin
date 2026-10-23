# fields

The global unified **fields** primitive: a single `type × capability` matrix
shared by every data surface (data-view, Sonata, and config_v2 — which now sources
the **field atom + zod-derivation** (`FieldDef`, `FieldsRecord`,
`fieldsToZodObject`, `fieldSchemaWithDefault`, `pickMeta`, the field-value
resolver registry) directly from `fields/core`).

## Mental model

A **field type** is one canonical identity (`FieldType` token + `FieldIdentity`)
registered once in `fields/core`. Each type's *capabilities* (table cell, filter
control, future: editor, validator) are contributed to **capability slots owned
by the consuming surface** — never owned by `fields`. This mirrors the facets
`type × capability` pattern: the type dimension is owned here, the capability
dimension is owned by each consumer.

- `fields/core` — pure, browser-safe sink. The `FieldType` token, the
  `FieldIdentity` (label, icon, `extends`, `coerce`), `resolveTypeChain` —
  the single source of `extends`-chain truth, reused by every capability
  dispatcher — **and the canonical field atom**: `FieldDef` /
  `FieldsRecord` / `InferFieldValue` / `InferFieldsObject`, the zod-derivation
  `fieldsToZodObject` (a strict `z.object`, no `.passthrough()`) +
  `fieldSchemaWithDefault`, `pickMeta`, and the field-value resolver registry
  (`registerFieldResolver` / `getFieldResolver`). `zod` is permitted here
  (browser-safe, pure). No `fs`, no server imports; only a type-only
  `ComponentType` and `zod`.
- `fields/web` (this umbrella barrel) owns the **identity registry slot**
  `fields.identity`. This is the *type-dimension* registry — legitimately owned
  by `fields`. Consumers read it **by string-literal id** (`bySlot.get(
  "fields.identity")`), so no surface imports `fields/web` to read identities.

## Capability resolution & `extends`

A derived type (e.g. `int`) declares `extends: <base type>` and registers only
its identity. When a surface looks up a capability (cell, filter) for `int` and
finds none, it walks `resolveTypeChain` to the base (`number`) and reuses its
capability. Leaf plugins under `plugins/` register one type each.

## Storage — the one capability `fields` owns directly

The general rule above is that capability slots are **owned by the consuming
surface, never by `fields`** (data-view owns cell/filter; config_v2 owns the
config renderer). **`storage` is the single carve-out.** It is intrinsic to a type's identity — there is exactly one
DB column mapping per type, system-wide — so `fields` owns it directly, on a
**server-only library sub-plugin** `plugins/server-capabilities/` (kept off the
browser bundle to keep `drizzle-orm/pg-core` out of it). See that plugin's
`CLAUDE.md` for why it is a dedicated leaf (a graph sink) rather than a
`fields/server` runtime — the short version: the capability barrels import its
tokens, so anything that imports the barrels back would cycle.

- `fields/plugins/server-capabilities/server` owns the `fields.storage`
  server-contribution registry (the `Fields.Storage` token) and the generic
  `resolveFieldStorage(typeId)` resolver (plus `Fields.ValueTextCast` for a
  TEXT-stored custom-column value's cast and filter domain). Filtering has no
  per-type server capability: it is the one filter language
  (`network/live/plugins/filter`), which the DataView lowers into in the browser.
- Each persisted type contributes its Drizzle column from a
  `plugins/<type>/plugins/storage/` server sub-plugin, so adding/removing a type
  updates the matrix with zero consumer edits. **Two arms, and which one a type
  uses is a fact about the type:** `Fields.Storage({ type, build })` when the
  column holds exactly what the type declares, `({ type, decode })` when it is
  narrowed by the FIELD's own schema — in which case that schema is handed to the
  builder and really runs, on every read and write, so the narrower type is
  derived rather than asserted. Three types decode — `text`, `json`, `tags` —
  and no arm asserts
  (`research/2026-08-25-global-decoded-entity-columns.md` for the text tier,
  `research/2026-08-26-global-decoded-jsonb-entity-columns.md` for the jsonb
  one).
- **Resolution is exact-token — no `extends` fallback.** Every persisted type
  declares its own builder; `resolveFieldStorage` does a direct keyed lookup.
  (A future derived type wanting the same column re-declares a one-line builder
  rather than inheriting, keeping storage self-contained on the server with no
  need to mirror the web identity/`extends` map.)
- The sibling `plugins/server-capabilities-loader/` plugin holds the generated
  side-effect manifest that eagerly evaluates every capability barrel so each
  self-registers before any `defineEntity` runs; eval-time consumers import it
  for side-effect. This keeps `server-capabilities` a pure sink.

## Adding a field type

1. Create `plugins/fields/plugins/<type>/`.
2. `core/` defines the token + identity via `defineFieldType` /
   `defineFieldIdentity`.
3. `web/index.ts` contributes `Fields.Identity({ identity })` and (optionally)
   the surface capability slots (e.g. `DataViewSlots.Cell`,
   `DataViewSlots.Filter`).
4. If the type renders in config, add a `plugins/config` sub-plugin: its
   `web/index.ts` contributes `Fields.Renderer(<R>)` **and** `Fields.Sample(<s>)`
   (both from `@plugins/config_v2/plugins/fields/web`). The sample is one fixed
   field + value built with `fieldSample` in `core/internal/sample.ts` (exported
   from the `core/` barrel), using the
   type's own factory, a realistic label/description and a value that renders
   meaningfully without stored config or secrets; it is the type's row in the
   `config/field-gallery` specimen. See `config_v2/plugins/fields/CLAUDE.md`.
5. Run `./singularity build` — the registry is autogenerated from the filesystem.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Type-dimension registry: owns the fields.identity slot where each field type registers its identity (token, label, icon, extends, coerce).
- Web:
  - Slots: `Fields.Identity`
  - Slot contributors: 27 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `Fields.Identity` ×27
  - Exports (values): `Fields`
- Cross-plugin:
  - Imported by: 102 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `fields` ×50
    - `apps` ×12
    - `conversations` ×8
    - `debug` ×5
    - `infra` ×5
    - `tasks` ×4
    - `page` ×3
    - `backup` ×2
    - `build` ×2
    - `primitives` ×2
    - `config_v2`
    - `history/engine`
    - `ids`
    - `network/live`
    - `plugin-meta/plugin-health`
    - `release`
    - `reports`
    - `runs`
    - `shell/notifications`
- Core:
  - Exports (types):
    - `DeclaredDefault`
    - `ExactOptions`
    - `FieldDef`
    - `FieldIdentity`
    - `FieldMarks`
    - `FieldMeta`
    - `FieldOptionMeta`
    - `FieldsRecord`
    - `FieldType`
    - `InferFieldsObject`
    - `InferFieldValue`
    - `InferStoredValue`
    - `Labelled`
    - `MetaMarksOf`
    - `OptionKey`
    - `OptionValue`
    - `StoredAs`
    - `Unfilterable`
  - Exports (values):
    - `declaredDefault`
    - `defineFieldIdentity`
    - `defineFieldType`
    - `fieldSchemaWithDefault`
    - `fieldsToZodObject`
    - `NULL_OPTION_KEY`
    - `nullable`
    - `optionKey`
    - `pickMeta`
    - `resolveTypeChain`
- Sub-plugins:
  - **`avatar`** [2 sub-plugins] — Avatar field type: identity only. The config-render capability and the avatarField factory live in the plugins/config sub-plugin.
  - **`bool`** [test helpers] [8 sub-plugins] — Boolean field type: identity only. The data-view cell (check/cross) and filter (yes/no) capabilities live in the plugins/{table,filter} sub-plugins.
  - **`bytes`** [2 sub-plugins] — Bytes field type: identity only — binary data whose wire value is base64. No cell or filter: no list shows a blob.
  - **`color`** [2 sub-plugins] — Color field type: identity only. The read-only swatch cell lives in the plugins/table sub-plugin; color has no filter (sparse).
  - **`date`** [8 sub-plugins] — Date field type: identity only. The data-view cell (relative time) and filter (date range) capabilities live in the plugins/{table,filter} sub-plugins.
  - **`directory-path`** [1 sub-plugin] — Directory-path field type: identity only. The config-render capability (a folder picker) and the dirPathField factory live in the plugins/config sub-plugin.
  - **`dynamic-enum`** [1 sub-plugin] — Dynamic enum (select) field type: identity only. Options are resolved at config-render time via the plugins/config sub-plugin's slot.
  - **`dynamic-flags`** [1 sub-plugin] — Dynamic flags (toggles) field type: identity only. Options and their defaults are resolved at config-render time via the plugins/config sub-plugin's slot.
  - **`enum`** [6 sub-plugins] — Enum (select) field type: identity only. The config-render, table (chip cell), and filter (multi-select) capabilities live in the plugins/{config,table,filter} sub-plugins.
  - **`float`** [2 sub-plugins] — Float field type: identity only, extends number — reuses number's cell and filter via the extends chain.
  - **`icon`** [1 sub-plugin] — Icon field type: identity only. The config-render capability and the iconField factory live in the plugins/config sub-plugin.
  - **`image`** [1 sub-plugin] — Image field type: identity only. The read-only thumbnail cell lives in the plugins/table sub-plugin; image is a data-view-only media type with no filter (sparse).
  - **`int`** [2 sub-plugins] — Integer field type: identity only, extends number — reuses number's cell and filter via the extends chain.
  - **`json`** [2 sub-plugins] — JSON field type: identity only. The config-render capability and the jsonField factory live in the plugins/config sub-plugin.
  - **`list`** [1 sub-plugin] — List field type: identity only. The config-render capability and the listField factory live in the plugins/config sub-plugin.
  - **`location`** [3 sub-plugins] — Location field type: identity only. The read cell lives in the plugins/table sub-plugin, the is-set filter in plugins/filter, the jsonb column in plugins/storage.
  - **`multiline-text`** [1 sub-plugin] — Long text field type: identity only, extends text — reuses text's cell and filter via the extends chain.
  - **`number`** [5 sub-plugins] — Number field type: identity only. The data-view cell and filter (min/max) capabilities live in the plugins/{table,filter} sub-plugins.
  - **`object`** [1 sub-plugin] — Object field type: identity only. The config-render capability and the objectField factory live in the plugins/config sub-plugin.
  - **`rank`** [2 sub-plugins] — Rank field type: identity only, extends text — a fractional-indexing string stored in the rank_text (C-collation) domain, reusing text's cell and filter via the extends chain.
  - **`reorder-tree`** [1 sub-plugin] — Reorder-tree field type: identity only. The config-render capability and the reorderTreeField factory live in the plugins/config sub-plugin.
  - **`secret`** [1 sub-plugin] — Secret field type: identity only. The config-render/storage/central capabilities and the secretField factory live in the plugins/config sub-plugin. Registers NO coerce and contributes NO data-view…
  - **`server-capabilities`** — Server-owned field-capability library: the Fields.Storage / Fields.ValueTextCast tokens, their resolvers (resolveFieldStorage / resolveFieldValueTextCast — the latter answering a TEXT-stored value's…
  - **`server-capabilities-loader`** — Eagerly evaluates every fields storage capability barrel via a generated side-effect manifest, so each self-registers into the server-capabilities eager index. Eval-time consumers import this for…
  - **`string-list`** [2 sub-plugins] — String-list field type: identity only. The config-render capability and the stringListField factory live in the plugins/config sub-plugin.
  - **`tags`** [test helpers] [5 sub-plugins] — Tags (multi-value) field type: identity only. The data-view filter (multi-select tag chips with array-aware match-any) lives in the plugins/filter sub-plugin.
  - **`text`** [5 sub-plugins] — Text field type: identity only. The data-view cell and filter (substring) capabilities live in the plugins/{table,filter} sub-plugins.
  - **`uuid`** [2 sub-plugins] — UUID field type: identity only, extends text — a string value primarily used as a storage/PK type, reusing text's cell and filter via the extends chain.
  - **`variant`** [1 sub-plugin] — Variant field type: identity only. The config-render capability and the variantField factory live in the plugins/config sub-plugin.

<!-- AUTOGENERATED:END -->
