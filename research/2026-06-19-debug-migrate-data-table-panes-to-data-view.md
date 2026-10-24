# Migrate debug data-table panes to data-view

## Context

Three debug panes render flat domain-entity rows with the **lower-level `data-table`**
primitive directly, so they get sortable columns but **no search, no filter builder, and
no view switching** — unlike the rest of the app's data surfaces which use the higher-level
**`data-view`** multi-view primitive:

- `debug/slow-ops/pane` — `slow-ops-view.tsx` (Local tab, `SlowOp[]`, 6 columns, host-controlled sort).
- `debug/slow-ops/cluster` — `cluster-view.tsx` (Cluster tab, **two** tables: `ClusterAggregate[]` + `TimelineEntry[]`).
- `debug/profiling/runtime` — `runtime-section.tsx` (**three** tables HTTP/DB/Loader sharing one `AggRow` schema).

Migrating to `data-view` adds full-text search, typed filtering (by `operationKind` / `worktree` / `kind` enums),
and view switching for free, and unifies these panes with every other data surface. The three runtime tables
collapse into **one** data-view with a `kind` enum field, switchable via config-authored views.

`data-view` and `data-table` are load-bearing primitives — **consume only, do not modify**.

## Outcome

Four `<DataView>` surfaces replace six `<DataTable>` usages. Each gets the standard data-view
toolbar (search + filter builder + view switcher) and a config-authored default view.

---

## How data-view consumption works (confirmed)

A consumer must do exactly three things (everything else is automatic codegen):

1. Call `defineDataView("<id>")` in a `web/**` file of the consuming plugin (codegen scrapes it; the
   config descriptor is registered under that plugin's tree automatically — no server registration).
2. Author `config/<asPath(pluginId)>/<id>.jsonc` with `{ "views": [...] }`. The leading
   `// @hash 1befa300d09b` line is the hash of the origin's default `{"views":[]}` and is **constant for
   every data-view config** — copy it verbatim (or copy from the `.origin.jsonc` that `build` generates).
   The `data-view:configs-authored` check fails the build if the file is missing (presence-only check).
3. Render `<DataView rows fields rowKey storageKey ... />`.

Key props: `views` (whitelist of view-type ids), `defaultView`, `title`, `actions` (toolbar), `mode`
(`"surface"` = fills bounded flex parent + own scroll; `"embedded"` = natural height, host pane scrolls),
`emptyState`, `loading`, `selectedRowId`, `onRowActivate`. `FieldDef` types used here: `text`, `number`,
`enum` (with `options`), `date`. Enum cells render the raw value gracefully if not in `options`; `options`
may be a `useMemo` derived from rows. Each stacked DataView needs a **unique** `defineDataView` id.

Field design pattern per pane: split the old combined "operationKind operation" column into a dedicated
`enum` field (gives a filter chip) + a `text` primary field (keeps the monospace label + caller-breakdown
cell). Numeric `value()` keeps `Math.round(...)`; date fields use the `Date` as `value` and `<RelativeTime>`
as `cell`.

---

## Changes

### 1. slow-ops Local — `plugins/debug/plugins/slow-ops/plugins/pane/web/components/slow-ops-view.tsx`

- `const SLOW_OPS_LOCAL = defineDataView("debug.slow-ops.local")`.
- Fields (`FieldDef<SlowOp>[]`, in a `useMemo` so enum options derive from rows):
  - `operationKind` — `enum`, `value: r => r.operationKind`, `options` = unique kinds from rows, width `~7rem`.
  - `operation` — `text`, `primary: true`, `value: r => r.operation`, width `minmax(0,1fr)`, `cell` = current
    monospace label + `CallerBreakdownLines` (reuse existing local component).
  - `count` — `number`, end-aligned, `4rem`.
  - `totalMs` / `maxMs` / `lastMs` — `number`, `value: r => Math.round(...)`, labels "Total/Max/Last (ms)".
  - `lastSeen` — `date`, `value: r => r.lastSeenAt`, `cell: <RelativeTime date=... />`, `7rem`.
- Render `<DataView<SlowOp> rows={data} fields rowKey={r=>r.id} storageKey={SLOW_OPS_LOCAL}
  defaultView="table" loading=... emptyState="No slow operations recorded" />` (default `surface` mode — it's the
  whole tab). Drop the manual `sortState`/`toggleSort` (data-view owns sort via config + header clicks).
- Config `config/debug/slow-ops/pane/debug.slow-ops.local.jsonc`: one table view, `sort` totalMs desc.

### 2. slow-ops Cluster — `plugins/debug/plugins/slow-ops/plugins/cluster/web/components/cluster-view.tsx`

Keep the refresh button + failed-worktrees warning chrome. Replace the two `<DataTable>` with two
**`mode="embedded"`** DataViews (host pane scrolls), each with a `title`:

- `defineDataView("debug.slow-ops.cluster-aggregate")` — `FieldDef<ClusterAggregate>[]`:
  `operationKind` enum, `operation` text primary (cell: label + "slow across N worktrees"), `worktrees` number
  (`value: r => r.worktrees.length`), `count`/`totalMs`/`maxMs` numbers, `lastSeen` date. `title="Cluster Aggregate"`.
  Config: table view sort totalMs desc.
- `defineDataView("debug.slow-ops.cluster-timeline")` — `FieldDef<TimelineEntry>[]`:
  `atTime` date ("When"), `worktree` **enum** (derived options — strong filter), `operationKind` enum,
  `operation` text primary, `durationMs` number, `load` number (`value: r => r.loadAvg1`, keep severity-`Badge`
  cell, label "load1 / cpu"), `pgActiveBackends` number. `title="Contention Timeline"`.
  Config: table view sort atTime desc (preserve newest-first).
- Both config files under `config/debug/slow-ops/cluster/`.

### 3. profiling runtime — `plugins/debug/plugins/profiling/plugins/runtime/web/components/runtime-section.tsx`

Collapse the three `KindTable`s into **one** DataView.

- Extend the row to `RuntimeRow = AggRow & { kind: "http" | "db" | "loader" }`. Build by tagging each kind's
  `toAggRows(...)` output with its `kind` and concatenating (single array). Reuse the existing `CallerBreakdown`
  cell component.
- `defineDataView("debug.profiling.runtime")` — `FieldDef<RuntimeRow>[]`:
  - `kind` — `enum`, `options: [{value:"http",label:"HTTP"},{value:"db",label:"DB"},{value:"loader",label:"Loader"}]`,
    width `~5rem`.
  - `label` — `text`, `primary: true`, `value: r => r.label` (now searchable/sortable — an improvement over the
    old non-`value()` column), cell = current monospace label + `CallerBreakdown`.
  - `count` / `avgMs` / `maxMs` / `lastMs` — `number`, end-aligned.
- Render one `<DataView<RuntimeRow> mode="embedded" title={`Runtime (last ${windowSec}s)`} actions={<Reset/>}
  rowKey={r => `${r.kind}:${r.label}`} ... />`. Preserve the existing header window text + Reset mutation by
  passing them through `title`/`actions`.
- Config `config/debug/profiling/runtime/debug.profiling.runtime.jsonc` — **four** views preserving the
  three-table UX as switchable views plus an aggregate:
  - "All" — table, sort maxMs desc (default).
  - "HTTP" / "DB" / "Loaders" — table views each with a `filter` group `kind is <http|db|loader>`, sort maxMs desc.

---

## Files

- Modify: the three component files above (`slow-ops-view.tsx`, `cluster-view.tsx`, `runtime-section.tsx`).
  No barrel/slot/registration changes — the slot contributions stay identical (same components, same slots).
- Create: four `config/**.jsonc` files (paths above).
- Generated by `build` (do not hand-edit): `plugins/.../shared/data-views.generated.ts` updates,
  `.origin.jsonc` files.

## Verification

1. `./equin build` — regenerates `data-views.generated.ts`; `configs-authored` +
   `data-views-in-sync` checks pass once the four `.jsonc` files exist; `type-check` passes.
2. Screenshot + interact via `bun e2e/screenshot.mjs`:
   - Slow Ops pane (`/debug` → Slow Ops): Local tab table renders, search box filters, filter-by
     `operationKind` works, sort headers cycle. Cluster tab: Refresh, both Dataviews render + filter
     (timeline by `worktree`).
   - Profiling pane (Debug → Profiling): Runtime section is one table with a `kind` filter; switching
     to the HTTP/DB/Loaders views shows the filtered subsets; "All" shows everything.
3. Confirm enum filter chips list the live kinds/worktrees and that unknown values still render.

## Notes / tradeoffs

- **Two embedded DataViews stacked in the Cluster tab** is the sanctioned pattern (`mode="embedded"`,
  host scrolls). Each gets its own toolbar — slightly heavier chrome than the old bare tables, but that is
  the point (search/filter per dataset).
- **Runtime unification** changes the UX from three always-visible tables to one table with view switching.
  The default "All" view is new; the three per-kind views reproduce the old split on demand. This is the
  explicit goal in the task.
- The runtime `label` field gains `value()` (searchable/sortable) — a pure improvement; old column was
  display-only.
- Sort is no longer host-controlled in code; it lives in the per-view config + header clicks (data-view's model).
