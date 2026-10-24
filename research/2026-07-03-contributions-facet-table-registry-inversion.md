# Fixing the framework→app dependency inversion in the Contributions facet-table surface

## Problem

The eager `plugin-meta/plugins/facets/plugins/<facet>/plugins/render-contributions`
plugins (non-app-content ⇒ **eager** tier) import from the **Studio app** web
surface `@plugins/apps/plugins/studio/plugins/contributions/web`:

- the `Contributions.FacetTable` slot, `defineFacetTable`, `FacetTableEntry`,
  `ContributionsFacetTable` types, and `PluginChip` (all 8 render-contributions), and
- `tableDetailPane` from `.../contributions/plugins/tables/web` (db-schema only).

This is a **framework/meta → app-UI dependency inversion**. Its consequence in
`web-tiers.generated.ts`: the transitive `dependsOn` closure pins
`apps/plugins/studio/plugins/contributions` **and its `tables` child** into the
eager boot tier, while all other Studio content defers.

### Root cause

The `Contributions.FacetTable` **registry** (slot + factory + types + `PluginChip`)
lives *inside the Studio app*, but its **contributors are meta plugins** (the facet
renderers). The registry is co-owned with the app *consumer* (the pane/view).

Compare the two sibling render surfaces, which have **no** inversion:
- `render-detail` → `plugin-meta/plugins/plugin-view/web` (`PluginViewSlots.Section`)
- `render-diff` → `review/plugins/plugin-changes/web` (`PluginChangesSlots.DiffRenderer`)

Both registries live in **non-app** plugins, so their contributors (meta) point at
meta. Only the *contributions* surface's registry sits inside an app — the asymmetry.

## Fix

### Part 1 — Relocate the registry to the meta layer

New web-only plugin **`plugin-meta/plugins/contributions-table`** (sibling of
`plugin-view`, consistent with how `render-detail` already reaches out to
`plugin-view`). It owns:

- the `Contributions` slot group: `FacetTable` (id `contributions.facet-table`,
  unchanged) **and** a new `RowClick` slot (see Part 2);
- `defineFacetTable` / `ContributionsFacetTable` / `FacetTableEntry` /
  `ContributionsRowClickContext`;
- `PluginChip` (imports `pluginViewPane` from `plugin-view/web` + `LinkChip`; all
  meta/primitive — no inversion).

All 8 `render-contributions` plugins swap their import source
(`apps/.../contributions/web` → `plugin-meta/plugins/contributions-table/web`) —
mechanical. Meta → meta. ✓

The Studio **consumer** stays in the app: `contributions-view.tsx` and the pane
remain in `apps/.../studio/plugins/contributions`, now importing the registry from
meta (app → meta ✓). `studio/contributions/web/index.ts` **stops** re-exporting the
registry symbols (they moved; no cross-plugin re-export). The barrel keeps only its
`default` plugin definition.

### Part 2 — Invert the db-schema row-click drill-down

`db-schema/render-contributions` sets `onRowClick` that opens `tableDetailPane`
(app UI owned by `contributions/plugins/tables`). This is the second meta→app import.

**Separate "what data a row shows" (meta facet renderer) from "what a click does"
(app pane owner):**

- Drop `onRowClick` from the `ContributionsFacetTable` contract. Add a keyed
  **`Contributions.RowClick`** slot in the registry: `{ facetId: string; onRowClick:
  (row, ctx) => void }`, with a `defineRowClick<Row>` type-erasing helper mirroring
  `defineFacetTable<Row>`.
- The **app** `contributions/plugins/tables` contributes
  `Contributions.RowClick({ facetId: "db-schema", onRowClick: (row, { openPane }) =>
  openPane(tableDetailPane, …) })`. It imports the registry (app → meta ✓) + its own
  pane. **No meta plugin imports `tables` anymore ⇒ `tables` defers.**
- The `ContributionsView` builds a `Map<facetId, onRowClick>` from
  `Contributions.RowClick.useContributions()` and wires the active table's click.
- Shared row shape: move the db-schema projected row type to `db-schema/core` as
  `DbSchemaTableRow { pluginId: string; name: string; varName: string }` (flattened —
  no `PluginNode`). Meta renderer projects it (`pluginId: entry.node.id`, `PluginChip`
  cell uses `row.pluginId`); the app handler imports it from core. Both type-safe,
  both meta.

### Why this is correct at runtime

Deferred plugins load as a post-paint wave, **active-app-first** (`App.tsx`): opening
Studio front-loads its whole subtree (incl. `tables`) as the priority batch. The
`RowClick` contribution registers then; `useContributions()` is reactive, so rows
become clickable as soon as `tables` loads (self-healing; worst case a brief
non-clickable window on first cold load — acceptable, fail-safe).

## Outcome

- `render-contributions` (meta) → `contributions-table` (meta). No inversion.
- `studio/plugins/contributions` (+ `tables`) lose all meta importers → both **defer**
  like the rest of Studio.
- `web-tiers.generated.ts` regenerates with those two paths moved into
  `DEFERRED_PLUGIN_PATHS`; `eager-tier-in-sync` stays green.

## Files

New: `plugin-meta/plugins/contributions-table/{package.json,CLAUDE.md,web/{index.ts,
slots.ts,facet-table.ts,components/plugin-chip.tsx}}`.
Edit: 8 `render-contributions/web/*` (import swap); `db-schema/render-contributions`
(drop onRowClick + pane import, project `DbSchemaTableRow`); `db-schema/core`
(export `DbSchemaTableRow`); `studio/contributions/web/{index.ts, facet-table.ts,
slots.ts, components/plugin-chip.tsx (delete), components/contributions-view.tsx}`;
`studio/contributions/plugins/tables/web/index.ts` (add RowClick contribution).
Then `./equin build` regenerates registries + tiers + docs.
