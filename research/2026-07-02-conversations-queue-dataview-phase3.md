# Phase 3 — Conversation **Queue** tab as a DataView

> Detailed sub-plan for Phase 3 of the sidebar → DataView migration
> (`research/2026-06-29-global-conversations-dataview-migration.md`). **Scope
> narrowed by the user: migrate only the Queue tab now. Grouped is deferred
> (stays classic-only); History was already migrated in Phase 1.**

## Context

The conversations sidebar has a `classic` variant (bespoke `defineTabbedView` with
Queue / Grouped / History tabs) and a `dataview` variant, switchable via the
`sidebar-region` variant-region (Phase 0). The `dataview` variant currently holds
**only** a History list rendered through the official DataView primitive (Phase 1).
Phase 2 added three generic DataView capabilities — **group-by sections**, **flat
manual-order**, **aggregating sections** — which are fully implemented, unit-tested,
and **have zero production consumers today**.

Phase 3 makes the Queue tab the **first consumer** of those primitives: it rebuilds
the Queue *presentation* on `<DataView>` while reusing the queue's existing data +
mutation layer **unchanged** (the "duplicate presentation, not data" principle). The
whole-group move (`reseatGroupMembers`) and blocked-dependent cascade
(`cascadeBlockedDependents`) already live **inside** the `reorderQueue` server
handler, so the new view's `onMove` just POSTs — no data-layer work.

Adding Queue alongside History forces the `dataview` variant to grow a **tab
switcher** (Queue + History). The DataView's own multi-view switcher is orthogonal —
it swaps *presentation* (list/table/…) of **one** instance (one `rows`/`dataSource`,
one field schema); Queue and History are genuinely different instances (Queue =
live-state `rows` + manual-order/aggregate/pin; History = server-query `dataSource`).
So the tab switch reuses the existing `defineTabbedView` primitive (the same one
`classic` uses), not hand-rolled chrome.

**Intended outcome:** flip the sidebar picker to `dataview` and get a Queue tab at
behavioral parity with classic — status sections, manual rank ordering, task-group
aggregation, and a pinned "current" section — plus the existing History tab, with the
classic variant one click away as the trusted fallback.

## Design decisions (fixed)

- **Pin → its own leading section** (a `current` group-by bucket via the synthetic
  section field), not a sticky elevated row.
- **Queue stays on live-state `rows`** (bounded active set), never server-query.
- **Section is a GROUP-LEVEL classification**: every conversation sharing a `taskId`
  gets the same `section`, so `aggregate(taskId)` collapses the group within one
  section (never split across two).
- **Grouped deferred** — the `dataview` variant hosts Queue + History only; users
  needing Grouped toggle back to `classic`.
- **Code layout: umbrella + per-tab sub-plugins.** `data-view/` becomes the umbrella
  owning a `defineTabbedView` host + the region-variant registration; History moves
  into `data-view/plugins/history/`, Queue is new in `data-view/plugins/queue/`.

## Two generic primitive changes (in `data-view` + `rank-reorder`)

Both are real, reusable capabilities — not conversation hacks — and, because
`manualOrder` has no production consumer yet, they touch only the primitive + its
unit tests.

### P1 — Nullable manual-order rank ("some rows aren't orderable")

Today `ManualOrderConfig.getRank: (row) => Rank` is non-nullable, and turning on
`manualOrder` makes **every** rendered row a drag source + drop target. The Queue
needs only the `current` + `queued` sections draggable (Working/Unranked/
Disconnected/Done must not drag; Unranked/Disconnected/Done have no queue rank at
all). Make `getRank` return `Rank | null`, where `null` ⇒ the row is not a drag
source, not a drop target, and keeps incoming order.

- `plugins/primitives/plugins/data-view/core/internal/types.ts` — `ManualOrderConfig.getRank: (row) => Rank | null` (doc the null contract). `HierarchyConfig.getRank` stays non-null (tree unaffected).
- `plugins/primitives/plugins/data-view/web/internal/use-data-view-sections.ts` — `opts.manualRank?: (row) => Rank | null`; make the within-section comparator null-safe: `const ra = manualRank(a.row), rb = manualRank(b.row); if (ra == null || rb == null) return 0; return Rank.compare(ra, rb);`. Sections are **homogeneous** (all-ranked or all-null — the row-assembly hook guarantees it), so a `0` comparator on a null section is a stable no-op = "keep incoming order." Document that invariant.
- `plugins/primitives/plugins/data-view/plugins/list/web/components/list-view.tsx` — in the manual-order branch, render `getRank(entry.row) != null ? <ManualOrderRow…> : renderRow(…)` (element-type choice, not a conditional hook — the `useRankReorderItem` hook lives inside `ManualOrderRow`); `.filter(e => getRank(e.row) != null)` before building `manualOrderItems`.
- `plugins/primitives/plugins/data-view/plugins/table/web/components/table-view.tsx` — same null treatment in `useRowDecoration` (return `undefined` when rank is null) + filter `manualOrderItems`, so the capability is uniform across both `supportsManualOrder` views (queue only uses `list`, but keep them coherent in one PR).

### P2 — Surface the drop neighbor in `onMove` (rank-based ⇄ endpoint-based)

The rank-reorder primitive computes `{ targetId, zone, rank, group }` internally but
forwards only `{ rank, groupKey }`. The queue's `reorderQueue` endpoint (and its
optimistic `applyReorder`) are **neighbor-based** (`{ conversationId, targetId, zone }`).
Reconstructing targetId/zone from a bare rank in the consumer would re-derive exactly
what the provider discarded. Surface the neighbor coordinates alongside `rank`:

- `plugins/primitives/plugins/rank-reorder/web/internal/rank-reorder-provider.tsx` — `onMove(draggedId, { rank, group, targetId, zone })` (both already in scope in `onDragEnd`).
- `plugins/primitives/plugins/data-view/core/internal/types.ts` — `ManualOrderConfig.onMove` dest gains optional `targetId?: string; zone?: "before" | "after"`.
- `list-view.tsx` + `table-view.tsx` — forward `targetId`/`zone` through to `manualOrder.onMove`.

Rank-based consumers keep ignoring the new fields; endpoint-based consumers (the
queue) use them and ignore `rank`.

## Plugin restructure (umbrella + per-tab)

`plugins/conversations/plugins/conversations-view/plugins/data-view/`:

- **`web/host.ts`** (new) — `export const SidebarDataView = defineTabbedView<ConversationSidebarProps>("conversations-sidebar-dataview")` (`ViewProps = ConversationSidebarProps`; `{ View, Host }`). Mirrors `ConversationsView` in `conversations-view/web/slots.ts`.
- **`web/index.ts`** — register **one** `SidebarRegion.Variant({ id: "dataview", label: "DataView", match: "dataview", component: (p) => <SidebarDataView.Host {...p} className="h-full" /> })` (the `classic-body.tsx` pattern); export `SidebarDataView` for sub-plugins to contribute into.
- **`plugins/history/web/**`** (moved) — relocate `sidebar-history.tsx` here; `web/index.ts` contributes `SidebarDataView.View({ id: "history", title: "History", order: 10, component: SidebarDataViewBody })` and keeps `HistoryItemActions({ id: "close", … })`. Moving the `defineDataView("conversations-sidebar-history")` marker changes the codegen `pluginId` → the config file path moves; `git mv` the committed `config/conversations/conversations-view/data-view/conversations-sidebar-history.jsonc` (+ `.origin.jsonc`) to the new derived path (`…/data-view/history/…`) and re-run `./equin build`.
- **`plugins/queue/web/**`** (new) — the Queue DataView (below). `web/index.ts` contributes `SidebarDataView.View({ id: "queue", title: "Queue", icon: MdLowPriority, order: 5, component: SidebarQueueBody })` + its item-action contributions.

Sub-plugin → umbrella (`@plugins/…/data-view/web`) is the legal parent-ward edge
(same shape as `classic → conversations-view`). The bespoke
`conversations-view/plugins/queue` (classic tab) is untouched.

## The Queue DataView (`data-view/plugins/queue`)

### Row assembly

Single-source the domain classification by **hoisting** the `useMemo` body of
`queue/web/components/queue-view.tsx` (taskId grouping, working/waiting split, pin,
unranked/disconnected/gone) into a pure exported `classifyQueue(active, gone, queue,
tasks)` in **`queue/web`** (public barrel — `shared/` can't be imported cross-plugin).
Both the bespoke view and the new sub-plugin import it, so the two can't drift.

A `useQueueRows()` hook in the new plugin combines the public resources
`conversationsActiveResource`, `conversationsGoneResource`, `tasksResource`
(`@plugins/tasks/plugins/tasks-core/core`) + `queueRanksResource` (`queue/shared`) via
`useCombinedResources`, gates on `pending`, runs `classifyQueue`, and emits **one flat
`QueueRow` per conversation**:

```
type QueueRow = Conversation & {
  section: "current" | "queued" | "working" | "unranked" | "disconnected" | "done";
  rank: Rank | null;        // set ONLY for current + queued; null elsewhere ⇒ non-draggable (P1)
  taskId: string | null;
  isTop; isBottom; canStepDown; isBlocked; memberCount;   // group-level flags, set on EVERY member
};
```

Emit order (null-rank sections keep incoming order, so order is the display order):
`current`, `queued` (rank asc), `working` (rank asc), `unranked`, `disconnected`,
`done` (endedAt desc). **Within each task-group, emit the representative member first**
(working/starting member ?? most-recent-by-createdAt) — this makes the aggregate
entry's `key` equal the representative id, so selection highlight matches classic
(see caveat resolution below). Returns `{ rows, pinnedConversationId }`.

### Fields + default group-by

`queueFields: FieldDef<QueueRow>[]` = the conversation display fields **plus** a
synthetic **section** field, everything else `groupable: false`:

```
{ id: "section", type: "enum", value: (r) => r.section, groupable: true,
  options: [ {value:"current",label:"Current"}, {value:"queued",label:"Queue"},
             {value:"working",label:"Working"}, {value:"unranked",label:"Unranked"},
             {value:"disconnected",label:"Disconnected"}, {value:"done",label:"Done"} ] }
```

`partitionIntoSections` orders enum sections by `options` order — giving the exact
section sequence. Marking only `section` groupable limits the gear's group-by picker
to `section` + `None` (there is no per-surface *lock* today; full locking would need a
new generic flag — deferred, noted below).

**Default group-by via authored config (zero code)** — `readGroupBy` reads
`view.groupBy` off the config row. Author
`config/conversations/conversations-view/data-view/queue/conversations-sidebar-queue.jsonc`:

```jsonc
{ "views": [ { "name": "Queue", "view": { "type": "list", "groupBy": "section" } } ] }
```

(`./equin build` writes the `// @hash` + `.origin.jsonc`; the
`data-view:configs-authored` check requires the file to exist.)

### `<DataView>` wiring (`SidebarQueueBody`)

Mirrors `SidebarDataViewBody` (History): wrap in `<Scroll axis="y" fill>` (the region
is in a `Column scrollBody={false}`), `storageKey={defineDataView("conversations-sidebar-queue")}`,
`views={["list"]}`, `rows={rows}`, `fields={queueFields}`, `rowKey={(c)=>c.id}`,
`selectedRowId={activeId}`, `onRowActivate={(r)=>onNavigate(r.id)}`,
`viewOptions={{ list: { renderRow: (c) => <ConversationItem conv={c} layout="block" /> } }}`,
`itemActions={QueueItemActions}`, plus:

- **`aggregate`** — `{ getKey: (r) => r.taskId, pickRepresentative: (m) => m.find(x => x.status==="working"||x.status==="starting") ?? m.reduce(mostRecentByCreatedAt) }`. Collapses task-groups to one representative + `×N` badge, within the group's single section.
- **`manualOrder`** — `getRank: (r) => r.rank` (null ⇒ non-draggable, P1); `onMove: (id, dest) => { if (!dest.targetId || !dest.zone) return; queueResult.dispatch({ conversationId: id, targetId: dest.targetId, zone: dest.zone }); }`.
- **`queueResult`** = `useOptimisticResource<QueueData, ReorderVars>({ resource: queueRanksResource, apply: applyReorder, mutate: (v) => fetchEndpoint(reorderQueue, {}, { body: v }) })` — reused verbatim from the bespoke view. `id`/`targetId` are group members; `applyReorder` (client) + `reseatGroupMembers` (server) both resolve a conversationId to its whole task-group, so passing any member moves the group as one.

The list view's `supportsManualOrder: true` auto-hides the Sort pill; manual-order
renders non-virtualized (fine for a bounded active set).

### Item actions

`QueueItemActions = defineItemActions<QueueRow>("conversations-sidebar-queue-actions")`,
one component per action (each reads `row` flags, returns `null` when N/A — components
get only `{ row, hasChildren }`):

- **Promote** (`promoteQueue`) — `section==="queued" && !isTop`.
- **Step down 5** (`stepDownQueue`, `steps:5`) — `canStepDown`.
- **Demote** (`demoteQueue`) — `!isBottom`.
- **Add to queue** (`rerankQueue`) — `section==="unranked"`.
- **Close** — all except `done`, via a module-scoped `CloseConversationContext`
  provided by `SidebarQueueBody` (the Phase-1 `CloseConvAction` pattern). Promote/
  step-down/demote/rerank call `fetchEndpoint(...)` directly, as classic does.

## Known divergences / caveats

1. **Group-by not lockable** — a user could pick `None` in the gear and ungroup the
   queue. Mitigated to `section`-or-`None` by field `groupable` flags; a hard lock
   needs a new generic `DataViewProps` flag — **deferred**.
2. **Selection highlight** — resolved by emitting the representative first (its id
   becomes the entry key), so `selectedRowId === activeId` highlights the group the
   same as classic (`onRowActivate` navigates to the representative → `activeId`
   becomes the representative id).
3. **Cross-section drag (Queue ⇄ Current)** reorders rank but does **not** change pin
   membership (pin is `promote`/`demote` state, its own concern) — consistent with the
   pinned-section design; verify it feels right in-app.
4. **Aggregate badge** renders as a muted `×N` (vs classic's `destructive` cluster
   count) — acceptable presentation drift; overridable via `renderRow` if desired.
5. **Done section** shows recent gone (from `conversationsGoneResource`); infinite
   pagination of Done is out of scope — the History tab covers full history.

## Critical files

- Primitive: `plugins/primitives/plugins/data-view/core/internal/types.ts`, `…/web/internal/use-data-view-sections.ts`, `…/plugins/list/web/components/list-view.tsx`, `…/plugins/table/web/components/table-view.tsx`, `plugins/primitives/plugins/rank-reorder/web/internal/rank-reorder-provider.tsx`
- Precedent to mirror: `…/conversations-view/plugins/data-view/web/components/sidebar-history.tsx`, `…/plugins/classic/web/components/classic-body.tsx`, `…/conversations-view/web/slots.ts`
- Queue data layer (reuse via barrels): `…/plugins/queue/shared/index.ts` (`queueRanksResource`, `reorderQueue`/`promoteQueue`/`demoteQueue`/`stepDownQueue`/`rerankQueue`, `QueueData`), `…/plugins/queue/web/index.ts` (`applyReorder`, `ReorderVars`), `…/plugins/queue/web/components/queue-view.tsx` (hoist `classifyQueue`)
- New: `…/plugins/data-view/web/host.ts`, `…/plugins/data-view/plugins/queue/web/**`, moved `…/plugins/data-view/plugins/history/web/**`, `config/conversations/conversations-view/data-view/queue/conversations-sidebar-queue.jsonc`

## Verification

1. `./equin build` (regenerates registry, data-view codegen, migrations; runs the `data-view:configs-authored` + `plugins-*-in-sync` checks). Open `http://<worktree>.localhost:9000`.
2. In the sidebar picker, flip **classic → dataview**. Confirm a **Queue** tab appears next to History, with sections in order (Current, Queue, Working, Unranked, Disconnected, Done), task-groups collapsed to one row + `×N`, and the pinned conversation in **Current**.
3. Drive with `e2e/screenshot.mjs`: drag a Queue row before/after another (capture before/after), click promote / step-down / demote / add-to-queue, close a conversation. Confirm each mutates and the list reconciles.
4. **Same-DB parity**: with both variants against the same worktree DB, toggle classic ↔ dataview and confirm identical data + that mutations from either write identical rows — `query_db` on `conversations_ext_queue` (ranks; whole task-group shares one rank after a drag) and `queue_state` (pin). A drag on a task-group member should reseat every sibling to the same rank in both variants.
5. Confirm the Sort pill is hidden on Queue (manual-order active) and the group-by gear offers only `section` / `None`.
6. Regression: History tab still works after the sub-plugin move; classic variant unchanged.
