# Typed custom columns for DataView

## Context

User-defined custom columns in any DataView are **text-only** today. Users can't
create number, date, checkbox, or select/enum columns to capture richer metadata.

The field-type registry already provides all four types with full cell renderers,
inline editors, filter operators, and server-side filter SQL — a custom column is
just a `FieldDef` whose `type` is dispatched through those generic slots. The
definition already carries an **open** `type: string` (only the "add column" UI
hardcodes `"text"`), and the server query-augmentor already binds `def.type` into
the filter/sort compiler. So most of the machinery exists; two real gaps remain:

1. **No authoring UI** — the "Fields" settings has a label-only input; no type
   picker, no enum-options editor.
2. **Generic text storage vs. typed SQL** — values live in a single
   `data_view_custom_values.value TEXT` column. The existing per-type filter-SQL
   builders assume `col` is already the right Postgres type (true for native
   columns like `tasks.priority`). The moment a custom column's `type` is
   `number`/`date`/`bool`, `resolveFieldFilterSql(type, op)` binds a JS
   number/Date/boolean against a TEXT column → `operator does not exist: text = integer`.
   Symmetrically the web must round-trip native cell/editor values through a
   canonical text encoding. (Enum values are already strings, so enum is safe
   both server- and client-side with no storage work.)

**Intended outcome:** the "add column" affordance lets the user pick a type
(Text, Number, Date, Checkbox, Select); Select columns let the user author
`{value, label}` options. Typed columns render, edit, filter, sort, and group
correctly in both client-delegated and server-delegated DataViews.

**Scope decisions (defaults, no color/extra types in v1):**
- Picker offers **Text, Number, Date, Checkbox (bool), Select (enum)** only — the
  base types with full capability coverage. Excludes `int`/`float` (the
  exact-token SQL resolvers have no `extends` fallback) and storage-oriented
  types (avatar/secret/json/image) with no meaningful editable cell.
- Select options are **`{value, label}`** only — matches the existing enum option
  shape in the codebase. No per-option color (that's new surface; deferred).
- **No DB migration.** Storage stays `value TEXT` with a per-type canonical
  string encoding + a per-type SQL cast. Avoids a risky `text → jsonb` ALTER.

## Design

Two new per-field-type capabilities, both dispatched through registries so
`custom-columns` never names an individual type (collection–consumer separation):

### Web value codec (owned by `data-view`, mirrors `Cell`/`CellEditor`/`Filter`)
Round-trips between the native cell/editor value and the canonical text wire.
Default = identity (text/enum: `String(v)` / raw string). Only number/bool/date
contribute overrides.

Canonical encodings (verified against the actual cell/editor components):

| type   | decode (text→native)                 | encode (native→text)                         |
|--------|--------------------------------------|----------------------------------------------|
| bool   | `raw === "true"`                     | `v ? "true" : "false"`                        |
| number | `raw === "" ? null : Number(raw)`    | `v == null ? "" : String(v)`                  |
| date   | `raw ? new Date(raw) : null`         | ISO string via `toISOString()` (else `""`)    |
| text/enum | `raw ?? ""` (identity)            | `String(v ?? "")` (identity)                  |

Why the codec is mandatory (not cosmetic): `BoolEditor` computes `!props.value`,
so a raw `"false"` string is truthy → wrong toggle; `date` sort/`coerce` (Date→ms)
and in-memory filter predicates all expect native values; the current
`onEdit: String(next ?? "")` corrupts dates (`"Fri Jul 03 2026…"`). Decoding on
read is what keeps client-side (in-memory) and server-side (SQL) filter/sort/group
in agreement. Empty-string-deletes still holds (number `null`→`""`, date
`null`→`""`); bool `false`→`"false"` is intentionally a stored value.

### Server SQL cast (owned by `fields/server-capabilities`, beside `Storage`/`FilterSql`)
Presents the raw TEXT column as the correctly-typed column for the existing
filter-SQL builders **and** ORDER BY / keyset seek (which never flow through
`FilterSql` — hence a dedicated capability, not an addition to `FilterSql`).
Default = identity (raw col; text/enum). Overrides:
- number → `` sql`(${c})::numeric` ``
- bool → `` sql`(${c})::boolean` ``
- date → `` sql`(${c})::timestamptz` ``

The augmentor resolves `resolveFieldValueTextCast(def.type)` — no type named.

### `CustomColumnDef` gains `options`
`options?: { value: string; label: string }[]`, persisted in config_v2 as a
nested `listField` and threaded into the produced `FieldDef.options` (which
already exists in data-view core and is already read by the enum cell/editor/filter).

## Implementation (ordered)

**A. fields/core — mark column-eligible types**
1. `plugins/fields/core/internal/types.ts`: add `readonly customColumn?: boolean`
   to `FieldIdentity`.
2. Set `customColumn: true` in the base identities: `text`, `number`, `date`,
   `bool`, `enum` (`plugins/fields/plugins/<t>/core/internal/<t>.ts`).

**B. Server SQL-cast capability**
3. New `plugins/fields/plugins/server-capabilities/server/internal/value-cast.ts`
   (clone `internal/storage.ts`): `ValueTextCast = (rawCol: AnyColumn) => SQL`,
   contribution token, `resolveFieldValueTextCast(typeId)` live-registry resolver
   (read at request time — no eager index needed).
4. Compose `ValueTextCast` into the exported `Fields` object in
   `server-capabilities/server/internal/filter-sql.ts`; re-export the resolver
   from `server-capabilities/server/index.ts`.
5. New sub-plugins `plugins/fields/plugins/{number,bool,date}/plugins/text-cast/server`
   each contributing `Fields.ValueTextCast({ type, cast })` (+ package.json + CLAUDE.md).

**C. Web value-codec capability**
6. `plugins/primitives/plugins/data-view/core`: add `ValueCodec { decode, encode }`
   interface + `IDENTITY_CODEC`.
7. New `data-view/web/value-codec-slot.ts` (clone `web/cell-slot.ts`):
   `defineDispatchSlot` + `useResolveValueCodec()` (walks `resolveTypeChain` +
   `useFieldIdentities()`, default = identity); register `ValueCodec` on
   `DataViewSlots` in `web/slots.ts` and export the hook from the web barrel.
8. New sub-plugins `plugins/fields/plugins/{number,bool,date}/plugins/data-view-codec/web`
   each contributing `DataViewSlots.ValueCodec({ match, codec })`.

**D. custom-columns core/shared**
9. `custom-columns/core/internal/types.ts`: add `options?: {value,label}[]` to
   `CustomColumnDef`; extend `CustomColumnDefSchema` with
   `options: z.array(z.object({ value: z.string(), label: z.string() })).optional()`.
10. `custom-columns/shared/read-custom-column-defs.ts`: read/normalize `options`
    (tolerate absent).
11. `data-view/shared/custom-columns-field.ts`: add a nested `options`
    `listField` (itemFields `{ value: textField, label: textField }`) to the
    column `itemFields`. Storage only — custom-columns renders its own UI.

**E. custom-columns server**
12. `custom-columns/server/internal/query-augmentor.ts`: resolve
    `resolveFieldValueTextCast(def.type)`; when present, wrap `t.value` and assign
    the cast expression to **both** `columnMap[def.id].col` and `projection[def.id]`
    (contained `as unknown as AnyColumn` / `PgColumn` assertions — see gotcha).
    Leave `type: def.type` unchanged.

**F. custom-columns web**
13. `custom-columns/web/components/custom-column-field-extension.tsx`: resolve a
    codec per def via `useResolveValueCodec()`;
    `value: (row) => codec.decode(values.get(rowKey)?.get(def.id))`;
    `onEdit: (row, next) => setValue({ …, value: codec.encode(next) })`; thread
    `options: def.options`; add the codec resolver to the `useMemo` deps.
14. `custom-columns/web/internal/use-custom-column-defs.ts`: `addColumn(label, type, options?)`;
    add an `editOptions(id, options)` action for enum options add/rename/remove.
15. `custom-columns/web/components/data-view-settings-button.tsx`
    (`CustomColumnsFields` + `FieldRow`): add a **type picker** in the add row
    (icon + label from `useFieldIdentities()` filtered by `identity.customColumn`);
    when Select is chosen, an inline options sub-form (add/rename/remove). Type is
    **immutable after creation** (picker only in the add row).

**G. Build**
16. `./equin build` to regenerate plugin manifests / generated registries.
    **No migration** — `tables.ts`, the endpoint body (`value: z.string()`), and
    the handler are all unchanged.

## Key files
- `plugins/primitives/plugins/data-view/plugins/custom-columns/server/internal/query-augmentor.ts` (SQL cast)
- `plugins/primitives/plugins/data-view/plugins/custom-columns/web/components/custom-column-field-extension.tsx` (codec on read/write, thread options)
- `plugins/primitives/plugins/data-view/plugins/custom-columns/web/components/data-view-settings-button.tsx` (type picker + options editor)
- `plugins/primitives/plugins/data-view/plugins/custom-columns/web/internal/use-custom-column-defs.ts` (addColumn/editOptions)
- `plugins/primitives/plugins/data-view/plugins/custom-columns/core/internal/types.ts` + `shared/read-custom-column-defs.ts` (options)
- `plugins/fields/plugins/server-capabilities/server/internal/value-cast.ts` (new; clone of `internal/storage.ts`)
- `plugins/primitives/plugins/data-view/web/value-codec-slot.ts` (new; clone of `web/cell-slot.ts`)
- New sub-plugins: `fields/plugins/{number,bool,date}/plugins/text-cast/server` and `.../data-view-codec/web`

## Reused, not rebuilt
- `FieldDef.options?: {value,label}[]` already exists in data-view core and is
  already read by the enum cell/editor/filter.
- `useFieldIdentities()` already exists in `data-view/web` (label + icon per type).
- `listField` item schema is `.passthrough()`; nested `options` persist cleanly.
- `bool`/`date` already have a `storage` server sub-plugin — that contributes a
  drizzle **native column builder** (`Fields.Storage`), unrelated to the text→typed
  cast; do **not** overload it. The new `ValueTextCast` is a distinct capability.
- The generic Cell/CellEditor/Filter dispatch + `resolveFieldFilterSql` need **no
  change** — typed columns light up once `def.type` + cast + codec are in place.

## Gotchas
- **`col: AnyColumn` vs `SQL`** — `ColumnBinding.col`/`SortKey.col`/`projection`
  are typed `AnyColumn`/`PgColumn`; a cast is `SQL`. Keep the widening **contained**
  to the augmentor via two documented `as unknown as` assertions (runtime is
  correct — every consumer only interpolates `${col}` into a `sql` template).
  Widening the shared compiler contract instead would ripple across ~5 files in a
  deliberately field-type-agnostic module; not worth it.
- **Cast errors on malformed text** — `('abc')::numeric` throws at query time.
  Mitigated by (a) type is immutable after creation, (b) codec-validated encodes
  so only well-formed strings are stored. Allowing type-change later would need a
  guarded cast or value wipe — out of scope.
- **NULL after LEFT JOIN** — a missing value is SQL NULL; verified existing
  builders handle it (`(NULL)::numeric` = NULL; number/date comparisons drop NULL;
  `is-empty` → `col IS NULL`; bool `COALESCE(col,false)`; enum `is-empty` →
  `col IS NULL OR col=''`).
- **bool unset sort/group position** — web decodes unset→`false`; server sorts
  NULL last. Filtering agrees (bool COALESCEs); only the *position* of
  never-touched bools differs between client- and server-delegated views.
  Acceptable v1 gap.
- **date TZ** — inherits the existing documented server-vs-browser "start of day"
  gap in `date-filter-sql`; don't try to fix here.
- **int/float** — exact-token resolvers, no `extends` fallback; only offer base
  `number` in the picker.
- **enum option removal orphans values** — a removed option value leaves stored
  cells pointing at a gone option; `EnumCell` falls back to rendering the raw
  value. Benign; adding options is always safe.
- **`FieldExtension` referential stability** — add the resolved codec to the
  `useMemo` deps or cells go stale.

## Verification
1. `./equin build`; open `http://<worktree>.localhost:9000` on a DataView
   surface (e.g. tasks or all-conversations).
2. **Fields UI:** add a Number column, a Date column, a Checkbox column, and a
   Select column (with 2–3 options). Confirm the type picker shows icons/labels
   and the Select options editor works.
3. **Cells/editors:** enter a number, pick a date, toggle the checkbox, pick a
   select option; confirm each renders with its native cell (relative date,
   check/dash, chip) and round-trips (reload page → values persist).
4. **Client-delegated filter/sort:** filter Number `> N`, Date `before X`,
   Checkbox `is checked`, Select `is any of`; sort/group by each. Confirm results.
5. **Server-delegated filter/sort** (the critical path — the SQL cast): on a
   server-query DataView, apply the same filters/sorts and confirm **no
   `operator does not exist` errors** in the server logs
   (`~/.singularity/worktrees/<wt>/logs/*.jsonl`) and correct ordering across
   keyset pagination (scroll to trigger a cursor fetch).
6. Optionally verify stored encodings with `query_db`:
   `SELECT column_id, value FROM data_view_custom_values` — numbers as decimal
   strings, bools `"true"/"false"`, dates ISO, enum as option values.
7. `./equin check` (boundaries, type-check, doc/registry in-sync for the new
   sub-plugins).
