# A bounded, paged tree over a live collection

Task: task-1793848084-uyf9yk (replaces task-1793840403-a5wg50; D2 of the "App
health progresses" wiki page). Background: `research/2026-11-05-tasks-bounded-task-rows.md`
(step 4). Next: task-1793840408-hau52q (`tasks` → a window) depends on this.
**Depends on task-1793848785-7tzicj** for the Tasks migration (below).

## Context

DataView refuses a live `source` together with a `hierarchy`
(`data-view/core/internal/types.ts:2032`, `hierarchy?: never` on
`DataViewLiveOrigin`; `data-view/CLAUDE.md:270`): a tree over a paged prefix
orphans children. So every tree surface holds its whole set in memory: the Tasks
tree (`useLive(taskRows)`, 6,817 tasks, 5.5 MB of every tab's 10 MB boot), the
Pages sidebar (`pagesTree`, `all`) and the tag trees. The file explorer is lazy per
folder, but by its own path (`lazyChildren` + `ListingReader`s).

Goal: a tree is metadata on a collection, every tree read is an ordinary bounded
`useLive` read, and DataView draws a live tree whose memory is the root window
plus one window per open node.

### Facts that shape the design (main, 2026-11-05)

| Fact | Value |
|---|---|
| Tasks: roots / total / parents | 4,118 / 6,817 / 1,247 |
| Depth | up to **24** (depth ≥ 5: 208 tasks) |
| Largest sibling set below the root | 71 |
| Open tasks / open roots | 493 / 109 |
| Index for a child window | `tasks_folder_rank_idx (folder_id, rank)` ✔ |
| The user's Tasks view (`~/.equin/config/singularity/tasks/task-list/tasks-list.jsonc`) | table, **groupBy category**, **filter status ∉ {done, dropped}** (scope `rows`), **sort updatedAt desc** |
| Task `status` / `active` / `finishedAt` / `dependencies` | derived through `childrenJoin` / `closureJoin` (`tasks-core/server/internal/task-rows.ts`). These CTE joins are `all`-only, and **A29** (`query-resource/server/internal/compile-alias.ts:447-453`) refuses a membership `where` / order over them |
| Status-filtered root page over `tasks_v` | 113 ms (the dependency-closure CTE over the whole table) |
| Pages: live pages / blocks | 179 / 12,266. Parent = `page_id`, rank = `doc_rank`, both real columns. `editedAt` is a **row-wise rollup** |

### The status wall is a dependency, not part of this task

A window over tasks can neither carry `status` nor filter or sort on it. The
user's Tasks view filters by status, so **the Tasks migration waits for
task-1793848785-7tzicj**. The user picks the fix there: a trigger-maintained
status column (`database/derived-tables` `defineRollup`), or aggregates on
windows. This plan does not solve it. It builds the primitive so that either fix
plugs in: `status` becomes one more filterable/sortable column of `taskTree`.

So the order changes from the brief: **primitive → Pages sidebar (unblocked) →
Tasks tree (after 7tzicj)**. Pages proves the primitive is generic. Tasks then
only declares `taskTree` and swaps its DataView.

## Design

### 1. Declaration: `tree` on a window collection (network/live core)

```ts
export const taskTree = liveCollection("tasks.tree", {
  ...taskRowFields,                       // the same field record taskRows uses
  id: "id",
  filterable: { folderId, title, status /* after 7tzicj */, … },
  sortable: ["rank", "createdAt", "updatedAt", "title"],
  default: { orderBy: [["rank", "asc"], ["createdAt", "asc"]], limit: 100 },
  maxLimit: 500,
  tree: { parent: "folderId", rank: "rank" },
});
```

- Only the **window** overload takes `tree`. An `all` or lookup-only collection has
  `tree?: never`. tsc enforces three rules:
  - `parent` is a filterable column whose row type is `Row[id] | null`;
  - `rank` is a `sortable` column;
  - the default order leads with `rank`.
- `LiveCollection` gains `tree: { parent; rank } | null`.
- **Rows of a tree collection carry `$childCount: number`**: the number of children
  in the collection, with its static `where` applied but not the view's filter.
  It sits on the wire beside `$columns` / `$key` and is typed `TreeRow<Row>`. A
  collapsed row uses it for its chevron, and `ChildCountAction` shows it.
- Every tree read is an ordinary query:
  - roots: `{ where: { folderId: { isEmpty: true } } }`;
  - children of X: `{ where: { folderId: X }, orderBy: [sort…, rank] }`, a
    normal paged window, so a level of 4,118 rows pages too.
- `taskRows` stays as it is (`all`, preloaded) until task-1793840408-hau52q,
  because 10 other readers still read the whole set. `taskTree` is a second
  declaration over the same field record, so step 5 is a key change, not a
  redesign.

### 2. `include: "ancestors"`: the one new read option

```ts
useLive(taskTree, { where, orderBy, include: "ancestors" }, { viewport })
// ready: { rows, ancestors, canGrow, loadMore, … }
useLive(taskTree, { id, include: "ancestors" })   // a node's path (deep link)
// ready: { row, ancestors }
```

- It is an option beside the query, not a kind key. On a collection without
  `tree` it is a **tsc error**, pinned in `use-live-query-types.test.ts`
  (`live:read-misuse-diagnostics`).
- `ancestors` is a separate part and never mixed into `rows`. It holds every
  ancestor of a row that is not itself in `rows`, deduped. Paging, `canGrow`,
  counts and groupings mean exactly what they mean without it.
- **Served as a sibling resource, with no change to the window wire.** A tree
  collection mints `<key>:ancestors`, a point read keyed by a set of seed ids. The
  seeds are the parents of a page's rows that the page does not hold. The read
  answers those rows plus their whole ancestor chain in one round trip, through a
  recursive CTE up `parent`. A client walk would instead take one round trip per
  level, up to 24 here.
  - It is built on `serveExternalWindow`, a window whose membership is an arbitrary
    `windowIdsOf` (`live/server/internal/serve-collection.ts:76`).
  - Membership is the closure, and the `parent` column is its `whereReads`.
  - A rename or status change of a member refills that row. A `parent` change of a
    member re-derives the closure, in O(depth × seeds).
  - The list is bounded by `cappedList` at `maxIds`. A cycle or a chain past
    `maxIds` throws loudly.
- `useLive` composes the pieces internally: per page, one `:ancestors` read of that
  page's seeds, unioned into `ancestors`. Page independence (D1) holds, and page 0
  of a plain read stays byte-identical to the default tuple (boot hydration).

### 3. Server: one substrate lift (network/live, query-resource)

**Row-wise `rollup` joins on windows.** Today rollups are `AllJoinSpec`. The
window compiler refuses them (C9/A24), even though they are row-wise and routed
through their sources (query-resource `CLAUDE.md`, "Rollup routes"). Lifting
`rollup` alone to windows (but not `childrenJoin` / `closureJoin`) unblocks:

- `$childCount`, as a **child-count rollup**. `defineTreeChildCount({ table, parent, where? })`
  (live/server, on `defineRollup`) declares `<table>_tree_children(parent_id, child_count)`
  in the owning plugin's schema. Its source is the table itself, carrying
  `parent`. The change feed already sends **old ∪ new** carried keys
  (`change-feed/CLAUDE.md`), so a move refills both parents through the
  existing `alias`-on-carry route. `serveCollection` on a tree collection
  requires it (tsc) and checks at bind that its parent column is `tree.parent`.
  A count costs one row-wise join, not a query per row.
- Pages' `editedAt`, which is a rollup already.
- Very likely 7tzicj's materialized status, if the user picks that fix.

A29 stays as it is: a window's membership never reads a CTE.

**Rejected (as agreed):** server-side flattening keyed by the client's open-node
set. Every expand changes the read's key, and it needs recursive windows.

### 4. DataView: a live source with `tree` (primitives/data-view, primitives/tree)

`liveDataSource(c, { surface, searchable, facets })` over a tree collection
gives a tree source. The live origin then accepts
**`hierarchy: LiveHierarchyConfig<TRow>` = `{ onMove?, onCreate?, getAliasParents? }`**.
`getParentId` / `getRank` are `never` there (they come from `collection.tree`),
and the prop is allowed only when the source's collection has a `tree` (tsc).

A new `web/internal/live-tree/` sits beside `live-source.tsx`. It uses the same
"readers report up" pattern as `live-sections.tsx` and the explorer's
`ListingReader`. It hands the nested table a synthetic `HierarchyConfig` and the
union of what it read.

| View state | Mode | Reads |
|---|---|---|
| no filter, no search, or filterScope `roots` | **expand** | root window `parent isEmpty ∧ scope (∧ filter when scope = roots)`, viewport-paged like any live source, plus one `ChildWindowReader` per open node (`parent = X`, grown by `limit`) |
| a filter (scope `rows`, the default) or a search | **hits** | one window `scope ∧ filter ∧ search`, viewport-paged, `include: "ancestors"`. Ancestors are drawn as context rows, which is today's `scopeFilterRows` "matches plus their ancestors" |

The semantics on a paged tree:

- **Expand and collapse** reuse `lazyChildren` in expand mode:
  - `hasChildren` is `$childCount > 0`;
  - `onOpenChange` drives which `ChildWindowReader`s are mounted;
  - collapsing unmounts the reader, which releases its subscription;
  - `state` comes from each reader's report.

  Memory is the root window plus one window per open node.
- **In hits mode a node shows only the hits and ancestors already loaded**,
  with no child windows. That matches scope `rows` today, where non-matching
  children are hidden. Its chevron is "has loaded children", not
  `$childCount`.
- **"Load more" works per level.**
  - `TreeChildrenState` gains `{ kind: "partial"; growing; loadMore; stalled? }`.
  - `childPlaceholder` (`tree/core/internal/flatten.ts`) gains a `more` line drawn
    after the loaded children.
  - The line is focusable: Enter loads (`treeKeyMove`).
  - Home and End mean "the loaded end".
- **Sort is sibling-scoped.**
  - It is lowered into every level's `orderBy` as `[sort…, rank]`.
  - Siblings are drawn in window order: while a sort is active, the tree's rank
    is the window position, so client collation never re-sorts the server's order.
  - In hits mode an ancestor-only row takes its own sort key among its siblings,
    so a later page can insert a context row above rows already shown. This is
    documented, not hidden.
- **A global sort is Sub-items: flat.** The existing `nesting` setting already
  means "draw this hierarchy flat". Over a live tree, `flat` is the ordinary flat
  live source, and `roots` is the same source scoped to `parent isEmpty`.
  - The flat **Parent** field becomes a `rowRead` (f96c62f46a's per-visible-row
    read, `{ id }` of the parent) instead of an in-memory `getParentId` lookup.
- **groupBy applies to top-level rows only.**
  - In expand mode it is lowered onto the root window through the existing
    `liveGroupLowering` (server sections, exact counts), and children follow
    their root.
  - In hits mode it groups the roots of the loaded forest in memory. Section
    counts read as lower bounds while paging, which is the existing `paging`
    contract.
- **Disabled on live trees**:
  - fold, which over a partial level would hide rows wrongly;
  - expand-all in expand mode, which would mount up to 1,247 windows. In hits
    mode expand-all opens only the loaded nodes.
- **Drag** keeps `onMove`'s positional intent (`targetId` + `zone`, no rank). The
  server mints against the complete sibling set with `rankAdjacentTo`, so a drop
  next to the last loaded sibling of a partial level is still exact.
  - *This argues against "drag computes a rank between loaded neighbours"*: the
    client never sees the complete sibling set, and `HierarchyConfig.onMove`
    already forbids a client-minted rank for that reason.
  - The optimistic overlay (`use-pending-move-overlay.ts`) is re-keyed on
    (parent, anchor). It pins the moved row into the destination level until that
    window holds it or the move fails, and hides it in the source level. Today it
    clears as soon as the row leaves its window, which would make a reparent
    flicker.
- **Deep link and reveal.**
  - A `selectedRowId` that is not loaded is read with `{ id, include: "ancestors" }`.
  - Its ancestors are expanded in the per-view expand map.
  - The path rows are pinned into their levels, drawn at their rank among the
    loaded siblings, before the level's "load more".
- **Aliases** (Pages' linked pages) stay consumer data (`getAliasParents`, from
  the whole `pageLinkSources` value it already reads). An open node's alias
  target that is not loaded is read by `{ ids }`.

### 5. Migration

1. **Pages sidebar** (`page-tree`), first because it is unblocked:
   - add `pagesTreeWindow` (`tree: { parent: "pageId", rank: "docRank" }`,
     `editedAt` via the rollup lift);
   - add a partial index `(page_id, doc_rank) WHERE type = 'page'`;
   - add a child-count rollup over `page_blocks WHERE type = 'page'`;
   - each sidebar section is its own view instance: Private / Scratch run in
     expand mode, and Favorites (a starred filter) in hits mode with ancestors;
   - `pagesTree` (`all`) stays for the `[[` pickers and recent pages. Bounding it
     is a follow-up. The sidebar is the genericity proof (179 pages), not a
     memory win.
2. **Tasks tree** (`task-list`), after 7tzicj:
   - declare `taskTree` and a `tasks_tree_children` rollup;
   - change `TasksListView` to `<DataView source={liveDataSource(taskTree, …)} hierarchy={{ onMove, onCreate }} …/>`;
   - `ChildCountAction` reads `row.$childCount` and drops its `useLive(taskRows)`;
   - the deps tree's `clusterTaskHierarchy` stays in memory over the cluster rows.
3. **Docs** to update:
   - data-view `CLAUDE.md` "Hierarchy" (live trees, modes, what is disabled);
   - network/live `CLAUDE.md` (`tree`, `include`, `$childCount`, `:ancestors`);
   - query-resource (rollups on windows).
4. Not migrated here: the tag trees and the file explorer, whose listings are not a
   DB collection. Both are filed as follow-ups.

## Critical files

- `plugins/network/plugins/live/core/internal/{live-collection,query,query-codec}.ts`
  (`tree`, `include`), `web/internal/{use-live,use-pages}.ts` (`ancestors` part)
- `plugins/network/plugins/live/server/internal/serve-collection.ts`
  (`:ancestors` via `serveExternalWindow`, child-count binding);
  `plugins/query-resource/server/internal/{compile-window,joins}.ts`,
  `core/internal/all-joins.ts` (rollups on windows)
- `plugins/database/plugins/derived-tables` (`defineRollup`, reused) and
  `live/server` `defineTreeChildCount`
- `plugins/primitives/plugins/data-view/core/internal/types.ts` (live origin
  `hierarchy`), `web/internal/live-tree/*` (new),
  `web/components/data-view-body.tsx`, `web/internal/use-pending-move-overlay.ts`,
  `plugins/table/web/components/nested-table-view.tsx`
- `plugins/primitives/plugins/tree/core/{types.ts,internal/flatten.ts}`,
  `web/internal/{tree-child-placeholder.tsx,use-lazy-load-requests.ts}`
- Pages: `plugins/page/plugins/editor/{core/resources.ts,server/internal/{page-rows,tables}.ts}`,
  `plugins/apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx`
- Tasks: `plugins/tasks/plugins/tasks-core/{core/resources.ts,server/internal/tables.ts}`,
  `plugins/tasks/plugins/task-list/web/{components/tasks-list-view.tsx,components/child-count-action.tsx,internal/tasks-data-view.tsx}`

Reused rather than rebuilt:

- `lazyChildren` + `useLazyLoadRequests`
- the `live-sections.tsx` reader pattern
- `liveGroupLowering`, `useLivePagesPaging`, `SectionPagingFooter`
- `rankAdjacentTo`
- rollups and their source routes, the change feed's old ∪ new carry
- `serveExternalWindow`
- `rowRead`

## Measurement: what will and will not move

- **This task does not shrink the boot snapshot by itself.** `taskRows` stays
  `all` + `preload: "boot"` for its 10 remaining whole-set readers (graph, deps
  tree, dependency card, draft popover, sidequest list, …). Those move in steps
  2, 3 and 5 (task-1793840390-rrreub, task-1793840397-nanvnj,
  task-1793840408-hau52q).
- Measured before and after:
  - `benchmark_boot` `snapshotBytes.perKey` (`tasks`, `tasks.tree`, `pages.tree`);
  - `./equin run plugins/network/plugins/live/e2e/replay-bytes.ts --path <tasks pane>`
    (the `tasks` share);
  - the Tasks pane's and Pages sidebar's own reads: bytes and rows with the
    default view, after expanding a node, and after a search.
- Expected: with the user's view, the Tasks pane holds about 600 rows (493 hits
  plus ancestors, paged by 100) instead of 6,817. The boot drops by about 5.5 MB
  once step 5 lands.

## Verification

- Unit tests (bun:test):
  - the tree spec's typing (`parent` key type, `rank` sortable, `include` on a
    non-tree collection), with `@ts-expect-error` cases;
  - the `:ancestors` closure (depth 24, cycle throws, a `parent` change re-derives);
  - the child-count rollup (create, delete, and a move between parents refills both);
  - rollups on a window, with the `all` compiler as oracle (the `tree-oracle.test.ts`
    precedent).
- jsdom tests (vitest, `data-view/plugins/table/web/__tests__/`):
  - expanding opens a child read and collapsing releases it;
  - load more per level, with the keyboard;
  - hits mode with ancestors;
  - sibling sort order;
  - groupBy over roots;
  - deep-link reveal;
  - a reparent's optimistic pin.
- Driving the app:
  - Pages sidebar: identical to main (screenshot), then expand, drag, Favorites;
  - Tasks pane (after 7tzicj): renders the same open tasks as main, plus expand,
    load more, search and drag between parents.
- `./equin check`, `./equin test` on the touched plugins, `./equin build`.

## Risks and open points

- The tasks migration's timing depends on 7tzicj. If it picks "aggregates on
  windows" rather than a status column, A29 must gain a documented exception
  for membership aggregates. That is 7tzicj's call.
- `docRank` is per `page_id` group and re-minted by the writer. Window order must
  stay stable under re-mints, which are in-place refills today.
- In hits mode an ancestor's position can shift as later pages load (above).

## Results (2026-11-05)

Landed in two pushes: the primitive (fd218c5847), then the Pages sidebar and
the Tasks tree. Deviations from the plan above, all toward one mechanism:

- `$childCount` is an instance of task-1793848785-7tzicj's materialized
  aggregates (`materializeJoin` of a self-referencing `childrenJoin`), bound
  by `serveCollection(c, { childCount: { of, count } })` — not a separate
  rollup lift. Pages' `editedAt` became one too.
- The Tasks tree is `taskWindow` itself (key `tasks.tree`, was the flat
  `tasks.window`); `pagesTree` became the window tree (key `pages.tree.v2`) and
  every Pages reader moved to bounded reads (breadcrumb / delete via
  `{ id, include: "ancestors" }`, Recent and the `[[` pickers via windows —
  the pickers keep their previous rows while typing: `useLive(c, q, { resetKey })`).
- Aliases are asked from the parent (`getAliasChildren(parentId)`).
- The flat Parent field reads the parent per visible row (`rowRead` collection form).

Measured, Tasks pane open, one tab, restart replay
(`replay-bytes.ts --tabs 1 --path /agents/tasks`):

| | main (before) | this branch (after) |
|---|---|---|
| whole replay | 6.04 M chars, 161 frames | 0.27 M chars, 19 frames |
| task rows | `tasks` 5.70 M | `tasks.tree` 0.10 M + `tasks.tree:ancestors` 0.10 M |

Boot snapshot (main, warm): 10.33 MB raw / 1.36 MB gzip, `tasks` 5.59 MB /
606 KB — unchanged by this task: `taskRows` is still `preload: "boot"` for its
remaining whole-set readers; dropping it is task-1793840408-hau52q (−5.6 MB).
