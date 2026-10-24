# Facets v3 — Phase 1: Catalog `FacetTable` slot infrastructure

> Implements Phase 1 of `research/2026-06-02-global-facets-rendering-separation-v3.md`.

## Context

The Forge **catalog** aggregates cross-plugin contributions into per-category tables
(Routes, Panes, Slots, Resources, Contributions). Today every category is **hardcoded
in `catalog/web/index.ts`** against `node.publicApi?.*` (e.g. `p.publicApi?.routes`), and
each table component reads `publicApi` directly. There is no extension point for a *facet*
to contribute its own aggregated table.

The v3 design makes **catalog a first-class symmetric facet surface** (decision D5): each
facet owns its rendering across all four surfaces (doc, detail, diff, catalog). For catalog,
that means each facet contributes a declarative `Catalog.FacetTable`, and the catalog host
iterates contributions **generically** — never naming a facet, slicing `node.facets[facetId]`
by an id carried on the contribution.

Phase 1 lands **only the slot + contract** (no consumers yet). The diff slot
(`review.plugin-changes.diff-renderer`) and detail slot (`PluginView.Section`) already exist;
this adds the missing catalog slot so Phase 2 (the `exports` reference vertical) has somewhere
to plug in. The existing hardcoded `Catalog.Category` tables are **left untouched** — they
migrate later in Phase 4.

## Key deviation from the design doc: placement is `web/`, not `core/`

The doc lists `NEW: catalog/core/facet-table.ts`. That is not viable: the interface must
reference `ColumnDef` (from `@plugins/primitives/plugins/data-table/web`) and React's
`ComponentType`. The boundary checker enforces runtime isolation
(`plugins/framework/plugins/tooling/plugins/boundaries/boundary-config.ts`):

```
core: ["core"]   // a core file may ONLY import from core
```

A `core/` file importing `data-table/web` is a `core → web` edge — rejected by
`./equin check --plugin-boundaries`. `CatalogFacetTable` is inherently a **browser
rendering contract** (columns feed a React `DataTable`; `icon` is a React component), exactly
the runtime where it's consumed. So it lives in `web/`, mirroring how the slot itself
(`Catalog`) already lives in `catalog/web/slots.ts`. No downstream phase needs it from `core`
— all three render slots and their contributors are `web`, and Phase 3 contributors import it
via `@plugins/apps/plugins/forge/plugins/catalog/web`.

## Design

### Contract — `catalog/web/facet-table.ts` (NEW)

```ts
import type { ComponentType } from "react";
import type { ColumnDef } from "@plugins/primitives/plugins/data-table/web";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/core";

/** One plugin's slice of a facet's data, paired with its node. */
export interface FacetTableEntry<T = unknown> {
  node: PluginNode;
  data: T;
}

/**
 * Declarative aggregated cross-plugin table for one facet. Contributed to the
 * `Catalog.FacetTable` slot. The catalog host slices `node.facets[facetId]` for
 * every plugin, builds entries, projects them to rows, and renders through the
 * data-table primitive — staying entirely facet-blind.
 */
export interface CatalogFacetTable<Row = unknown> {
  /** Facet id; host slices `node.facets[facetId]` for every plugin. */
  facetId: string;
  /** Tab label, e.g. "Routes", "Slots". */
  label: string;
  /** Tab icon for the catalog category strip. */
  icon: ComponentType<{ size?: number }>;
  /** Columns passed straight to the data-table primitive. */
  columns: ColumnDef<Row>[];
  /** Project the per-plugin facet entries into flat table rows. */
  rows: (entries: FacetTableEntry[]) => Row[];
  /** Stable, unique key per row (passed to data-table's `rowKey`). */
  rowKey: (row: Row) => string;
}

/**
 * Type-erasing factory. `columns`/`rows`/`rowKey` correlate over `Row`, but the
 * slot stores one homogeneous `CatalogFacetTable` (= `<unknown>`). Because `Row`
 * sits in contravariant positions, a concrete `CatalogFacetTable<RouteRow>` is NOT
 * assignable to `CatalogFacetTable<unknown>`. This factory type-checks authoring
 * against the concrete `Row`, then erases for storage.
 */
export function defineFacetTable<Row>(table: CatalogFacetTable<Row>): CatalogFacetTable {
  return table as CatalogFacetTable;
}
```

Rationale for the additions beyond the doc sketch:
- `icon` + `label` — the catalog category strip needs both per tab (parity with the existing
  `CatalogCategoryMeta`). Count is **derived** (`rows(entries).length`), so no `getCount` field.
- `rowKey` — `DataTable` requires it (`DataTableProps.rowKey`); keeping it on the contract means
  the host can render generically with zero per-facet knowledge.
- `defineFacetTable` — without it, the first concrete contributor (Phase 2) hits the
  generic-variance wall. Mirrors the precedent that heterogeneous slot payloads are erased to a
  single stored type (the `DiffRenderer` slot stores `unknown`; here we keep authoring type-safe
  via the factory instead).

### Slot — `catalog/web/slots.ts` (EDIT)

Add a plain list slot (the host iterates all contributions, like `PluginChanges.DiffRenderer`):

```ts
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { CatalogFacetTable } from "./facet-table";

export const Catalog = {
  Category: /* unchanged */,
  FacetTable: defineSlot<CatalogFacetTable>("catalog.facet-table", {
    docLabel: (t) => t.label,
  }),
};
```

### Barrel — `catalog/web/index.ts` (EDIT)

Re-export the new contract + factory (the `Catalog` object already re-exported):

```ts
export { Catalog } from "./slots";
export type { CatalogFacetTable, FacetTableEntry } from "./facet-table";
export { defineFacetTable } from "./facet-table";
```

No changes to the existing `Catalog.Category` contributions in this phase.

## Critical files

| File | Change |
|---|---|
| `plugins/apps/plugins/forge/plugins/catalog/web/facet-table.ts` | NEW — `CatalogFacetTable`, `FacetTableEntry`, `defineFacetTable` |
| `plugins/apps/plugins/forge/plugins/catalog/web/slots.ts` | EDIT — add `Catalog.FacetTable` via `defineSlot` |
| `plugins/apps/plugins/forge/plugins/catalog/web/index.ts` | EDIT — export the new type + factory |
| `plugins/apps/plugins/forge/plugins/catalog/CLAUDE.md` | regenerated by `./equin build` (new slot appears) |

Reused, not re-created:
- `defineSlot` — `@plugins/framework/plugins/web-sdk/core` (same as `plugin-changes/web/slots.ts:18`).
- `ColumnDef`, `DataTable` — `@plugins/primitives/plugins/data-table/web`.
- `PluginNode` — `@plugins/plugin-meta/plugins/plugin-view/core`.
- Precedent for a list slot the host iterates generically: `PluginChanges.DiffRenderer`
  (`plugins/review/plugins/plugin-changes/web/slots.ts:18-21`).

## Out of scope (later phases)

- Migrating the 5 hardcoded `Catalog.Category` tables / the catalog host to iterate
  `Catalog.FacetTable` (Phase 4.5).
- Any facet-side `render-catalog` sub-plugin (Phase 2 = `exports`, Phase 3 = the rest).
- `node.facets` population in `buildPluginTree` (Phase 4.1).
- `catalog/plugins/tables/*` live-SQL detail panes — independent of facets, untouched.

## Verification

1. `./equin build` succeeds (frontend compiles; the new slot has zero contributors,
   which is valid — `defineSlot` permits empty).
2. `./equin check --plugin-boundaries` passes — confirms the `web/` placement is clean
   (a `core/` placement would fail here; this is the gate that justifies the deviation).
3. `./equin check` passes (`plugins-doc-in-sync` — the regenerated `catalog/CLAUDE.md`
   lists the new `Catalog.FacetTable` slot).
4. Spot-check: the catalog UI at `http://<worktree>.localhost:9000` (Forge → Catalog) is
   unchanged — existing category tabs still render, since no `Catalog.Category` was touched.
