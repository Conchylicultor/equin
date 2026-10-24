# Typed custom columns for DataView — v2 (fully-closed design)

> Supersedes `2026-07-03-data-view-typed-custom-columns.md`. v1 special-cased the
> `enum` options editor and its storage shape inside `custom-columns`, which broke
> the collection–consumer invariant: adding a type that needs add-time config would
> force edits to `custom-columns`. v2 closes that hole — **adding custom-column
> support for any field type touches only `fields/<type>/…`.**

## Context

Custom columns in any DataView are **text-only** today. Users can't create number,
date, checkbox, or select/enum columns. The field-type registry already provides
all these types with full cell renderers, inline editors, filter operators, and
server-side filter SQL — a custom column is just a `FieldDef` whose `type` is
dispatched through those generic slots. `CustomColumnDef.type` is already an open
field-type id (only the "add column" UI hardcodes `"text"`), and the server
query-augmentor already binds `def.type` into the filter/sort compiler.

Two real gaps: **(1)** no authoring UI (type picker + per-type config like enum
options), and **(2)** values live in one generic `data_view_custom_values.value TEXT`
column, but the per-type filter-SQL builders assume `col` is already the right
Postgres type — so a `number`/`date`/`bool` custom column emits
`operator does not exist: text = integer`. Symmetrically the web must round-trip
native cell values through a canonical text encoding.

**Intended outcome:** "add column" lets the user pick a type and configure it
(e.g. Select options); typed columns render, edit, filter, sort, and group in both
client- and server-delegated DataViews. **No DB migration** (storage stays TEXT).

## The invariant this design must satisfy

> Adding custom-column support for a field type `X` must require editing **only**
> files under `plugins/fields/plugins/X/…` — never `custom-columns`, `data-view`,
> or `server-query`.

Everything below is derived from that. `custom-columns` resolves every per-type
concern generically by `def.type`; it names no type and understands no type-shaped
data.

## How a field type opts into custom-column support

Each concern is a slot contribution keyed by the type token. A type implements
**only what it needs** — a type whose value is already a string and needs no
config (e.g. `text`) implements just level 1.

| Concern | Contribution (owner slot) | File under `fields/<type>/` | Needed by |
|---|---|---|---|
| 1. Picker eligibility | `customColumn: true` on `FieldIdentity` | `core/internal/<type>.ts` | all |
| 2. Cell renderer | `DataViewSlots.Cell` (data-view) | `plugins/table/web` | any type lacking one (e.g. avatar) |
| 3. Inline editor | `DataViewSlots.CellEditor` (data-view) | `plugins/inline/web` | editable types |
| 4. Filter operators | `DataViewSlots.Filter` (data-view) | `plugins/filter/web` | filterable types |
| 5. Filter SQL | `Fields.FilterSql` (fields/server-capabilities) | `plugins/filter-sql/server` | server-filterable |
| 6. **Native↔text codec** | `DataViewSlots.ValueCodec` (data-view) — NEW | `plugins/data-view-codec/web` | non-string value |
| 7. **Text→typed SQL cast** | `Fields.ValueTextCast` (fields/server-capabilities) — NEW | `plugins/text-cast/server` | non-string value, server sort/filter |
| 8. **Add-time config editor** | `DataViewSlots.ColumnConfig` (data-view) — NEW | `plugins/column-config/web` | types needing config (e.g. enum options) |

Concrete per-type coverage in v1 scope:
- **text** — level 1 only (value is a string; default codec + raw column; no config).
- **enum** — levels 1, 2, 3, 4, 5 (all pre-exist) + **8** (options editor). Value is
  a string → **no codec (6), no cast (7)**.
- **number / bool / date** — levels 1–5 pre-exist + **6 + 7** (non-string value).
  No config editor.
- **avatar (future)** — levels 1, 2, 3, 6 (JSON codec). No config, no server SQL —
  degrades gracefully (not offered as filter/sort). All files in `fields/avatar/`.

## New capabilities (design detail)

### Web value codec — `DataViewSlots.ValueCodec` (owned by data-view)
Round-trips native cell/editor value ↔ canonical text. Default = identity
(text/enum). Mirrors `Cell`/`CellEditor`/`Filter` (dispatch slot + type-chain
resolver hook). Canonical encodings (verified against the actual components):

| type   | decode (text→native)              | encode (native→text)                    |
|--------|-----------------------------------|-----------------------------------------|
| bool   | `raw === "true"`                  | `v ? "true" : "false"`                  |
| number | `raw === "" ? null : Number(raw)` | `v == null ? "" : String(v)`            |
| date   | `raw ? new Date(raw) : null`      | ISO via `toISOString()` (else `""`)     |
| identity (text/enum) | `raw ?? ""`         | `String(v ?? "")`                       |

Mandatory for correctness: `BoolEditor` computes `!props.value` (raw `"false"` is
truthy → wrong toggle); date `coerce` (Date→ms), in-memory filter predicates, and
sort all expect native values; the current `String(next)` corrupts dates. Decoding
is what keeps client-side (in-memory) and server-side (SQL) filter/sort/group
consistent. Empty-string-deletes still holds; bool `false`→`"false"` is a stored value.

### Server SQL cast — `Fields.ValueTextCast` (owned by fields/server-capabilities)
Presents the raw TEXT column as the correctly-typed column for filter SQL **and**
ORDER BY / keyset seek (sort never flows through `FilterSql`, hence a distinct
capability). Default = identity. Overrides: number `(c)::numeric`, bool
`(c)::boolean`, date `(c)::timestamptz`. The augmentor resolves
`resolveFieldValueTextCast(def.type)` — no type named. Read at request time; a plain
live-registry resolver (no eager index) suffices.

### Add-time config — opaque blob + `DataViewSlots.ColumnConfig`
- `CustomColumnDef = { id, label, type, config?: unknown }` — **opaque** blob;
  `custom-columns` passes it through untouched. No `options` field.
- `DataViewSlots.ColumnConfig({ match, component })` — a per-type editor rendered in
  the Fields settings when the selected type contributes one. Props:
  `{ config: unknown; onChange: (next: unknown) => void }`.
- `enum` contributes `fields/enum/plugins/column-config/web` — the options
  add/rename/remove editor, reading/writing `config.options: {value,label}[]`.
- `enum`'s **cell/editor/filter** already read `FieldDef.options`; the enum
  data-view integration derives `options` from `def.config?.options` when producing
  the `FieldDef` (this projection lives with enum, not custom-columns — see F below).

## Implementation (ordered)

**A. fields/core — eligibility flag**
1. `plugins/fields/core/internal/types.ts`: add `readonly customColumn?: boolean` to
   `FieldIdentity`.
2. Set `customColumn: true` on the base identities: `text`, `number`, `date`,
   `bool`, `enum` (`plugins/fields/plugins/<t>/core/internal/<t>.ts`).

**B. Server SQL-cast capability**
3. New `plugins/fields/plugins/server-capabilities/server/internal/value-cast.ts`
   (clone `internal/storage.ts`): `ValueTextCast = (rawCol: AnyColumn) => SQL`,
   contribution token, `resolveFieldValueTextCast(typeId)` live resolver.
4. Compose into the exported `Fields` in `.../internal/filter-sql.ts`; re-export the
   resolver from `server-capabilities/server/index.ts`.
5. New sub-plugins `fields/plugins/{number,bool,date}/plugins/text-cast/server`
   contributing `Fields.ValueTextCast({ type, cast })` (+ package.json + CLAUDE.md).

**C. Web value-codec capability**
6. `data-view/core`: add `ValueCodec { decode, encode }` + `IDENTITY_CODEC`.
7. New `data-view/web/value-codec-slot.ts` (clone `web/cell-slot.ts`):
   `defineDispatchSlot` + `useResolveValueCodec()` (walks `resolveTypeChain` +
   `useFieldIdentities()`, default identity); register on `DataViewSlots`
   (`web/slots.ts`); export from web barrel.
8. New sub-plugins `fields/plugins/{number,bool,date}/plugins/data-view-codec/web`
   contributing `DataViewSlots.ValueCodec({ match, codec })`.

**D. Web column-config capability**
9. `data-view/core`: add `ColumnConfigProps { config: unknown; onChange: (next: unknown) => void }`.
10. New `data-view/web/column-config-slot.ts` (dispatch slot + `useResolveColumnConfig(typeId)`
    returning the component or `null`); register on `DataViewSlots`; export from barrel.
11. New sub-plugin `fields/plugins/enum/plugins/column-config/web` contributing
    `DataViewSlots.ColumnConfig({ match:"enum", component: EnumOptionsEditor })`
    (add/rename/remove `config.options`).

**E. custom-columns core/shared (type-agnostic)**
12. `custom-columns/core/internal/types.ts`: `CustomColumnDef` gains
    `config?: unknown`; `CustomColumnDefSchema` gains `config: z.unknown().optional()`.
    No `options`.
13. `custom-columns/shared/read-custom-column-defs.ts`: read/normalize `config`
    (opaque passthrough; tolerate absent).
14. `data-view/shared/custom-columns-field.ts`: add `config` to the column
    `itemFields` as an opaque/passthrough field (config_v2 `jsonField` or equivalent
    passthrough — the item schema is already `.passthrough()`, so a `config` object
    round-trips; declare it explicitly for clarity). No enum-specific shape here.

**F. enum data-view integration (options → FieldDef.options)**
15. In enum's data-view integration (its `data-view` field-mapping contribution, or a
    small `fields/enum/plugins/…` helper that custom-columns invokes generically):
    project `def.config?.options` → `FieldDef.options`. **Key:** custom-columns must
    NOT read `config.options` itself. Cleanest seam: a generic per-type
    `DataViewSlots.FieldConfigProjection({ match, project(config): Partial<FieldDef> })`
    that enum contributes (`{ options: config.options }`); custom-columns merges the
    projection into the produced `FieldDef` generically. (If a lighter approach
    suffices, enum's `Cell`/`Editor`/`Filter` could read `field.config?.options`
    directly instead of `field.options` — but adding `config` to `FieldDef` and having
    enum read it keeps the projection with enum and avoids a new slot. Decide during
    build; either way no type name enters custom-columns.)

**G. custom-columns server**
16. `custom-columns/server/internal/query-augmentor.ts`: resolve
    `resolveFieldValueTextCast(def.type)`; wrap `t.value` when present; assign the cast
    expr to **both** `columnMap[def.id].col` and `projection[def.id]` (contained
    `as unknown as AnyColumn` / `PgColumn` assertions). Leave `type: def.type` unchanged.

**H. custom-columns web**
17. `custom-columns/web/components/custom-column-field-extension.tsx`: resolve codec via
    `useResolveValueCodec()`; `value: (row) => codec.decode(values…get(def.id))`;
    `onEdit: (row,next) => setValue({ …, value: codec.encode(next) })`; thread the
    generic field-config projection (F) from `def.config`; **derive** `sortable`/
    `filterable` from whether the type contributes filter/sort capabilities (don't
    hardcode `true` — else avatar shows an empty filter UI); add resolvers to `useMemo` deps.
18. `custom-columns/web/internal/use-custom-column-defs.ts`: `addColumn(label, type)`;
    add `setColumnConfig(id, config)` (opaque). No enum knowledge.
19. `custom-columns/web/components/data-view-settings-button.tsx`: add a **type picker**
    (icon+label from `useFieldIdentities()` filtered by `identity.customColumn`); after
    a type is chosen, render `useResolveColumnConfig(type)` (if any) wired to
    `setColumnConfig`. Type is **immutable after creation** (picker only in the add row).
    No `if (type === "enum")` anywhere.

**I. Build**
20. `./equin build` (regenerates manifests / registries for the new sub-plugins).
    **No migration** — `tables.ts`, endpoint body (`value: z.string()`), and handler
    are unchanged.

## Key files
- `fields/plugins/server-capabilities/server/internal/value-cast.ts` (new; clone of `internal/storage.ts`)
- `data-view/web/value-codec-slot.ts`, `data-view/web/column-config-slot.ts` (new; clone of `web/cell-slot.ts`)
- New sub-plugins: `fields/plugins/{number,bool,date}/plugins/{text-cast/server,data-view-codec/web}`, `fields/plugins/enum/plugins/column-config/web`
- `custom-columns/server/internal/query-augmentor.ts` (SQL cast)
- `custom-columns/web/components/{custom-column-field-extension.tsx,data-view-settings-button.tsx}`, `web/internal/use-custom-column-defs.ts`
- `custom-columns/core/internal/types.ts`, `shared/read-custom-column-defs.ts` (opaque `config`)

## Reused, not rebuilt
- `FieldDef.options?: {value,label}[]` already exists and is already read by the enum
  cell/editor/filter.
- `useFieldIdentities()` already exists in `data-view/web` (label + icon per type).
- `listField` item schema is `.passthrough()`; the `config` blob round-trips.
- Generic Cell/CellEditor/Filter dispatch + `resolveFieldFilterSql` — **no change**.
- `bool`/`date` already have a `storage` server sub-plugin contributing a drizzle
  **native column builder** (`Fields.Storage`) — unrelated to the text→typed cast;
  do **not** overload it. `ValueTextCast` is distinct.

## Gotchas
- **`col: AnyColumn` vs `SQL`** — `ColumnBinding.col`/`SortKey.col`/`projection` are
  typed `AnyColumn`/`PgColumn`; a cast is `SQL`. Keep the widening **contained** to
  the augmentor via two documented `as unknown as` assertions (runtime correct — every
  consumer only interpolates `${col}` into a `sql` template). Cast **both** `col` and
  `projection[def.id]` so the keyset cursor projects the typed expression too.
- **Cast errors on malformed text** — `('abc')::numeric` throws at query time.
  Mitigated by type-immutable-after-creation + codec-validated encodes.
- **NULL after LEFT JOIN** — a missing value is SQL NULL; existing builders handle it
  (`(NULL)::numeric` = NULL; comparisons drop NULL; `is-empty`→`col IS NULL`; bool
  `COALESCE(col,false)`; enum `is-empty`→`col IS NULL OR col=''`).
- **bool unset sort/group position** — web decodes unset→`false`; server sorts NULL
  last. Filtering agrees; only the *position* of never-touched bools differs between
  client- and server-delegated views. Acceptable v1 gap.
- **date TZ** — inherits the existing documented server-vs-browser "start of day" gap
  in `date-filter-sql`; don't fix here.
- **int/float** — exact-token resolvers, no `extends` fallback; only offer base
  `number` in the picker.
- **enum option removal orphans values** — a removed option leaves stored cells
  pointing at a gone option; `EnumCell` falls back to the raw value. Benign.
- **derive sortable/filterable from capability presence** — hardcoding `true` shows an
  empty filter UI for types (like avatar) with no filter operators.
- **`FieldExtension` referential stability** — add resolved codec/projection to the
  `useMemo` deps or cells go stale.

## Verification
1. `./equin build`; open `http://<worktree>.localhost:9000` on a DataView surface.
2. **Fields UI:** add Number, Date, Checkbox, and Select (with 2–3 options) columns.
   Confirm the picker shows icons/labels and the Select options editor appears only for
   Select.
3. **Cells/editors:** enter/toggle/pick each; confirm native rendering (relative date,
   check/dash, chip) and persistence across reload.
4. **Client-delegated filter/sort/group:** Number `> N`, Date `before X`, Checkbox
   `is checked`, Select `is any of`; sort + group by each.
5. **Server-delegated filter/sort** (critical — the SQL cast): same filters/sorts on a
   server-query DataView; confirm **no `operator does not exist`** in
   `~/.singularity/worktrees/<wt>/logs/*.jsonl` and correct ordering across keyset
   pagination (scroll to trigger a cursor fetch).
6. **Invariant smoke test:** confirm `custom-columns` contains **no** `"enum"`/`"number"`
   /`"bool"`/`"date"` string literal (`rg -n '"enum"|"number"|"bool"|"date"' plugins/primitives/plugins/data-view/plugins/custom-columns` → no hits). All per-type
   knowledge lives under `fields/plugins/<type>/`.
7. `query_db`: `SELECT column_id, value FROM data_view_custom_values` — numbers decimal,
   bools `"true"/"false"`, dates ISO, enum as option values.
8. `./equin check` (boundaries, type-check, doc/registry in-sync).
