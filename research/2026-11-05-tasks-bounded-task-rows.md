# `tasks` is a whole-set value — who needs the whole set, and how to bound it

Task: task-1793838170-tunpfz (follow-up of task-1793834899-2j3mfj, the per-socket
sub-ack dedupe).

## Problem

`taskRows` (`plugins/tasks/plugins/tasks-core/core/resources.ts`, key `tasks`)
is declared `all: { unbounded }` with `preload: "boot"`. Every page boot
hydrates the whole set, and after a server restart every live socket's replay
reloads it whole. It is O(every task), not O(window ∪ changed), which is what
CLAUDE.md requires of a DB-backed collection.

## Measured (main, 2026-11-05)

| What | Value |
|---|---|
| `GET /api/resources/boot-snapshot` | **10.03 MB** |
| — `tasks` | **5.55 MB** (55 %) |
| — `attempts` (same shape of problem) | 3.44 MB (34 %) |
| — everything else | 1.04 MB (icons.sprites 268 KB, task-categories 243 KB, notifications 200 KB, …) |
| `tasks` rows | 6,778, at 818 B per row |
| — `$columns` (7 base exposures, mostly default nulls) | 45 % of the bytes |
| — `title` | 8 % |
| Status | done 4,770 · dropped 1,526 · **open 482** (new 317, attempted 63, blocked 52, need_action 26, held 12, in_progress 12) |
| Open tasks plus their folder ancestors | 723 rows, ~0.4 MB of the open rows |
| Roots (`folder_id IS NULL`) | 4,106 (open: 106) |
| Clusters (`coalesce(cluster_id, id)`) | largest 137 tasks; 3,405 tasks never unioned (`cluster_id` NULL) |

So 93 % of what every tab holds is settled history, and almost half of every row
is exposure padding. A restart's replay is the same 5.55 MB per shared socket
(`network/live/e2e/replay-bytes.ts`, task-1793834899-2j3mfj: tasks 5.52 M chars
of the 6.01 M a 3-tab replay carries).

### The cluster invariant

`tasks.cluster_id` is the monotone union-find label
(`server/internal/mutations/clusters.ts`): creating under a folder, moving under
a folder and adding a dependency each union the two clusters. Measured on main:

| Edge kind | Edges that cross a cluster |
|---|---|
| `task_dependencies` (`task_id → depends_on_task_id`) | 0 |
| `folder_id` | 0 |
| `group_id` (2,225 set) | 0 |

**Every edge the tree, the graph and the dependency surfaces walk stays inside
one cluster.** A task's dependency closure, its dependents, its folder subtree
and its group are all subsets of its cluster. Caveat: `group_id` is not itself a
union point — it holds because every `relate` that sets it also adds a
dependency edge (`handle-create-chain.ts`, `handle-insert-between.ts`). Step 2
makes it one.

## Who reads `taskRows`, and what each really needs

| Reader | Reads | Truly needs | Bounded form |
|---|---|---|---|
| `active-data/task-link` chip + `useTaskReferent` | `find(id)` | one row | `useLive(taskRows, { id })` |
| `active-data/attempt` chip + `useAttemptReferent` | `find(attempt.taskId)` | one row | `{ id }` |
| `active-data/task` `TaskChip` | `find(id)` | one row | `{ id }` |
| `add-task` tool view | `find(id)` | one row | `{ id }` |
| `page/…/todo/task-link` | `find(id)` | one row | `{ id }` |
| `worktree-identity` | `select` one title | one row | `{ id }` |
| `tasks/web` `useTask` | `select` one row | one row | `{ id }` |
| `tasks/web` `useTasksById` | filter by ids | an id set | `{ ids }` |
| `task-detail` pane resolve + title | `some(id)` / `useTask` | one row | `{ id }` (`resolveRow`) |
| `hints/ask` filed-task card | already `{ id }` | — | — |
| queue (`use-queue-rows` → `classifyQueue`) | `taskStatusMap` over all | the live conversations' tasks' status | `{ ids }` of their `taskId`s (≈ live set, ≤ 500) |
| `task-graph` `useTaskClosure` | `TaskGraph.from(all).closure` | the dependency closure + groups | **the task's cluster** |
| `task-deps-tree` (section gate + body) | `taskClusterIds(all, id)` | the cluster | **the cluster** |
| `task-dependencies` (card + header) | `find`, dependents | the task's edges both ways | **the cluster** |
| `dependencies-button` | blockers / dependents | closure | **the cluster** |
| `useActiveDependentCount` (dependent-count, drop-dependents, tasks-panel) | `activeDependents` | transitive dependents | **the cluster** |
| `task-draft-popover` (relate) | relate task's row + its direct dependents | the cluster of the relate task | **the cluster** (`{ id }` when nothing relates) |
| `sidequest-autopilot` launch list | `status = new` ∩ sidequest track | a filtered set | a **window**, `where: { status: "new", track: "sidequest" }` |
| `task-list` `ChildCountAction` | `filter(folderId = id).length` per row | a child count | a **row aggregate** (`childCount`), or the loaded subtree |
| `task-list` `TasksListView` (tree DataView) | the whole set, in memory | what is visible: roots, expanded subtrees, search hits | **roots window + per-expanded-root cluster** (below) |

So: **no reader needs the whole set.** Ten need one row (or an id set), six need
a cluster, one needs a filtered window, and the task list needs what is visible.
The `unbounded` reason ("the task list, the dependency graph and the task chips
need every task's status and dependency edges") is true only of how they are
written today, each scanning the set as a lookup table.

## Target shape

Two declarations of the same row (one field record shared between them):

1. **`taskRows` becomes a window** (`default: { orderBy: rank, createdAt; limit
   100 }`, `maxLimit` 500, filterable status / track / category / folderId) —
   which mints `tasks:rows` for every point read and `tasks:groups` / a `:count`
   if wanted. No `preload`; what first paint needs is the window's default page.
   Converting the key from `all` to a window is a C39 change: rename the key
   (an old bundle subscribing `tasks` with `{}` would be refused anyway by the
   window's params gate, but renaming is the documented safe path).
2. **`taskClusterRows`** — a scoped `all: { by: ["clusterId"], unbounded: {
   reason: "one dependency cluster: the edges the graph, deps tree, dependency
   card and the task tree's subtrees walk never leave it (≤ 137 on main)" } }`.
   Served by the same `taskRowsServeOptions`. Needs `cluster_id` total: backfill
   `cluster_id = id` and set it on insert (a NOT NULL column), so a singleton is
   its own scope rather than a NULL no scope can name; and make `group_id` a
   union point.

The task list over those two:

- **Top level** = the roots window (`where: { folderId: { isEmpty: true } }`),
  paged through `useLive(…, { viewport })` like every other DataView source.
- **Expanding a root** loads that root's cluster (`taskClusterRows`, one tuple,
  ≤ 137 rows) — its whole folder subtree in one read, because folder edges never
  leave a cluster.
- **Has-children / child count** is a row field (`childCount`, a `childrenJoin`
  aggregate over `folder_id`), so a collapsed row knows it has children without
  loading them, and `ChildCountAction` reads the row.
- **Search / filter** go to the server (the window's `where` + full-text over
  `title`), each hit's ancestors coming from its cluster.

This needs one thing the substrate does not have today: **data-view refuses a
live `source` with a `hierarchy`** ("a tree over a paged prefix orphans
children"). The clean primitive is a live hierarchy source: a paged roots
window plus a per-node scoped read for the subtree, so the orphaning cannot
happen (a subtree is always loaded whole, from one scope). Pages' block tree
and the file explorer are the same shape, so it belongs in data-view, not in
the task list.

### Cost after

- Boot: no `tasks` value in the snapshot; the sidebar queue's `{ ids }` (≈ the
  live conversations' tasks, tens of rows) and, with the Tasks pane open, one
  page of roots (≤ 100 rows ≈ 80 KB) plus the expanded clusters.
- Restart replay: the same — O(window ∪ open tuples), not O(6,778).
- A task write: its row in each tuple that holds it, as today.

## Why not resume the whole set across a restart

Extending the epoch handoff to persisted `all` aliases (`resource-runtime`'s
`notInheritable` refuses `not-a-point-read` today) would skip the replay, but
it is a cache over an O(collection) path: page boot still ships 5.55 MB, the
set still grows with every task ever filed, and the cost moves rather than
goes. With every reader bounded there is nothing left to resume. Only if a
reader turned out to need every task would resuming be the right fix, and none
does.

## Not done here, worth noting

- **`attempts` is the same problem** (3.44 MB, `all` + `preload: "boot"`): its
  readers (attempt chips, the task's attempt list, worktree identity) are point
  or per-task reads. Same treatment: `{ id }` reads and a per-task scope.
- **`$columns` is 45 % of a row**: seven base exposures, mostly default
  nulls, on every row. Bounding the set fixes the O(n); the per-row weight is a
  separate constant (the wire could omit an exposure slice equal to its
  defaults).

## Cluster bound (follow-up, task-1793850943-wp9f4s)

After step 2, `taskClusterRows` was correct and bounded only while two things
held, and neither was guaranteed:

1. **No edge crosses a cluster.** Held by every mutation remembering to call
   `unionTaskClusters` before its edge write (`handle-move.ts`, outside
   tasks-core, had to remember `prepareRefile`); checked only by a test.
2. **Cluster size.** Observed (largest 137), declared `unbounded`.

There was also a race the endpoint `FOR UPDATE` did not cover: two unions
reaching ONE cluster through different endpoints (`union(X1, Y)` ∥
`union(X2, Z)`, X1 and X2 in X) share no locked row, so the second relabels
X's rows from a snapshot that cannot see the Y rows the first is moving into
X, stranding them on a label nobody else carries.

### End state: the database keeps the label

`tasks-core/server/internal/cluster-triggers.ts`, a `DbTrigger` set (new
generic primitive `database/db-triggers`, installed by the boot schema layer):

- **The edge write IS the union.** AFTER triggers on `task_dependencies`
  (insert / update) and `tasks` (insert / update of `folder_id`, `group_id`)
  call `tasks_union_clusters(a, b)` in the writing transaction. App code calls
  no union; there is nothing to forget.
- **No label write leaves a crossing edge.** An `AFTER UPDATE OF cluster_id`
  trigger re-reads every edge of each relabelled task at the end of the
  statement and refuses it if one crosses — the direct `UPDATE tasks SET
  cluster_id` the union triggers cannot see (the union's own relabel moves a
  whole cluster in one statement, so it passes). Immediate, not deferred: the
  change feed refuses a deferred trigger on a table it routes.
- **The union locks labels, not rows**: transaction advisory locks on both
  labels in one order, re-reading the endpoints until both still carry them.
  Every label writer holds its lock, so the race above serializes.
- **A real bound.** `TASK_CLUSTER_MAX = 500` (tasks-core/core). The union
  counts the two clusters under their locks and refuses (check_violation, with
  a hint naming the fix) when the merge would exceed it. Clusters grow only by
  union, so no cluster can exceed it, and `taskClusterRows` declares
  `all: { max: TASK_CLUSTER_MAX }` — its loader's check is now a guarantee.

What the refusal costs: past 500, the write that would merge (a dependency, a
filing under a folder) fails loudly. That is the right moment — the only way
to reach it is a long-lived hub task that things are filed under or depend on
without end, and that is a modelling problem (a category, not a folder) the
error names, not a load to absorb.

### Are clusters the right primitive?

Yes, as the **scope** of the edge-walking reads — with the bound above.

- **Why not per-task closures** (a server read of "this task's dependency
  closure / dependents / folder subtree")? A closure is not a column: its
  membership changes with edges elsewhere in the graph, so routing a write to
  the closures it affects is a recursive walk per change (or a whole-scope
  recompute), where a cluster write routes by one column. Five surfaces also
  need five different closures (dependencies, dependents, transitive
  dependents, the folder forest, groups) of the same few rows; one cluster
  read serves all of them from one tuple.
- **The deps tree needs the cluster itself.** Its membership is monotone by
  design (`research/2026-08-03-tasks-monotone-deps-tree-membership.md`: a task
  never vanishes from the tree when its last edge is detached), i.e. path
  dependent: it cannot be recomputed from current edges, so it must be a
  persisted label. A closure read would reintroduce that bug.
- **What grows a cluster** is history, not open work: settled tasks stay. On
  main the growth is driven by human-sized work trees (a perf umbrella, an
  audit); the one hub-shaped folder (`task-meta-crashes`, 71 children,
  cluster 109) is legacy and no longer filed under. If a hub appears, the
  bound refuses it at the write, before any reader pays for it.
- **Where it would stop being right**: if the task list (step 4) wanted to
  expand a root by reading its cluster, a 500-task cluster under one root
  would be a big expand. The tree should then page a root's children
  (the data-view live hierarchy source) rather than load the cluster.

## Steps (filed as a main-track chain)

1. Point readers → `useLive(taskRows, { id })` / `{ ids }` (chips, referents,
   `useTask`, `useTasksById`, task pane resolve + title, worktree identity,
   add-task view, todo task-link, the queue's status map). No server change.
2. Total `cluster_id` + `group_id` as a union point + `taskClusterRows`; move
   graph, deps tree, dependency card, dependencies button,
   `useActiveDependentCount`, draft-popover relate onto it.
3. Sidequest launch list → a filtered window.
4. data-view live hierarchy source (paged roots + per-node scoped subtree) and
   the task list on it, with `childCount` as a row field.
5. `taskRows` from `all` to a window (key renamed, no `preload`); measure boot
   snapshot and `replay-bytes.ts` before / after.
