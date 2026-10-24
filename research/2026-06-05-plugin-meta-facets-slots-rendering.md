# Facets v3 Phase 3 — `slots` facet rendering sub-plugins

## Context

Facets v3 (`research/2026-06-02-global-facets-rendering-separation-v3.md`) moves each
facet's browser rendering (diff / detail / catalog) out of the consumers and into the
facet's own subtree, so that *adding a facet = adding one folder subtree, touching no
consumer*. Phase 2 already proved the pattern end-to-end for the **`exports`** facet:
it has `core/to-comparable.ts` plus three browser sub-plugins (`render-diff`,
`render-detail`, `render-catalog`), each contributing to an existing web slot.

The **`slots`** facet (`plugins/plugin-meta/plugins/facets/plugins/slots/`) still has
**none** of these — its rendering lives in the consumers:
- Diff projection: `slotStrings()` in `review/plugins/plugin-changes/server/internal/compute-plugin-diff.ts:39-41`.
- Detail: `SlotsGroup` in `plugin-view/plugins/public-api/web/components/public-api-section.tsx:210-233`.
- Catalog: `SlotsTable` (old `Catalog.Category` mechanism) in `forge/plugins/catalog/web/components/categories/slots-table.tsx`.

This task replicates the `exports` reference slice for `slots`: build its three browser
renderers and move its `toComparable` projection into `core/`. **Scope is additive only** —
the new sub-plugins *contribute* to the already-existing slots (`PluginChanges.DiffRenderer`,
`PluginViewSlots.Section`, `Catalog.FacetTable`). Flipping the consumers to iterate those
contributions generically, and deleting the legacy code paths, is Phase 4 and is **out of
scope here** (exactly as Phase 2 left exports: `Catalog.FacetTable` is contributed but the
catalog view doesn't render it yet).

## The facet's data shape

`slots/core/types.ts` — `SlotDef[]` where `SlotDef = { memberName, slotId, groupName }`.
The facet has **no `relate()`** (its `CLAUDE.md` notes contributor wiring waits on the
`contributions` facet), so per-slot data carries **no `contributors[]`**. The detail/catalog
renderers therefore show group/member/slotId only — no contributor counts (the legacy
`SlotsGroup`/`SlotsTable` derived those from `SlotInfo.contributors`, which is a different,
related field not present on the facet itself). This is faithful to the facet's data.

The diff projection must stay **byte-identical** to the legacy `slotStrings()`:
`data.map(s => \`${s.groupName}.${s.memberName}\`)` — no filtering of `_runtimeOnly` slots
(the legacy path read `node.slots` unfiltered; only `renderDoc` filters runtime-only).

## Implementation

All paths under `plugins/plugin-meta/plugins/facets/plugins/slots/`.

### 1. `core/` — `toComparable` projection (pure, runtime-agnostic)

- NEW `core/to-comparable.ts`:
  ```ts
  import type { SlotDef } from "./types";
  /** Diff projection: one "<group>.<member>" string per slot.
   *  Mirrors the legacy slotStrings() (compute-plugin-diff.ts). */
  export function slotsToComparable(data: SlotDef[]): string[] {
    return data.map((s) => `${s.groupName}.${s.memberName}`);
  }
  ```
- EDIT `core/index.ts`: add `export { slotsToComparable } from "./to-comparable";`.

### 2. `plugins/render-diff/web` — `PluginChanges.DiffRenderer`

Mirror `exports/plugins/render-diff/web/index.ts`.
- NEW `plugins/render-diff/package.json` (`@singularity/plugin-plugin-meta-facets-slots-render-diff`, `description`).
- NEW `plugins/render-diff/web/index.ts`: default-export a `PluginDefinition` contributing
  `PluginChangesSlots.DiffRenderer({ facetId: "slots", label: "Slots", toComparable: (d) => slotsToComparable(d as SlotDef[]) })`.
  Imports `PluginChangesSlots` from `@plugins/review/plugins/plugin-changes/web`, and
  `slotsToComparable` + `type SlotDef` from `../../../core`.
- NEW `plugins/render-diff/CLAUDE.md` (prose; autogen block filled by build).

### 3. `plugins/render-detail/web` — `PluginViewSlots.Section`

Mirror `exports/plugins/render-detail/`. Port the `SlotsGroup` body from
`public-api-section.tsx:210-233`, reading `node.facets["slots"]` instead of `api.slots`.
- NEW `plugins/render-detail/package.json`.
- NEW `plugins/render-detail/web/components/slots-detail-section.tsx`: `SlotsDetailSection({ node })`
  reads `const data = node.facets?.["slots"] as SlotDef[] | undefined`; returns null if empty;
  renders a `<Section title="Slots" count={…}>` containing rows of `groupName.memberName` +
  `slotId`. Uses `Section`/`SubHeading` from `@plugins/plugin-meta/plugins/plugin-view/web`,
  `type SlotDef` from the facet `core`. (No contributor counts — see data-shape note.)
- NEW `plugins/render-detail/web/index.ts`: contributes
  `PluginViewSlots.Section({ id: "slots", label: "Slots", component: SlotsDetailSection })`.
- NEW `plugins/render-detail/CLAUDE.md`.

### 4. `plugins/render-catalog/web` — `Catalog.FacetTable`

Mirror `exports/plugins/render-catalog/`. Build a declarative `Catalog.FacetTable` for slots,
reusing the column shape from the legacy `SlotsTable` (Group.Member, Slot ID, Plugin).
- NEW `plugins/render-catalog/package.json`.
- NEW `plugins/render-catalog/web/slots-facet-table.tsx`: `defineFacetTable<SlotRow>({ facetId: "slots", label: "Slots", icon: MdExtension, columns, rows, rowKey })`.
  - `rows(entries)`: flatten `entry.data as SlotDef[]` into `{ plugin: entry.node, groupName, memberName, slotId }`.
  - `rowKey`: `${row.plugin.hierarchyId}:${row.slotId}`.
  - Columns: `name` (code `group.member`), `slotId`, `plugin` (`PluginChip`). Imports
    `defineFacetTable`, `type FacetTableEntry`, `PluginChip` from
    `@plugins/apps/plugins/forge/plugins/catalog/web`; `ColumnDef` from data-table;
    `type PluginNode` from plugin-view/core; `type SlotDef` from facet core; `MdExtension` from `react-icons/md`.
- NEW `plugins/render-catalog/web/index.ts`: contributes `Catalog.FacetTable(slotsFacetTable)`.
- NEW `plugins/render-catalog/CLAUDE.md`.

### 5. Update facet `CLAUDE.md` prose

`slots/CLAUDE.md` — add a one-line note that the three render sub-plugins now exist (build
regenerates the autogen reference block listing them).

## Reference files (copy shape byte-for-byte)

| New file | Mirror of |
|---|---|
| `slots/core/to-comparable.ts` | `exports/core/to-comparable.ts` |
| `slots/plugins/render-diff/web/index.ts` | `exports/plugins/render-diff/web/index.ts` |
| `slots/plugins/render-detail/web/index.ts` + `components/slots-detail-section.tsx` | `exports/plugins/render-detail/web/{index.ts,components/exports-detail-section.tsx}` |
| `slots/plugins/render-catalog/web/index.ts` + `slots-facet-table.tsx` | `exports/plugins/render-catalog/web/{index.ts,exports-facet-table.tsx}` |
| every `package.json` / `CLAUDE.md` | the matching `exports` sub-plugin files |

Slot/host APIs already exist (no consumer edits): `PluginChangesSlots.DiffRenderer`
(`plugin-changes/web`), `PluginViewSlots.Section` (`plugin-view/web`), `Catalog.FacetTable`
(`forge/catalog/web`). `PluginNode.facets?: Record<string, unknown>` already on the type
(`plugin-view/core/types.ts:85`) and passed through by `tree-handler.ts:57`.

## Plugin-boundary notes

- Renderers read `node.facets["slots"]` directly and import only **types** from the facet
  `core` barrel — never the build-time `facet/` code (keeps `loadFacets`/`fs` out of the
  browser bundle), matching the exports reference's documented rationale.
- Cross-plugin imports use runtime barrels only (`@plugins/.../{web,core}`), satisfying R10
  and the import grammar.

## Verification

1. `./equin build` — succeeds; codegen fills each new `CLAUDE.md` autogen block and
   registers the three sub-plugins.
2. `./equin check` — passes (`plugins-doc-in-sync`, `eslint`, `--plugin-boundaries`).
3. `rg -n "DiffRenderer|PluginViewSlots.Section|Catalog.FacetTable" plugins/plugin-meta/plugins/facets/plugins/slots`
   shows one contribution of each, all with `facetId`/`id` = `"slots"`.
4. `docs/plugins-compact.md` / `docs/plugins-details.md` now list the three slots render
   sub-plugins (mirroring the exports entries).

Note: the new renderers won't *visibly* change the Forge detail pane, catalog, or PR diff
yet — those consumers still use the legacy paths until Phase 4 flips them to generic
iteration. This task only lands the contributions, exactly as Phase 2 did for exports.
```
