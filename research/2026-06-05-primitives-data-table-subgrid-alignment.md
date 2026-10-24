# data-table: subgrid column alignment

## Context

In the Sonata library's table view (the `table` child of the `data-view` primitive),
the column header labels (TITLE / COMPOSER / LENGTH / ADDED) don't line up vertically
with the row cell values — cells bunch toward the left.

**Root cause (structural, not Sonata-specific).** `data-table`
(`plugins/primitives/plugins/data-table/web/internal/data-table.tsx`) renders the header
row and *each* body row as **independent flexbox rows** (`<div className="flex … gap-2">`).
Each column's size comes from a per-cell Tailwind `width` class. Flex rows resolve their
children's widths *independently*, so columns align **only if** the host gives every column
the exact right combination of `width` + `shrink-0` + `min-w-0`. Get any wrong — or omit
`width` entirely — and the header and body resolve different widths and silently misalign.

Sonata's `FieldDef[]` omitted widths on 3 of 4 columns and used a shrinkable `w-20` on the
4th, so every column drifts. The working consumers (Forge catalog, runtime profiling, facet
tables) only stay aligned because they each manually carry `flex-1 min-w-0` /
`w-N shrink-0` on *every* column. The flex model makes alignment a fragile host-discipline
concern.

**Decision (chosen with user): make alignment a structural invariant of the primitive** by
converting `data-table` to **CSS Grid + subgrid**. The grid defines the column tracks once;
the header and every body row are `grid-template-columns: subgrid` spanning all tracks, so
they share one column-width resolution. Alignment can no longer break regardless of content,
and the `shrink-0` / `min-w-0` footguns disappear. `width` becomes a single grid **track
size**; text alignment moves to its own field.

This is the "what primitive makes this and all future cases trivial" fix per the project's
coding philosophy, at the cost of a mechanical conversion of ~13 existing consumers.

## API change

`ColumnDef` (`plugins/primitives/plugins/data-table/web/internal/types.ts`) and `FieldDef`
(`plugins/primitives/plugins/data-view/core/internal/types.ts`):

```ts
/** CSS grid track size. Default "minmax(0,1fr)". e.g. "12rem" | "minmax(0,1fr)" | "auto". */
width?: string;
/** Text alignment within the column (header + cells). Default "start". */
align?: "start" | "end" | "center";
```

`width` semantics change from *"Tailwind class on the cell"* to *"grid track size"*.
`shrink-0` / `min-w-0` are no longer needed (the primitive owns `min-w-0`).
`text-right` / `text-center` move out of `width` into `align`.

## Implementation

### 1. `data-table` primitive — grid + subgrid rewrite

`plugins/primitives/plugins/data-table/web/internal/data-table.tsx`:

- Compute the track template from columns:
  `const template = columns.map((c) => c.width ?? "minmax(0,1fr)").join(" ");`
- Outer container: `grid gap-x-2` + `style={{ gridTemplateColumns: template }}` (dynamic
  template is the documented inline-style escape hatch; subgrids inherit the `gap-x-2`
  column gap automatically).
- Header row and each body row become full-span subgrids:
  `className="col-span-full grid grid-cols-subgrid …"` keeping their existing chrome
  (`sticky top-0 z-10 border-b bg-background p-control …` for the header;
  `items-center border-b border-border/30 p-control text-xs hover:bg-accent/30` for rows).
  Identical `p-control` on header and rows keeps the subgrid tracks mutually aligned.
- Each header `<span>` / body `<div>` cell drops the old `col.width` class and gains
  `min-w-0 truncate` (truncate already on body cells) plus an alignment class derived from
  `col.align`: `end → text-right`, `center → text-center`, else none.
- Keep `SortIcon`, sort handlers, `onRowClick` keyboard handling, and the empty-state
  early-return unchanged.

> If the installed Tailwind lacks the `grid-cols-subgrid` / `col-span-full` utilities, use
> the arbitrary-value fallback `[grid-template-columns:subgrid] [grid-column:1/-1]`. Verify
> during implementation.

`plugins/primitives/plugins/data-table/web/internal/types.ts`: update `width` doc, add
`align`.

### 2. `data-view` — carry `align`, retypon `width`

- `plugins/primitives/plugins/data-view/core/internal/types.ts`: update `FieldDef.width`
  doc (track size) and add `align?: "start" | "end" | "center"`.
- `plugins/primitives/plugins/data-view/plugins/table/web/components/table-view.tsx`
  (line 34–44 map): forward `align: f.align` alongside `width: f.width`.

### 3. Sonata library fields

`plugins/apps/plugins/sonata/plugins/library/web/components/song-library.tsx` (fields,
lines 96–135) — give each field a track size; right-align the numeric length:

| field    | width             | align |
|----------|-------------------|-------|
| title    | `minmax(0,2fr)`   | —     |
| composer | `minmax(0,1fr)`   | —     |
| duration | `5rem`            | `end` |
| added    | `7rem`            | —     |

### 4. Convert all other `data-table` consumers (mechanical)

Tailwind → track size: `w-8`→`2rem`, `w-12`→`3rem`, `w-14`→`3.5rem`, `w-20`→`5rem`,
`w-36`→`9rem`, `w-40`→`10rem`, `w-48`→`12rem`, `w-56`→`14rem`,
`flex-1 min-w-0`→`minmax(0,1fr)`, `min-w-[120px] max-w-[200px]`→`minmax(120px,200px)`.
Drop `shrink-0`. Move `text-right`→`align:"end"`, `text-center`→`align:"center"`.

Files (all column `width` strings found via `rg "width:"` over data-table importers):

- `plugins/apps/plugins/forge/plugins/catalog/web/components/categories/panes-table.tsx`
- `plugins/apps/plugins/forge/plugins/catalog/web/components/categories/routes-table.tsx`
- `plugins/apps/plugins/forge/plugins/catalog/web/components/categories/slots-table.tsx`
- `plugins/apps/plugins/forge/plugins/catalog/web/components/categories/contributions-table.tsx`
- `plugins/apps/plugins/forge/plugins/catalog/web/components/categories/resources-table.tsx` (`w-12 … text-center`→`3rem` + `align:"center"`)
- `plugins/apps/plugins/forge/plugins/catalog/plugins/tables/plugins/sample-rows/web/components/sample-rows-section.tsx` (`minmax(120px,200px)`)
- `plugins/apps/plugins/forge/plugins/catalog/plugins/tables/plugins/foreign-keys/web/components/foreign-keys-section.tsx`
- `plugins/apps/plugins/forge/plugins/catalog/plugins/tables/plugins/columns/web/components/columns-section.tsx`
- `plugins/apps/plugins/forge/plugins/catalog/plugins/tables/plugins/indexes/web/components/indexes-section.tsx`
- `plugins/debug/plugins/profiling/plugins/runtime/web/components/runtime-section.tsx` (4× `text-right`→`align:"end"`)
- `plugins/plugin-meta/plugins/facets/plugins/slots/plugins/render-catalog/web/slots-facet-table.tsx`
- `plugins/plugin-meta/plugins/facets/plugins/exports/plugins/render-catalog/web/exports-facet-table.tsx`
- `plugins/plugin-meta/plugins/facets/plugins/contributions/plugins/render-catalog/web/contributions-facet-table.tsx`

## Critical files

- `plugins/primitives/plugins/data-table/web/internal/data-table.tsx` — the rewrite
- `plugins/primitives/plugins/data-table/web/internal/types.ts` — API
- `plugins/primitives/plugins/data-view/core/internal/types.ts` — `FieldDef`
- `plugins/primitives/plugins/data-view/plugins/table/web/components/table-view.tsx` — mapper
- `plugins/apps/plugins/sonata/plugins/library/web/components/song-library.tsx` — Sonata fields
- + the 13 consumer files above

## Verification

1. `./equin build` (regenerates docs/registry; runs checks incl. eslint + boundaries).
2. Sonata table alignment — scripted Playwright, clicking into the table view:
   ```bash
   bun e2e/screenshot.mjs \
     --url http://att-1780672443-ygr0.localhost:9000/sonata \
     --click "Table" --out /tmp/sonata-table
   ```
   Confirm TITLE/COMPOSER/LENGTH/ADDED headers sit directly above their cell columns and
   LENGTH is right-aligned.
3. Regression check on existing consumers — screenshot a Forge catalog table (e.g.
   `/forge` → Slots/Contributions) and the Debug → runtime profiling table; confirm columns
   still align and right-aligned numeric columns are preserved.
