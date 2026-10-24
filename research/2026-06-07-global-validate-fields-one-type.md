# Validate the `fields/` design by migrating one field type end-to-end

> Task 2 of the unified-`fields/` chain. Prerequisite (task 1, the foundation) has
> landed. See [`2026-06-06-global-unified-fields-primitive.md`](./2026-06-06-global-unified-fields-primitive.md).

## Context

The foundation (task 1) stood up `fields/core` (token + `FieldIdentity` with
`extends`/`coerce` + `resolveTypeChain`), the `fields.identity` registry slot, the two
new data-view capability slots (`data-view.cell`, `data-view.filter`) with
`extends`-chain dispatch, and a first proof type — **`number`** (cell + min/max filter)
plus **`int`** (identity-only, `extends: number`). What it did **not** do: render the
filter `Control` (the bar is explicitly deferred "to task 2"), exercise the **config**
capability inside the matrix, validate through a **real consumer**, or split capabilities
into sub-plugins.

This task closes those gaps for one representative slice and **confirms/revises the slot
contracts before tasks 3–8 scale the matrix**. Per the locked decisions, the slice pairs
two types so every contract is exercised against a real consumer without inventing
throwaway data:

- **`int → number`** validates **table cell + filter + the `extends` derivation**, wired
  through the **Sonata library** data surface (the `duration` column retyped to `int`).
- **`enum`** validates the **config-render** capability *inside the matrix* (its renderer
  relocates into `fields/plugins/enum/plugins/config`, contributing to the frozen
  `config-v2.fields.renderer` slot), wired through the existing **Sonata
  `pianoKeyboardConfig.labelScope`** descriptor rendered in the settings pane.

`int` cannot cleanly carry the config capability (its renderer is bundled with
bool/text/float in the shared `primitives` plugin and has no Sonata descriptor); `enum`
cannot carry the Sonata data surface (no new enum data field is wanted). Pairing them is
the lowest-blast-radius way to prove all three contracts.

### Contract changes surfaced by the foundation (to confirm in this task)

1. **`FieldDef` was NOT renamed to `FieldProjection`.** The foundation kept the
   `FieldDef<TRow>` name and merely opened `.type` from a closed union to an open `string`
   id. **Decision: keep `FieldDef`.** The doc's rename is dropped (lower churn, name
   collision already resolved by the open-id change). This plan deletes the leftover
   `@deprecated FieldType` union (the doc marked it "Removed in task 2").
2. **Capability structure = full sub-plugin split** (chosen). The foundation contributed
   `number`'s cell+filter *inline* in `number/web/index.ts`. This task adopts the doc's
   drawn structure as the convention and **refactors `number` into
   `plugins/{table,filter}`**; `enum` gets `plugins/{config}`. Derived types (`int`) stay
   identity-only.
3. **Token direction stays sink-clean.** `fields/plugins/<t>/core` defines its own token
   via `fields/core` (as `number`/`int` already do). The relocated `enum` renderer
   dispatches by **id string** (`"enum"`), so it matches descriptors built with
   config_v2's still-separate `enumFieldType` (also id `"enum"`) — no wrong-direction edge
   into config_v2 from `fields/core`. The two `"enum"` tokens unify in task 4.

## Plan

### 1. data-view — render the filter bar (the deferred "task 2" piece)

The predicate application is already wired (`use-data-view-rows.ts:48-60`); only the
write-path UI is missing. The `Control`s and `resolveFilter` already exist.

- **New** `plugins/primitives/plugins/data-view/web/components/filter-bar.tsx`: given
  `fields`, `filters` (`activeState.filters`), `setFilter`, and `resolveFilter`, render —
  for each field where `resolveFilter(field.type ?? "text")` is defined — a labeled
  `contribution.Control` bound to `value={filters[field.id]}` /
  `onChange={(v) => setFilter(field.id, v)}` / `field`.
- **Edit** `web/components/data-view.tsx`: compute the filterable-field list (`useMemo`
  over `fields` + `resolveFilter`, which is already resolved at line 63). When non-empty,
  add a "Filter" toggle (`IconButton`, filter glyph) to the toolbar row (after
  `SearchInput`) and render `<FilterBar>` in a collapsible row below the toolbar
  (local `useState` open flag). Left-aligned (no `pr-14` gutter needed).
- No change to `use-data-view-rows.ts` — once `state.filters` is written, rows narrow.

### 2. fields/plugins/number — full sub-plugin split

Move the inline contributions out of `number/web/index.ts` into capability sub-plugins
(mirrors the doc's `plugins/{table,filter}` structure; `core` unchanged).

- `number/web/index.ts` → **identity only**: `Fields.Identity({ identity: numberIdentity })`.
- **New** `number/plugins/table/web/index.ts` → `DataViewSlots.Cell({ match: "number", component: NumberCell })`; move `number-cell.tsx` here.
- **New** `number/plugins/filter/web/index.ts` → `DataViewSlots.Filter({ match: "number", Control: NumberFilter, predicate, isActive })`; move `number-filter.tsx` + `internal/number-filter-logic.ts` here.
- Each new sub-plugin gets a `package.json` + `CLAUDE.md` (prose only; build inserts the autogen block). `int` is untouched — it still resolves `int → number` for both capabilities.

### 3. fields/plugins/enum — config capability in the matrix

- **New** `enum/core` — `enumFieldType = defineFieldType<string>("enum")` (via `fields/core`) + `enumIdentity = defineFieldIdentity({ type, label: "Select", icon: <MdList>, coerce: (v) => (typeof v === "string" ? v : String(v ?? "")) })`. Sink-clean (depends only on `fields/core`).
- **New** `enum/web/index.ts` → `Fields.Identity({ identity: enumIdentity })`.
- **New** `enum/plugins/config/web/components/enum-renderer.tsx` — moved verbatim from `config_v2/.../enum/web/components/enum-renderer.tsx`; set `EnumRenderer.type = enumFieldType` (the new `fields/` token, id `"enum"`). Reuse config_v2's `EnumFieldDef` (`options`/`display`) by importing the type from `@plugins/config_v2/plugins/fields/plugins/enum/core` (type-only; a leaf config sub-plugin reading the descriptor shape is legal).
- **New** `enum/plugins/config/web/index.ts` → `Fields.Renderer(EnumRenderer)` (the `config-v2.fields.renderer` helper from `@plugins/config_v2/plugins/fields/web`).
- **Edit** `config_v2/plugins/fields/plugins/enum/web/index.ts` — **remove** the `Fields.Renderer(EnumRenderer)` contribution and delete its `enum-renderer.tsx` (becomes core-only: factory + token, still imported by descriptors). Exactly one `"enum"` renderer now lives in the slot — no dispatch conflict.
- `enum`'s table/filter (chip cell, multi-select `string[]` filter) are **deferred to task 3** (no Sonata enum consumer this task). Note this in `enum/CLAUDE.md`.

### 4. Sonata consumers (the "real consumer" wiring)

- **Data surface (`int → number`)** — `plugins/apps/plugins/sonata/plugins/library/web/components/song-library.tsx`: change the `duration` field `type: "number"` → `type: "int"`. Keep its `formatDuration` `cell` override (validates tier-1 cell precedence). It now resolves the **`int → number`** range filter in the new bar (validates derivation + filter bar live) and keeps sort.
- **Config descriptor (`enum`)** — `plugins/apps/plugins/sonata/plugins/piano-keyboard/shared/config.ts` `labelScope` (existing 3-option `enumField`). **No code change** — after the relocation it renders through the matrix-hosted `EnumRenderer` in the settings pane. This is the "one config descriptor".

### 5. Cleanup — delete the deprecated union

- `data-view/core/internal/types.ts`: remove the `@deprecated FieldType` union. `rg "FieldType" plugins/primitives/plugins/data-view` + fix importers (string-literal `type === "media"`/`"text"` comparisons stay valid). Drop the `FieldType` re-export from the data-view `core`/`web` barrels.

### 6. Build, verify, docs

`./equin build`; verify (below); CLAUDE.md prose for new sub-plugins (autogen block inserted by build).

## Critical files

- `plugins/primitives/plugins/data-view/web/components/data-view.tsx` — filter-bar host wiring (`resolveFilter` already at :63).
- `plugins/primitives/plugins/data-view/web/components/filter-bar.tsx` — **new**.
- `plugins/primitives/plugins/data-view/web/internal/use-data-view-rows.ts` — predicate loop (:48-60, already wired; read-only).
- `plugins/primitives/plugins/data-view/core/internal/types.ts` — delete deprecated `FieldType` union (:11-17).
- `plugins/fields/plugins/number/web/index.ts` + new `plugins/{table,filter}/` — split.
- `plugins/fields/plugins/enum/` — **new** type (core + web + `plugins/config`).
- `plugins/config_v2/plugins/fields/plugins/enum/web/` — remove renderer contribution + component.
- `plugins/apps/plugins/sonata/plugins/library/web/components/song-library.tsx` — `duration` → `int`.

## Reused, do not re-implement

- `resolveTypeChain` (`@plugins/fields/core`) — the single `extends`-chain source.
- `useResolveFilter` / `useResolveCell` (`data-view/web`) — already resolve via the chain.
- `NumberCell`, `NumberFilter`, `predicate`/`isActive` (`fields/plugins/number`) — moved, not rewritten.
- `EnumRenderer` + `EnumFieldDef`/`enumField` (`config_v2/.../enum`) — renderer moved; factory/type reused in place.
- `IconButton` (`primitives/icon-button/web`), `SearchInput` (`primitives/search/web`) for the toolbar.

## Verification (end-to-end)

1. `./equin build` succeeds; `./equin check` passes (boundaries — no new cross-plugin re-exports; migrations-in-sync; eslint; plugins-doc-in-sync).
2. **Filter + derivation (`int→number`, data-view):** open `http://<worktree>.localhost:9000` → Sonata → Library → **Table**. The new "Filter" toggle reveals a min/max control for **Length** (the `int` `duration` field, resolved via `int → number`). Setting bounds narrows rows live and persists per view (localStorage `sonata:library`). Confirm no `switch(field.type)` exists — filtering goes through the `data-view.filter` slot (`rg "switch" use-data-view-rows.ts` → none).
3. **Cell precedence:** Length still renders `m:ss` (tier-1 override), proving the override beats the inherited `int→number` cell.
4. **Config (`enum`, in-matrix):** Settings → Piano keyboard → **Key labels** renders the radio group via the matrix-hosted `EnumRenderer`; changing it persists to JSONC and `useConfig` reflects it. `rg "config-v2.fields.renderer" plugins/fields/plugins/enum` shows exactly one enum contributor; none remains in `config_v2/.../enum/web`.
5. **Sub-plugin split:** `fields/plugins/number/plugins/{table,filter}` each contribute one slot entry; `number/web` contributes only identity; `int` still works (Length filters/sorts) with no `int`-specific cell/filter contribution.
6. Scripted check via `e2e/screenshot.mjs` against the Library table: `--click "Filter"`, assert the Length control appears and row count drops after applying a bound.

## Contracts confirmed (output of this task, for tasks 3–8)

- `data-view.cell` / `data-view.filter` shapes (`TableCellProps`, `FilterContribution`), `fields.identity`, and the `config-v2.fields.renderer` id/key — **unchanged, confirmed**.
- `FieldDef` name **retained**; `.type` is an open registry id; closed `FieldType` union **removed**.
- Capability structure convention = **`plugins/{config,table,filter}` sub-plugins** (full split); derived types are identity-only.
- Per-type tokens stay sink-clean (`fields/core`); duplicate id-equal tokens across `fields/` and `config_v2/` are intentional until the **task-4** unification.
