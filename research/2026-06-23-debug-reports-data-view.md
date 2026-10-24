# Convert `/debug/reports` to a DataView

**Date:** 2026-06-23
**Category:** debug
**Status:** Ready to implement

## Context

The Debug → Reports page (`/debug/reports`) renders a flat, server-sorted (`lastSeenAt DESC`)
live list of every recorded report. Each row is a dense badge cluster (kind, source, noise,
rate-limited, tab/build attribution) + `×count` + relative time + a per-kind one-line summary
dispatched through the `Reports.KindView` slot. There is **no filtering, no sorting, no search**
— with many reports across kinds (crash / op-rate / queue-health / live-state-noop / slow-op), the
page is hard to triage.

Goal: render the list through the `data-view` primitive so it gains the standard
**filter pill, per-column sort, search, and switchable Table/List views** — *while preserving the
existing `Reports.KindView` per-kind dispatch* (each kind keeps its own summary renderer, untouched).

### Key fact that makes this clean

Reports are **uniform rows** (same 18 columns) with all per-kind variability confined to an opaque
`data` jsonb blob, already rendered by the `Reports.KindView.Dispatch` slot keyed on `report.kind`.
DataView's model is the same shape: one fixed `FieldDef[]` schema for all rows + a per-field
`cell(row)` escape hatch. So the per-kind summary becomes **one field whose `cell` delegates to the
existing slot** — no per-kind code enters the data-view layer, and the collection-consumer
separation is preserved. DataView does **not** support genuinely different column sets per row, but
reports don't need that: all cross-kind difference lives in the single summary cell.

## Approach

Rewrite **only** `plugins/debug/plugins/reports/web/components/reports-view.tsx` (the list body) to
mount `<DataView>`. The detail pane, routes, resource, and `Reports.KindView` slot are unchanged.
Add a `defineDataView` marker + an authored config providing the two default views.

### Files to modify / add

1. **`plugins/debug/plugins/reports/web/components/reports-view.tsx`** (rewrite the list)
   - Keep `useResource(reportsResource)` as the row source (live-state push, unchanged).
   - Replace the `<ul>`/`<ReportRow>` rendering with `<DataView<Report>>`.
   - Build `fields: FieldDef<Report>[]` (in `useMemo`, see schema below).
   - Props:
     - `rows={result.data}`, `rowKey={(r) => r.id}`
     - `storageKey={REPORTS_VIEW}` (the `defineDataView("debug.reports")` id)
     - `views={["table", "list"]}`, `defaultView="table"`
     - `loading={result.pending}`
     - `selectedRowId={selectedId}` (threaded from pane, as today)
     - `onRowActivate={(r) => onSelect(r.id)}` (preserves the push-detail-pane click)
     - `emptyState={<>No reports recorded yet.</>}`
   - Add module-level `const REPORTS_VIEW = defineDataView("debug.reports");`
     (must be in a `web/**` file so codegen scrapes it — this file qualifies).

2. **`config/debug/reports/debug.reports.jsonc`** (new) — author the two default named views so the
   page ships with Table (default, sorted newest-first) + List. Mirror
   `config/apps/sonata/library/sonata.library.jsonc` byte-for-shape:
   ```jsonc
   {
     "views": [
       { "name": "All",  "view": { "type": "table", "sort": { "fieldId": "lastSeen", "direction": "desc" } } },
       { "name": "Feed", "view": { "type": "list",  "sort": { "fieldId": "lastSeen", "direction": "desc" } } }
     ]
   }
   ```
   (`id`/`rank` are derived on read; the `@hash` header line is written by build/format — author
   without it and let tooling stamp it, matching precedent.)

### Field schema (`FieldDef<Report>[]`)

Each field reuses existing render logic; `cell(row)` receives the full row so it can return a
component that uses client hooks (e.g. tab/build attribution) — `cell` is a plain
`(row) => ReactNode`, so wrap hook-using markup in a small local component.

| id | label | type | value | cell / notes | sortable | filterable |
|----|-------|------|-------|--------------|----------|------------|
| `kind` | Kind | `enum` | `r.kind` | mono `<Badge variant="muted">`; `options` derived from `[...new Set(rows.map(r=>r.kind))]` (dynamic enum → is/is-not chip filter) | ✓ | ✓ |
| `source` | Source | `enum` | `r.source` | mono badge; `options` derived from distinct sources | ✓ | ✓ |
| `noise` | Noise | `bool` | `r.noise` | `noise` warning badge when true, else null | — | ✓ |
| `rateLimited` | Rate-limited | `bool` | `r.rateLimited` | destructive badge when true | — | ✓ |
| `count` | × | `int` | `r.count` | `×{count}` when `>1`, align end | ✓ | — |
| `lastSeen` | When | `date` | `r.lastSeenAt` | `<RelativeTime date={r.lastSeenAt} />` | ✓ | — |
| `context` | — | `text` | `""` | local `<AttributionBadges report={row}/>` rendering the "this tab" / "another tab" / "outdated tab" badges (uses `getTabId()` + `useStaleFrontend()` internally, exactly as `ReportRow` does today); `filterable:false`, not sortable | — | filter:false |
| `summary` | Summary | `text` | `r.message` | `cell: (row) => <Reports.KindView.Dispatch report={row} />`; `value` returns `r.message` so **search** matches the summary text; `primary: true` so List view uses it as the row label; not sortable | — | (default) |

Notes:
- `kind`/`source` as `enum` (vs `text`) gives a chip-select is/is-not filter — the primary triage
  axis. Options computed from the rows in the same `useMemo`.
- `noise`/`rateLimited` as `bool` fields surface in the filter builder automatically (a registered
  `fields.bool.filter` operator set exists). They render nothing in the cell when false.
- The `context` field carries the tab/build attribution badges that depend on client hooks; it is
  filter/search-excluded (`filterable:false`) and unsortable — purely presentational.
- `summary.value = r.message` keeps full-text search working against the human summary; the visible
  cell still routes through `Reports.KindView` so each kind renders richly.

### What stays untouched

- `plugins/reports/web/slots.ts` (`Reports.KindView`) and every contributor
  (`crash`, `op-rate`, `queue-dead-job`, `queue-backlog`, `live-state-noop`) — **zero changes**.
- `reportsResource` (core + server), routes, `reportsPane` / `reportDetailPane`, the detail body,
  and the Debug sidebar registration in `web/index.ts`.
- No server code: `defineDataView` + `./equin build` auto-registers the config descriptor via
  `buildViewConfigRegistrations` (driven by `data-views.generated.ts`). The consumer writes no
  server registration.

## Reuse / references

- Consumer pattern to mirror: `plugins/apps/plugins/sonata/plugins/library/web/components/song-library.tsx`
  (`defineDataView`, `FieldDef[]`, `<DataView>` props) + its config
  `config/apps/sonata/library/sonata.library.jsonc`.
- DataView API: `plugins/primitives/plugins/data-view/web` barrel — `DataView`, `defineDataView`,
  `FieldDef`. Required props: `rows`, `fields`, `rowKey`, `storageKey`. Filter/sort/search are
  automatic (no `state` prop) and persist to the authored config.
- Existing badges/logic to lift from `reports-view.tsx`: `Badge` variants, `RelativeTime`,
  `getTabId()`, `useStaleFrontend()`, `Reports.KindView.Dispatch`.
- `Report` type + `reportsResource`: `plugins/reports/core/resources.ts`.

## Risks / open points

- **List-view fidelity.** The `data-view/list` child renders field-driven label/subtitle/trailing;
  it won't be pixel-identical to today's hand-rolled badge cluster. Mitigation: `summary` is the
  `primary` (label) field; verify the List view looks acceptable and adjust which fields surface as
  subtitle/trailing if needed. Table is the default, so this is non-blocking.
- **Boundary check.** New imports are all legal barrels (`@plugins/primitives/plugins/data-view/web`,
  `@plugins/reports/web`, `@plugins/reports/core`). Run `./equin check plugin-boundaries`.

## Verification

1. `./equin build` (regenerates `data-views.generated.ts` from the new `defineDataView`,
   registers the config descriptor, runs checks).
2. `./equin check` — expect `plugins-doc-in-sync`, `plugin-boundaries`, `type-check`,
   `migrations-in-sync` green (no schema change, so migrations untouched).
3. Open `http://<worktree>.localhost:9000/debug/reports`:
   - Table view shows columns; click column headers / sort pill → reorders.
   - Filter pill: filter by `kind = crash`, toggle `noise`, confirm rows narrow.
   - Search box: type part of a summary message → matching rows only.
   - Toggle to List view → dense one-line rows; per-kind summaries still render via `Reports.KindView`.
   - Click a row → detail pane pushes (`reportDetailPane`), `selectedRowId` highlights it.
4. Scripted check with `e2e/screenshot.mjs` (click the view switcher / a filter) to capture
   before/after and confirm the toggle works:
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/debug/reports \
     --click "Filter" --out /tmp/reports-dataview
   ```
5. Confirm per-kind summaries match the old rendering for at least `crash` and `op-rate`
   (use `mcp__singularity__query_db` to find existing report kinds, or the live-state-emit /
   reports debug surfaces to seed one if the table is empty).
