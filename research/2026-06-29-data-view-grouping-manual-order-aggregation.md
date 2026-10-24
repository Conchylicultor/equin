# DataView primitive: group-by sections, flat manual-order, aggregating sections

> **Phase 2** of the conversations-sidebar → DataView migration
> (`research/2026-06-29-global-conversations-dataview-migration.md`). This plan is
> **primitive-only — zero conversation coupling.** Each capability is shipped as its
> own follow-up sub-task; this doc is the shared design they all execute against.

## Context

The conversation **queue** needs three display capabilities the DataView primitive
(`plugins/primitives/plugins/data-view/`) cannot express today, and all three are
generic, reusable Notion-class features — not queue hacks:

1. **Group-by sections** — partition a flat view's rows by a field value into ordered,
   collapsible sections with headers + counts (Notion's "Group by").
2. **Flat manual-order** — rank-based drag reordering on a flat list/table. Today only
   the **tree** view honors a fractional `Rank` + `onMove` (via `HierarchyConfig`); a
   flat list cannot be manually ordered without faking a hierarchy.
3. **Aggregating sections** — collapse N rows sharing a key into a single
   **representative row + count badge**, where acting on the representative acts on the
   whole group (the model for conversation task-groups).

Composed, the queue becomes `group-by(status) + manual-order(rank within section) +
aggregate(taskId)` — but every piece lands in `data-view` generically first.

### How the primitive works today (the seams we build on)

- **`ViewState`** (`core/internal/types.ts:195`) = `{ sort: SortRule[], query, filter:
  FilterGroup|null, expanded? }`. `sort`/`filter` persist in the per-instance **config
  row** (`view: { type, sort?, filter?, …opts }`); `query`/`expanded` are device-local
  (`useViewEphemeral`, localStorage).
- **Flat views** (`list`/`table`/`gallery`) each call **`useFlatRows`**
  (`web/internal/use-flat-rows.ts`) → search → filter → sort → flat `TRow[]`, then map.
  No section / group / header concept exists anywhere (grep confirmed zero matches).
- **Views are slot contributions**: `DataViewSlots.View` (`web/slots.ts`), each a
  `DataViewContribution extends ViewTypeMeta` keyed by `type`, receiving
  `DataViewRenderProps<unknown>` (`rows`, `fields`, `state`, `setSort`, `setFilter`,
  `hierarchy?`, `itemActions?`, …). The tree opts out of sort via `supportsSort:false`
  — the established **per-view capability-flag precedent**.
- **`HierarchyConfig<TRow>`** (`core/internal/types.ts:22`) = `{ getParentId, getRank,
  isExpanded?, onToggleExpanded?, onMove?, onCreate? }`. The tree projects rows through
  it and delegates DnD to the **`tree` primitive** (`plugins/primitives/plugins/tree/`),
  which uses raw `@dnd-kit/core` with three droppable zones (`before`/`after`/`child`)
  and computes the destination rank via **`computeDrop`** (`tree/core/internal/tree.ts:93`)
  → `{ parentId, rank }` using **`Rank.between`** (`plugins/primitives/plugins/rank/`).
- **Sort/Filter pills** follow a uniform **controller pattern**
  (`use-sort-controller.ts`, `use-filter-controller.ts`): read rules from
  `activeState`, write back via `updateView(patch, { merge: true })`.
- **Settings chrome today is fragmented**: the custom-columns `DataViewSettingsButton`
  (MdTune gear, toolbar position 7) is a `DataView-global` "Fields" popover; the
  per-instance `ViewSettingsPopover` (opened from the active view chip) holds
  `current-view` name/type-options driven by each view-type's `configSchema`.

## Decisions (confirmed with user)

- **Group-by UX = a contributable DataView settings menu, not a toolbar pill.** Build a
  single settings menu with **two scopes** — *DataView-global* and *current-view* — as a
  **contribution surface** (a slot). Group-by is a current-view setting inside it.
- **Manual-order DnD = extract & share the tree's rank-DnD.** Lift the flat
  before/after rank-DnD into a shared primitive and refactor the tree to reuse it — one
  reorder model, mirroring the proven precedent (not a second model via `sortable-list`).
- **Delivery = 3 sub-tasks, shared model first.** Land the shared section/row-entry
  pipeline model with group-by (Sub-task 1), then flat manual-order (Sub-task 2), then
  aggregating sections (Sub-task 3, reusing the model).

---

## Shared substrate (lands in Sub-task 1, reused by Sub-task 3)

The unifying abstraction every flat view renders against. Currently a view consumes a
flat `TRow[]`; group-by and aggregation both need a richer envelope, so we introduce
**one** model rather than bolting two ad-hoc shapes on.

New types in `core/internal/types.ts` (exported from the core + web barrels):

```ts
export interface DataViewSection<TRow> {
  key: string | null;          // group key; null = the implicit single section (no groupBy)
  label?: ReactNode;           // header label; absent for the implicit section
  count: number;               // member rows (pre-aggregation)
  entries: DataViewRowEntry<TRow>[];
}
export interface DataViewRowEntry<TRow> {
  row: TRow;                   // representative row (== the row when not aggregated)
  key: string;                 // rowKey(row)
  aggregateCount?: number;     // >1 when this entry stands for a collapsed group
  members?: readonly TRow[];   // collapsed members (aggregating only)
}
```

New hook `web/internal/use-data-view-sections.ts` (exported from web barrel):

```ts
export function useDataViewSections<TRow>(
  rows, fields, state, resolveOperatorSet, searchAccessor,
  opts?: { rowKey: (r, i) => string; aggregate?: AggregateConfig<TRow>; manualRank?: (r) => Rank },
): DataViewSection<TRow>[]
```

Pipeline (single `useMemo`): **`useFlatRows`** (search→filter→sort — *unchanged*) →
**group** by `state.groupBy` → **aggregate** within each section (Sub-task 3) →
return sections. When `state.groupBy` is unset and no aggregate: returns exactly one
section `{ key: null, count, entries: rows 1:1 }` — so `list`/`table`/`gallery`
rendering is **byte-for-byte identical to today** for the un-grouped case.

Each flat view is refactored from "map `useFlatRows`" to "map `useDataViewSections`":
render a header per non-null section (collapsible) and `section.entries.map(renderEntry)`.

---

## Sub-task 1 — Shared model + group-by sections + settings menu

**Goal:** rows partition into ordered, collapsible sections by a chosen field, selected
from a new contributable two-scope settings menu.

### State & pipeline
- Add **`groupBy?: string`** (a fieldId) to `ViewState`, persisted in the config row
  like `sort`/`filter` (host action `viewModel.setGroupBy(viewId, fieldId|null)` →
  `updateView({ groupBy }, { merge: true })`). Legacy rows without the key → ungrouped.
- Add **`FieldDef.groupable?: boolean`** — default **true for `enum`/`bool`**, false
  otherwise (mirrors `sortable` defaulting off `value`). Group-by picker lists groupable
  fields only.
- **Partitioning is generic in the host pipeline** (it also feeds aggregation): bucket by
  `field.value(row)`; **section order** = `field.options` order for `enum`
  (the status-enum case), else value sort; **section label** via the field's `cell`/value.
- Add **`supportsGroupBy?: boolean`** to `DataViewContribution` (default true; **tree
  sets false**), mirroring `supportsSort`. Host hides the group-by control on views that
  opt out.
- **Section collapse** = device-local in `useViewEphemeral` (new `collapsedSections`
  per-view set; absence = open). Reuse the **`collapsible`** primitive
  (`Collapsible`/`CollapsibleTrigger`/`CollapsibleChevron`, `useExpandAll`/
  `ExpandAllButton`) for the headers.

### Contributable settings menu (the chrome the user asked for)
- New slot **`DataViewSlots.Setting`** in `web/slots.ts` — a plain
  `defineSlot<DataViewSettingContribution>` where a contribution is
  `{ id, scope: "global" | "view", order?, component: ComponentType }`. (Plain
  `defineSlot`, not `defineRenderSlot`, so settings aren't force-reorderable; mirrors the
  `View` slot's data-contribution shape.)
- Host mounts a **`DataViewSettingsContext`** provider around the menu exposing what
  settings need without prop-threading: `{ storageKey, descriptor, fields, activeViewId,
  activeState, viewModel }`. Contributions read it via a hook.
- Replace the toolbar's `DataViewSettingsButton` (position 7, the MdTune gear) with a
  unified **`DataViewSettingsMenu`** `InlinePopover`: a `current-view` `SectionLabel`
  group + `DropdownMenuSeparator` + a `DataView` (global) group, each rendering its
  scope's `DataViewSlots.Setting` contributions (precedent: `SortBuilderPopover`'s
  two-section layout).
- **Group-by control** = a `view`-scope contribution (a field picker writing
  `viewModel.setGroupBy`). It reads groupable fields + active groupBy from the context.
- **Custom-columns "Fields"** renders in the `global` scope of the same menu. *Cycle
  note:* `data-view` (host) currently imports `custom-columns`, so `custom-columns`
  cannot import `DataViewSlots` (would cycle). Keep custom-columns as a host-rendered
  built-in inside the global scope for now (no new coupling — the host already names it);
  migrating it to a pure `Setting` contribution via dependency inversion (host stops
  importing custom-columns; it contributes its Fields UI + its `FieldDef`s through
  `fieldExtensions`) is a clean **follow-up**, out of scope here.

### View rendering
- `list`: each section = `<Collapsible>` header (`<SectionLabel>` + count + chevron) over
  the existing row stack; null-key section renders headerless (unchanged).
- `table`: interleave a full-width group-header row into the `DataTable` data stream
  (header row spanning all columns), collapse hides its members.
- `gallery`: partition cells per section; each = collapsible `<Grid>`.
- Keep virtualization: the `list`/`gallery` >threshold windowing still applies **within**
  a section's rows.

**Files:** `core/internal/types.ts`; `web/slots.ts`; `web/internal/use-data-view-sections.ts`,
`use-group-by-controller.ts`, `use-view-ephemeral.ts`, `use-data-view-model.ts`; new
`web/components/settings/{settings-menu.tsx,group-by-control.tsx}` + `DataViewSettingsContext`;
`web/components/data-view.tsx` (toolbar swap + context provider); `plugins/{list,table,gallery}/web/components/*-view.tsx`;
`plugins/tree/web/index.ts` (`supportsGroupBy:false`).

---

## Sub-task 2 — Flat manual-order

**Goal:** rank-based drag reordering on flat `list`/`table` views, sharing the tree's
proven rank-DnD machinery.

- **Rank math → `rank` primitive (core).** Add
  `computeFlatReorder(items: readonly {id,rank:Rank}[], draggedId, position: "before"|"after",
  targetId): Rank | null` (sort by rank, find target, `Rank.between(prev,target)` /
  `Rank.between(target,next)`, `null` on exhaustion). **Refactor `computeDrop`'s
  sibling branches** (`tree/core/internal/tree.ts`) to delegate to it — tree keeps only
  its `child`-zone/`parentId` logic. One source of rank-reorder arithmetic.
- **DnD wiring → new primitive `plugins/primitives/plugins/rank-reorder/` (web).** Lift
  the tree's flat before/after `@dnd-kit/core` wiring (`useDraggable` + two `useDroppable`
  zones + the `DndContext` + `onDragEnd` dispatcher with the self/no-op guards) into a
  reusable `<RankReorderProvider onMove>` + `useRankReorderItem(id)`. **Refactor the tree
  `TreeList`/`useTreeRow`** to consume it for its sibling zones (child zone stays tree-local),
  honoring the existing `keepMounted` + `MeasuringStrategy.Always` virtualization handling.
- **New `DataViewProps.manualOrder?: ManualOrderConfig<TRow>`** — the flat twin of
  `HierarchyConfig`, threaded into `DataViewRenderProps.manualOrder`:

  ```ts
  export interface ManualOrderConfig<TRow> {
    getRank: (row: TRow) => Rank;
    onMove: (id: string, dest: { rank: Rank; groupKey?: string | null }) => void | Promise<void>;
  }
  ```
- **Mode semantics:** when `manualOrder` is provided and supported, the view orders by
  `getRank` (the section pipeline skips the sort step, like the tree ignores sort) and
  shows drag affordances; the host hides the Sort control for that view. Add
  **`supportsManualOrder?: boolean`** to `DataViewContribution` (`list`/`table` opt in;
  gallery/tree N/A).
- **Composition with group-by:** manual order is **within a section**; a cross-section
  drag reports `onMove(id, { rank, groupKey: destSectionKey })` so a consumer can map the
  new group (e.g. status) to its own mutation. Reorder within the implicit null section
  when ungrouped.
- **Scope note:** manual order targets bounded lists (the queue) — when active, render
  non-virtualized within each section (drag + windowing across huge lists is out of scope).

**Files:** `rank/core/internal/*` (+ barrel); `tree/core/internal/tree.ts`,
`tree/web/internal/{tree-list.tsx,use-tree-row.tsx}`; new `plugins/primitives/plugins/rank-reorder/`;
`data-view/core/internal/types.ts`, `web/components/data-view.tsx`,
`plugins/{list,table}/web/components/*-view.tsx`.

---

## Sub-task 3 — Aggregating sections

**Goal:** collapse rows sharing a key into one representative row + count badge; acting on
the representative acts on the group.

- **New `DataViewProps.aggregate?: AggregateConfig<TRow>`**:

  ```ts
  export interface AggregateConfig<TRow> {
    getKey: (row: TRow) => string | null;             // null = standalone, never collapsed
    pickRepresentative?: (members: readonly TRow[]) => TRow;  // default: first in current order
  }
  ```
- **Extend `useDataViewSections`** with the aggregate step (runs **after** group, within
  each section): bucket entries by `getKey`, emit one `DataViewRowEntry` per non-null key
  with `row = pickRepresentative(members)`, `aggregateCount = members.length`,
  `members`. Null keys pass through 1:1. Representative keeps the first member's position.
- **Rendering:** each view shows the representative row normally; when
  `entry.aggregateCount! > 1` it renders a **count badge** (reuse the `Badge`/`LinkChip`
  primitive, `css/badge`) in its natural trailing spot — `list` trailing, `table` in the
  primary cell, `gallery` card corner.
- **"Acts on the group" stays consumer-side.** The representative is a real `TRow`, so
  `onRowActivate`, `itemActions`, and `manualOrder.onMove` already fire on it; the
  consumer's existing mutations (the queue's `reseatGroupMembers`) implement
  "move/act as one". The primitive only owns the **visual collapse + representative
  selection + count badge** — no server behavior.
- Composes with Sub-task 2: dragging an aggregated representative moves the whole group
  (consumer reseat). No new flag needed — aggregate is a pipeline transform, orthogonal to
  the `supports*` flags.

**Files:** `data-view/core/internal/types.ts`, `web/internal/use-data-view-sections.ts`,
`web/components/data-view.tsx`, `plugins/{list,table,gallery}/web/components/*-view.tsx`.

---

## Cross-cutting contract changes

- `DataViewContribution` gains `supportsGroupBy?` + `supportsManualOrder?` (both
  defaulting to the flat-view norm; tree opts out of group-by). Mirrors `supportsSort`.
- `DataViewRenderProps` gains `manualOrder?` and the views switch from consuming
  `useFlatRows` directly to `useDataViewSections` (the host still passes raw `rows`).
- `ViewState` gains `groupBy?`; the config-row `view` blob gains an optional `groupBy`
  key (host-injected like `sort`/`filter`, merge-written). Origin default stays `{ views: [] }`.
- Server-delegated path (`useServerDataSource`) is unaffected: grouping/aggregation run
  client-side over the returned rows; `effectiveState` still zeroes sort/filter/query.
  (Server-side group/aggregate pushdown is a later optimization, not in scope.)

## Critical files / reference points

- Types & state: `data-view/core/internal/types.ts` (`ViewState:195`, `FieldDef:120`,
  `HierarchyConfig:22`, `DataViewRenderProps`, `DataViewProps:404`)
- Host + toolbar: `data-view/web/components/data-view.tsx` (toolbar `277–327`), `web/slots.ts`
- Pipeline: `data-view/web/internal/use-flat-rows.ts`, `sort-rows.ts`, `evaluate-filter.ts`
- Controllers precedent: `web/internal/use-sort-controller.ts`, `use-filter-controller.ts`
- Settings precedent: `plugins/custom-columns/web/components/data-view-settings-button.tsx`,
  `plugins/view-core/web/components/view-settings-popover.tsx`, `sort/sort-builder-popover.tsx`
- Views: `plugins/{list,table,gallery,tree}/web/components/*-view.tsx`
- Rank DnD to extract: `plugins/primitives/plugins/tree/{core/internal/tree.ts:93,web/internal/tree-list.tsx,use-tree-row.tsx}`,
  `plugins/primitives/plugins/rank/`
- Reuse: `plugins/primitives/plugins/collapsible/`, `plugins/primitives/plugins/css/plugins/badge/`,
  `plugins/primitives/plugins/virtual-rows/`

## Verification (per sub-task; no conversation coupling)

Manual order targets a flat ranked list, so use an existing **flat** DataView consumer
with a rank field as the live test bed (e.g. an `apps/*` DataView), plus a co-located
`bun:test` for the pure pipeline.

- **Pipeline unit tests** (`bun test web/internal/use-data-view-sections.test.ts` —
  pure logic; and `computeFlatReorder` in `rank`): ungrouped → single null section
  identity; group-by enum → sections in `options` order with counts; aggregate → one
  representative + correct `aggregateCount`/`members`; `computeFlatReorder` before/after/
  exhaustion.
- **`./equin build`**, open `http://<worktree>.localhost:9000`, and drive an
  existing flat DataView via `e2e/screenshot.mjs`:
  - Sub-task 1: open the settings menu, pick a group-by field → rows partition into
    collapsible, counted sections; collapse persists across reload; non-groupable view
    (tree) hides the control; un-grouped view pixel-identical to before.
  - Sub-task 2: drag a row within a section → order changes, rank written to DB (verify
    with `query_db` against the consumer's rank table); cross-section drag fires
    `onMove` with the new `groupKey`; Sort control hidden while manual-order active; the
    **tree view still drags/reorders correctly** after the refactor.
  - Sub-task 3: rows sharing a key collapse to one representative + count badge; acting
    on the representative hits the representative row; expanding/regrouping recomputes.
- **`./equin check`** (boundaries, registry-in-sync, type-check, doc-in-sync) — the
  new `rank-reorder` primitive and slot must pass boundary + registry checks.

## Risks / notes

- **Tree DnD refactor (Sub-task 2)** touches the most-tested DnD surface. Mitigate:
  extract behavior-preservingly, keep the tree's `child` zone + virtualization handling
  exactly, and verify tree drag in the same pass.
- **Custom-columns cycle**: do **not** make `custom-columns` import `data-view` for the
  Setting slot in this phase (cycle). Keep it host-rendered in the global scope; full
  inversion is a follow-up.
- **Cross-section manual-order semantics** (group change on drop) is the subtlest seam —
  the primitive only *reports* the destination group via `onMove` dest; mapping it to a
  field mutation is the consumer's job (kept generic, no status knowledge in the primitive).
</content>
</invoke>
