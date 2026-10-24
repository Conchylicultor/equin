# Tasks: monotone dependency-tree membership (`tasks.clusterId`)

## Context

Dragging a task to the root of the task-detail **Dependency tree** made it vanish
from the tree entirely — from *both* the Dependencies and Created tabs, and from
the pane it was dragged in.

Reproduced exactly in the prod DB. `task-1785768481584-u01k0k` and
`task-1785768481403-9x8sex` were created together by an improve draft-form chain
against a `category` target, so both got `folderId = NULL`, `groupId = NULL`, and
their only tie was the chain's single dependency edge. After the drag that task
has zero dependency edges, zero dependents, and no folder — an isolated node.

The mechanism:

- `taskClusterIds` (`plugins/tasks/plugins/task-deps-tree/core/cluster.ts:22`)
  derives the tree's member set as the **connected component** of the pane's task
  over dependency edges ∪ `folderId` edges, recomputed from live data every render.
- `applyDepsTreeMove` (`plugins/tasks/server/internal/deps-tree-move.ts:31-46`)
  heals by removing *all* of the moved task's parent edges, then attaches. With
  `newParentId === null` it attaches nothing — `healed root — ready / parallel, no
  parent edge`.
- So the last edge disappears, the component splits, and the task is no longer a
  member of the set `deps-tree-section.tsx` renders.

**The set is not closed under its own operations.** This is not specific to
root-drops: `DetachAction` (tooltip *"Detach — make this a root"*) and the
"also after" chip both call `removeTaskDependency` directly and can eject a task
the same way, and the heal's cross-product bridge can strand a *sibling* when the
moved task had children but no parents. Commit `7e6adf48f fix(task-deps-tree):
derive the section's self-hide from the rendered cluster` already patched one
symptom of this class at the visibility gate; this is the second occurrence, which
is why the fix belongs in the membership model.

### The invariant to establish

> The set of tasks in the dependency tree is fixed. New tasks can be added to the
> tree, but a task can never disappear from it — even with no connection left, even
> with multiple independent roots. Disconnected tasks render in parallel.

Membership must be **monotone**: it grows when an edge is created and *never*
shrinks when one is removed. That makes it **path-dependent** — a function of
history, not of current state — which is exactly why it cannot be a `derived-view`
or `derived-table` (both rebuild from source on every boot and would re-split
clusters). It must be genuine persisted state.

## Design

Add a persisted union-find label `tasks.clusterId`. Two tasks are in the same
dependency tree **iff** they carry the same label. Edge creation unions; edge
removal does nothing. That is the whole fix.

**Label = `min(id)` over the cluster.** Not because it is the oldest member — it
isn't; ids carry `task-`, `claude-`, and `legacy-claude-` prefixes, so `min` is
lexicographic, not chronological. The reason is that `min` is **associative and
idempotent**: the incremental union and the batch backfill agree by construction
(`min(min(A,B),C) = min(A,B,C)`), a repair pass is a no-op on already-correct rows,
and the label is stable. It also updates the fewest rows in the dominant case — a
freshly minted `task-1785…` id is greater than every existing id, so a new task
always loses and the union rewrites exactly one row.

**`NULL` means "singleton — never unioned".** The column stays nullable
permanently; readers take `t.clusterId ?? t.id`. This is a total, well-defined
default, not an absorbed failure: a task that has never been unioned genuinely is
its own cluster. It buys three things over `NOT NULL`:

- A missed insert site degrades to *"the task is its own tree"* — the correct
  default. Under `NOT NULL DEFAULT ''` (the `20260701_…__backfill_song_source.sql`
  pattern) every missed row would silently fuse into one phantom mega-cluster.
- `adoptOrphanConversation` (`mutations/cross-table.ts:112`, the one raw
  `insert(_tasks)` that bypasses `createTask`) and `deps-tree-move.test.ts:30`'s
  raw seed INSERT need no change at all.
- Half the wire cost: 1966 of 3994 tasks are singletons, so they ship `null` rather
  than a 25-char id.

The tsc-forcing that `NOT NULL` would buy is worth little here — there are exactly
two `insert(_tasks)` sites in the repo.

## Implementation

### 1. Schema — `plugins/tasks/plugins/tasks-core/`

- `core/internal/fields.ts` — add to `taskFields`:
  ```ts
  // Monotone dependency-tree membership label (union-find representative =
  // min(id) over the cluster). NULL ⇒ never unioned ⇒ its own singleton cluster.
  // Grows on edge creation, NEVER shrinks on edge removal — that is the point.
  clusterId: nullable(textField()),
  ```
  Everything downstream derives from this one record: `defineEntity` in
  `server/internal/tables.ts` emits the column, `tasks_v` picks it up through its
  `...getTableColumns(_tasks)` spread (`server/internal/views.ts:198`), and
  `TaskSchema`/`TaskListItemSchema` gain it automatically via `fieldsToZodObject`.
- `server/internal/tables.ts:50-53` — add `index("tasks_cluster_id_idx").on(t.clusterId)`
  to the `tasksEntity` meta. Without it the union's `WHERE cluster_id = $loser` is a
  seq scan over ~4k rows inside a held transaction.
- `server/internal/resources.ts:242-258` — add `clusterId: tasks.clusterId,` to the
  `tasksResource` select. **Mandatory**: the `satisfies Record<keyof TaskListItem,
  unknown>` guard makes this a compile error otherwise (working as designed — see
  its comment on the `titleAuto` incident).

Wire cost: `tasksResource` is `bootCritical`, so this rides in the boot snapshot and
every tab's payload. ~2000 non-singleton rows × ~30 bytes ≈ **+60 kB on a ~1.3 MB
resource (+5%)**. Acceptable, but stated deliberately — this is the same budget line
`description` was omitted over.

### 2. The union — new `tasks-core/server/internal/mutations/clusters.ts`

```ts
export async function unionTaskClusters(a: string, b: string, exec: DbExecutor = db)
```

Read both labels **under a row lock**, then relabel:

1. `SELECT id, cluster_id FROM tasks WHERE id IN ($a,$b) ORDER BY id FOR UPDATE`
2. `la = row(a).clusterId ?? a`, `lb = row(b).clusterId ?? b`; `if (la === lb) return`
3. `winner = la < lb ? la : lb`, `loser` = the other
4. `UPDATE tasks SET cluster_id = $winner WHERE cluster_id = $loser OR (cluster_id IS NULL AND id IN ($a,$b))`

The `FOR UPDATE` in step 1 is **load-bearing, not defensive**. Without it the plain
read-then-write loses updates at READ COMMITTED:

```
T1 union(A,B): reads 1,2 → UPDATE ... WHERE cluster_id = 2
T2 union(B,C): reads 2,3 → UPDATE ... WHERE cluster_id = 3
```

Neither statement touches the other's rows, both commit, and C is stranded on a
label nobody else carries — the reported bug again, in a form no edge removal
explains. `FOR UPDATE` makes T2 re-read the latest committed row version after T1
clears, so it computes `min(1,3)`. `ORDER BY id` gives the endpoint pair a
consistent lock order.

Which is why **`unionTaskClusters` opens its own transaction when `exec` is the
pool.** A `FOR UPDATE` taken in autocommit releases at statement end, so on the pool
the lock and the relabel would be two independent transactions and the interleaving
above would be wide open — at exactly the sites that pass no executor. Passing a `tx`
still joins the enclosing transaction. The lock is only real inside one.

The second disjunct in step 4 materialises a `NULL` endpoint straight to the
winner. It is correct precisely because a `NULL` row has never been unioned, so it
is provably a singleton — no other row needs relabelling with it. This keeps the
hot path on the plain index instead of a `COALESCE(cluster_id, id)` expression.

Residual deadlock risk: `applyDepsTreeMove` performs many unions per request, and
`plugins/database/server/internal/client.ts:149`'s 40P01/40001 retry covers only
autocommit statements, **not** transactions. Accept it (single-relation, low rate)
and log `[deadlock]` loudly rather than adding an advisory lock, which would
reintroduce a cycle against row locks the enclosing tx already holds.

### 3. Union points

Ordering rule, and it is asymmetric: **union at or before the edge write, never
after.** A committed union with a lost edge write over-approximates membership —
harmless, that *is* the invariant. A committed edge write with a lost union
under-approximates — that is the bug.

As shipped the ordering rule is a belt-and-braces argument rather than the load-
bearing one: **every union site is now transactional**, so the union and its edge
write commit or roll back together and neither can be lost without the other. The
ordering still matters for the one thing a transaction cannot cover — a *rejected*
write (self/descendant guard, cycle check) must not have unioned — which is why the
union sits after the guards at every site.

| Site | Change |
|---|---|
| `addTaskDependency` (`mutations/tasks.ts:134`) | `unionTaskClusters(taskId, dependsOnTaskId, exec)` before the insert. The **only** writer of `task_dependencies` — all 7 server and 6 web call sites funnel through it. |
| `createTask` (`mutations/tasks.ts:38`) | INSERT with `clusterId` unset (NULL), then `unionTaskClusters(id, folderId, exec)` when `folderId` is set — both inside ONE transaction (opened here when `exec` is the pool, joined when the caller passes a tx). |
| `updateTask` folderId re-file (`mutations/tasks.ts:85-92`) | Union **before** the `db.update`, after the self/descendant guards. Takes `exec: DbExecutor = db` and uses the same executor-resolving split as `createTask`, so the guards, union, write, emit and read-back all run on one transaction. |
| `handle-move.ts:57` | Union on the tx, before the folderId `UPDATE`. |
| `handle-create-chain.ts:137` | Already goes through `addTaskDependency`. Note `withNotifyBatch` is notify-coalescing only, **not** a transaction. |
| `adoptOrphanConversation` (`mutations/cross-table.ts:112`) | No change — the raw insert leaves `NULL`, which correctly means singleton. |

**`createTask` unions; it does not compute the label inline.** An earlier draft of
this table said "computed into the same INSERT". That was wrong, and the reason
generalises: reading a label and writing it somewhere else is a lost-update race
whenever the read is unlocked. `T1` reads folder `F`'s label `L1`; `T2` unions `F`
into a smaller cluster, relabelling it `L0`; `T1`'s INSERT then lands `L1` — a
label no other row carries, so the new task is stranded in a cluster of one. That
is the vanishing-from-its-tree failure this whole column exists to prevent, and it
needs no crash, only ordinary concurrency. Adding `FOR UPDATE` to the read does not
fix it: most `createTask` callers pass the pool executor, where the lock releases at
statement end. So **every label write goes through `unionTaskClusters`**, which holds
the lock across the read and the relabel. `clusterLabelOf` survives as a pure read
only.

Insert-then-union looks like it trades the race for a crash window — two statements,
so a crash between them would leave the new task NULL-labelled (an
under-approximation, the unsafe direction). It does not, because **`createTask` runs
its body in one transaction**: it opens one when `exec` is the pool and joins the
caller's when given a tx. The INSERT and the union then commit or roll back together,
*and* the union's `FOR UPDATE` is finally a real lock. Both properties, nothing
traded. Only the pool path wraps, and on that path the caller holds no locks, so it
cannot deadlock; `emitStatusChangeIfChanged` already emits on a tx handle when given
one, and `handle-insert-between` has called `createTask` under `withTaskStatusBatch`
all along.

`unionTaskClusters` self-wraps for the same reason: a `FOR UPDATE` in autocommit
releases at statement end, and without the wrap §2's guarantee would be silently
false wherever a caller passed no executor.

**`updateTask` follows the same shape**, and an earlier draft of this section was
wrong to accept a window there. It said threading a tx through would trip
`database/no-pool-await-in-transaction` — but that rule is about *wrapping* a
pool-based body, not about threading a caller-supplied executor, which is exactly
what the three sibling mutations in the same file already do. So `updateTask` now
takes `exec: DbExecutor = db`, splits into a `updateTaskOn` body, and opens a
transaction on the pool path. Two things follow: the re-file union and the folder
write can no longer disagree, and the path became reachable from the rolled-back
test harness, which it previously was not — the window and the test gap had the same
single cause. This required `isDescendant` to accept an executor too (it hardcoded
`db`); it now defaults to `db` like `listTasks` beside it, so its two call sites are
unaffected.

The general rule behind all three: **a lock is only real inside a transaction, so any
primitive whose correctness rests on one must own that transaction rather than
assume its caller supplied it.** Every union site now obeys it, which is why the
ordering rule above is no longer load-bearing on its own.

**`groupId` does not union.** Not because it is redundant — one task on main
(`group_id IS NOT NULL AND folder_id IS NULL` with no dep edge, from
`handle-create-chain.ts:157`'s `linkedToPrev === false` branch) proves it isn't. The
reason is that `clusterId` must reproduce `taskClusterIds`'s relation set *exactly*,
and that set is `{dependency edges, folderId}`; `groupId` is deliberately excluded
(`core/cluster.ts:7-18`). Unioning it would be a semantic expansion, not a fix. That
one orphan is a pre-existing gap in today's behaviour too, so nothing regresses.

### 4. The read collapses to a filter

`plugins/tasks/plugins/task-deps-tree/core/cluster.ts` — `taskClusterIds` becomes:

```ts
const label = (t: TaskListItem) => t.clusterId ?? t.id;
export function taskClusterIds(tasks, rootId): Set<string> {
  const root = tasks.find((t) => t.id === rootId);
  if (!root) return new Set();
  const target = label(root);
  return new Set(tasks.filter((t) => label(t) === target).map((t) => t.id));
}
```

The BFS, the `TaskGraph.from` build, and the `childrenOf` reverse-adjacency map all
go away. Its three consumers (`core/index.ts` barrel, `deps-tree-section.tsx:38`
availability gate, `deps-tree-section.tsx:69` `memberIds`) are unchanged.
`buildDepsTree` is untouched — it already takes `memberIds` as a parameter.

`task-graph` keeps its own separate closure. `TaskGraph.closure(id, {includeGroups:
true})` follows `groupId` *upward only* and does not follow `folderId` — it is
asymmetric, therefore not an equivalence relation, therefore **not expressible as a
label at all**. And `useTaskGraphAvailable` gates on a live-graph question ("does
this task have edges right now"), the exact opposite of the monotone question the
deps tree asks. Add one line to both `task-deps-tree/CLAUDE.md` and
`task-graph/CLAUDE.md` recording that the two "clusters" are intentionally different
relations — that divergence is what a future reader will "fix" wrongly.

### 5. Migrations — two `./equin build` runs, in this order

1. **DDL**: `./equin build --migration-name add_task_cluster_id` → drizzle-kit
   emits `ALTER TABLE "tasks" ADD COLUMN "cluster_id" text;` + the index.
2. **DML**: `./equin build --custom-migration --migration-name backfill_task_clusters`,
   then hand-edit the generated empty file:

```sql
WITH RECURSIVE e AS (
  SELECT task_id, depends_on_task_id FROM task_dependencies
  UNION ALL SELECT depends_on_task_id, task_id FROM task_dependencies
  UNION ALL SELECT id, folder_id FROM tasks WHERE folder_id IS NOT NULL
  UNION ALL SELECT folder_id, id FROM tasks WHERE folder_id IS NOT NULL
),
reach(root, node) AS (
  SELECT id, id FROM tasks
  UNION
  SELECT r.root, e.depends_on_task_id FROM reach r JOIN e ON e.task_id = r.node
)
UPDATE tasks t SET cluster_id = c.rep
FROM (SELECT root, min(node) AS rep FROM reach GROUP BY root) c
WHERE t.id = c.root AND t.cluster_id IS NULL;
```

`WITH RECURSIVE` alone cannot label components (the recursive term cannot
aggregate), hence the full seed-keyed reachability then `GROUP BY root`. Verified
read-only against main: 2339 components, max size 109, 40,894 `(root,node)` pairs —
trivially cheap. `data-migration-dml-only` allows a leading `WITH`. Keep the
`cluster_id IS NULL` guard: it makes the file re-runnable, which matters because
`rehashBranchLocalDataMigrations` re-applies a data migration once per DB whenever
its content changes.

Expect `migration-applies-clean` retries: it dry-runs against **live main** under
`lock_timeout = '1s'`, and this branch takes `AccessExclusive` on the hottest table
plus a 3994-row `UPDATE`. Keep the mass UPDATE alone in its own data migration so a
retry re-runs the minimum. Failures there are lock contention, not correctness — the
dry-run always rolls back.

### 6. Repair the already-broken task

The backfill labels from *live* connectivity, so the task from the bug report stays
a singleton — its edge is already gone. Restore it as a parallel root of the tree it
came from, in the same data migration:

```sql
UPDATE tasks SET cluster_id = (SELECT COALESCE(cluster_id, id) FROM tasks WHERE id = 'task-1785768481403-9x8sex')
WHERE id = 'task-1785768481584-u01k0k' AND cluster_id IS NULL;
```

## Accepted consequence: merges are irreversible

Monotone membership means one accidental drag or one wrong dependency **permanently**
fuses two trees, and removing the edge does not undo it. There is no bound on growth
and the failure is quiet (a detail pane starts rendering hundreds of rows). Max
component today is 109 of 3994, and `folderId` edges — which are never removed —
already fuse monotonically, so this is not a new growth vector, only a new one for
dependency edges.

Two mitigations shipped with it, no new UI:

- The §5 CTE **without** the `cluster_id IS NULL` guard is a documented repair DML
  that relabels every cluster from live connected components.
- A health query for any cluster exceeding N members.

Also note deliberately: `useHasDepsCluster`'s `size > 1` gate means the "Dependency
tree" card, once shown for a task, can never disappear again. That is what was asked
for.

## Files

**Modify**: `tasks-core/core/internal/fields.ts`; `tasks-core/server/internal/{tables.ts,resources.ts}`;
`tasks-core/server/internal/mutations/tasks.ts`; `tasks/server/internal/handle-move.ts`;
`task-deps-tree/core/cluster.ts`; `task-deps-tree/CLAUDE.md`; `task-graph/CLAUDE.md`.

**Create**: `tasks-core/server/internal/mutations/clusters.ts` (+ barrel export);
`tasks-core/server/internal/mutations/clusters.test.ts`; two migrations under
`plugins/database/plugins/migrations/data/`.

## Verification

1. `./equin build` twice per §5, then confirm no task lost its tree:
   ```sql
   -- every live connected component must sit inside exactly one label
   -- (labels may over-approximate; they must never split a component)
   ```
   Run the §5 reachability CTE and assert
   `count(DISTINCT COALESCE(cluster_id, id)) = 1` per component.
2. `bun test plugins/tasks/plugins/task-deps-tree/core` — the `task()` fixture at
   `deps-tree.test.ts:16-32` gains `clusterId`, and the `describe("taskClusterIds")`
   block (6 tests over a graph walk that no longer exists) collapses to three: same
   label ⇒ member, different label ⇒ not, unknown root ⇒ empty. **Its
   `"detaching a dependency edge does not change the member set"` test must be
   re-created server-side** — it is the only regression guard for the actual bug.
3. `bun test plugins/tasks/server/internal/deps-tree-move.test.ts` — add the prod
   repro to the existing real-DB harness: seed `A←B←C`, run
   `applyDepsTreeMove({taskId: 'C', newParentId: null})`, assert all three still
   share a label. Today that suite only asserts `readEdges`, which is why this
   shipped. Add the sibling-stranding variant (moved task with children and no
   parents, empty `oldDeps` cross-product at `deps-tree-move.ts:37-40`).
4. `bun test plugins/tasks/plugins/tasks-core/server/internal/mutations/clusters.test.ts`
   — union idempotence and order-independence (`union(A,B)` then `union(B,C)` ≡ the
   reverse), removal-never-shrinks, and **the §2 lost-update race across two real
   concurrent transactions** (needs two connections ⇒ `db-test-fixture`'s throwaway
   DB, not the rolled-back single-tx harness). Without that last one the race ships
   silently.
5. End-to-end on the real bug: open
   `http://<worktree>.localhost:9000/agents/c/conv-1785785527-eft4/t/task-1785770065107-fbe9ik`,
   confirm `task-1785768481584-u01k0k` is back as a parallel root in both tabs, drag
   it to root again, and confirm it stays.
