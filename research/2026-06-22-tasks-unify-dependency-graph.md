# Unify the task dependency/dependent mental model

## Context

"Is task X blocked / what's blocked on X / what gets dropped with X" is answered by ~7 independent
traversals scattered across client and server, with **divergent semantics**. The user noticed the
concrete symptom: the **"N tasks blocked on this task"** badge undercounts, because it *stops*
traversing at completed (done/dropped) intermediate tasks, while the actual launch gate keeps deeper
tasks blocked.

Root cause: there is no single definition of two things —
1. **What "settled" means** (a task that no longer blocks and is no longer blocked): redefined ~5×.
2. **How you traverse the dependency DAG**: each call site re-implements an adjacency walk, and they
   disagree on whether to *walk through* settled nodes.

### The agreed unified model

The edge `task_dependencies(task_id → depends_on_task_id)` means "`task_id` depends on
`depends_on_task_id`" (dependent → dependency). A task is **settled** iff `status ∈ {done, dropped}`
(`held` is **not** settled). The single rule, applied identically in **both** directions:

> **Settled tasks are walked _through_ but never acted on** — never counted, never dropped, never
> treated as a blocker. The walk continues *through* a settled node to reach active nodes behind it.

| Path | walks through settled? | acts on settled? | `A → B → C(done) → D` |
|---|---|---|---|
| **badge** — active dependents of A | ✅ | ❌ | counts B, D = **2** |
| **drop-tree** — `dropTaskTree(A)` | ✅ | ❌ | drops B, D (skips C) = **2** |
| **launch gate** — blockers of D | ✅ | ❌ | already correct (D blocked until A done) |

All three must derive from one implementation.

## Approach

One pure `TaskGraph` value object + one `isSettled` predicate, in the lowest layer
(`tasks-core/core`), consumed by every client traversal **and** the server `dropTaskTree`. The SQL
launch gate (`task_blocking_v`) stays as SQL — it is the faithful SQL embodiment of the same rule and
*already correct* — but the one divergent SQL copy of the blocking predicate (`pinned.ts`) is pointed
back at it.

### Why `tasks-core/core` (not `tasks/core`)

`dropTaskTree` lives in `tasks-core/server`. `tasks-core` is the lowest layer (everyone depends on
it), so it **cannot** import from `tasks/core` (that would be a cycle). The shared helper must
therefore live in `tasks-core/core`, which both web consumers and `tasks-core/server` can import.
`TaskListItem` and `TaskStatus` are already defined there. (Per boundary rules, consumers import it
directly from `@plugins/tasks/plugins/tasks-core/core` — no re-export through `tasks/core`.)

## The `TaskGraph` abstraction

New file `plugins/tasks/plugins/tasks-core/core/task-graph.ts`, exported from that plugin's
`core/index.ts`:

```ts
import type { TaskListItem, TaskStatus } from "./..."; // existing schema types

export const SETTLED_STATUSES: ReadonlySet<TaskStatus> = new Set(["done", "dropped"]);
export function isSettled(status: TaskStatus): boolean { return SETTLED_STATUSES.has(status); }

// Minimal shape so both client TaskListItem rows and server tasks_v rows satisfy it.
type TaskNode = Pick<TaskListItem, "id" | "status" | "dependencies" | "groupId">;

export class TaskGraph {
  static from(tasks: readonly TaskNode[]): TaskGraph;   // build byId + forward + reverse adjacency ONCE

  get(id: string): TaskNode | undefined;

  // direct (single hop)
  directDependencies(id: string): TaskNode[];   // its prerequisites (task.dependencies)
  directDependents(id: string): TaskNode[];     // tasks that directly depend on id

  // transitive, WALK-THROUGH-SETTLED, collect only NON-settled  ← the unified rule
  activeDependents(id: string): TaskNode[];     // badge count + drop set
  activeBlockers(id: string): TaskNode[];       // mirrors task_blocking_v
  isBlocked(id: string): boolean;               // activeBlockers(id).length > 0

  // structural (ignore status) — cycle checks & the graph view
  dependsOn(start: string, target: string): boolean;            // transitive reachability
  closure(id: string, opts?: { includeGroups?: boolean }): TaskNode[]; // bidirectional, ALL nodes
}
```

One private `walk(id, direction, collect)` that **always** traverses through settled nodes and only
*collects* nodes passing `collect`. `activeDependents`/`activeBlockers` pass
`collect = (t) => !isSettled(t.status)`; `closure`/`dependsOn` collect everything.

This single change fixes the badge bug: the walk no longer halts at settled nodes; only the collected
set is filtered.

## File-by-file changes

### New / core
- **`tasks-core/core/task-graph.ts`** (new) — `TaskGraph`, `isSettled`, `SETTLED_STATUSES`.
- **`tasks-core/core/index.ts`** — export the above.
- **`tasks-core/core/task-graph.test.ts`** (new, `bun:test`) — pure-logic tests; the `A→B→C(done)→D`
  chain asserting `activeDependents(A) = [B,D]`, `closure` includes C, `dependsOn` structural.

### Client consumers (each builds `TaskGraph.from(tasksResult.data)` in a `useMemo`)
- **`dependent-count/web/components/dependent-count-badge.tsx`** — `graph.activeDependents(taskId).length`. **Fixes the badge.**
- **`drop-dependents/web/components/drop-dependents-button.tsx`** — `graph.activeDependents(taskId).length` (now matches what the server drops).
- **`task-dependencies/web/task-dependents.tsx`** — `graph.directDependents(taskId)`; replace inline terminal check with `isSettled`.
- **`task-dependencies/web/task-dependencies.tsx`** — keep `task.dependencies` for direct list; replace inline terminal check in `DepChip` with `isSettled`.
- **`task-graph/web/components/task-graph.tsx`** — replace `computeDagClosure` with `graph.closure(taskId, { includeGroups: true })`; replace `isNonBlocking`/inline terminal checks with `isSettled`. **Closure still returns settled nodes** — rendering keeps the strikethrough / success-tone edges.
- **`conversation-view/plugins/dependencies/web/components/dependencies-button.tsx`** — `graph.directDependents(myId)` for the blocking direction; `task.dependencies` stays for blocked-by. (Stays direct — the popover edits direct edges.)

### Remove
- **`plugins/tasks/core/utils.ts`** — delete (`countTransitiveDependents` replaced by `TaskGraph.activeDependents`).
- **`plugins/tasks/core/index.ts`** — drop the `countTransitiveDependents` export.

### Server
- **`tasks-core/server/internal/mutations/tasks.ts` → `dropTaskTree`** — build `TaskGraph.from(await listTasks())`, drop `unique([id, ...graph.activeDependents(id).map(t => t.id)])`. **Skips settled descendants** while still traversing through them. (Behavior change: the drop-and-exit cascade no longer re-drops already done/dropped tasks.)
- **`tasks-core/server/internal/queries/tasks.ts` → `taskDependsOn`** — replace the bespoke full-table DFS with `TaskGraph.from(await listTasks()).dependsOn(start, target)` (cycle check; structural, status-agnostic). Folds the last in-process server walk into the shared model.
- **`conversations-view/plugins/queue/server/internal/pinned.ts`** — replace the hand-written single-hop `notBlocked` predicate with a read of `task_blocking_v`:
  ```ts
  const notBlocked = sql`NOT COALESCE((
    SELECT b.has_blocking_dep FROM task_blocking_v b WHERE b.task_id = ${_attempts.taskId}
  ), false)`;
  ```
  Fixes a latent multi-hop bug (the copy didn't punch through dropped intermediates).

### Left as-is (documented, not changed)
- **`task_blocking_v`** (`views.ts`) — the SQL embodiment of the blockers direction; already
  walks-through-settled correctly. Cannot reference `tasks_v.status` (circular), so it keeps deriving
  settled from raw columns (`dropped_at IS NULL AND NOT EXISTS(completed attempt)`). Add a comment
  noting it is the SQL form of `isSettled`/`activeBlockers`.
- **`listBlockingDepIds`** — intentionally **single-hop direct**; all callers (`cascade-blocked`,
  `repair-blocked-order`, `task-status-pin-job`) feed it to `rankAfterBlockers` and walk the frontier
  themselves. Add a one-line comment so a future "consolidation" doesn't make it transitive.
- **`listArmedDependentsOf`**, **`listDependentIds`**, **`getTaskDependencyIds`** — SQL helpers that
  already conform (structural walk-through / direct). No change.

## Verification

1. `./equin build` (rebuilds server + derived views; required for the `pinned.ts` view read).
2. `bun test plugins/tasks/plugins/tasks-core/core/task-graph.test.ts` — the `A→B→C(done)→D` cases.
3. In the running app: build a chain where `A`'s only dependent path runs through a **done** middle
   task to an active task `D`. Confirm:
   - the **"N blocked" badge** on `A` now counts the deeper active `D` (was undercounting / showing the wrong number).
   - the **drop-dependents** button on `A` reports the same count, and dropping `A` drops the active
     descendants but **leaves the done task untouched** (query `query_db`:
     `SELECT id, dropped_at FROM tasks WHERE id IN (...)`).
   - the **task-graph** pane still renders the done node (strikethrough / success-tone edge).
4. Queue pin: create a dependent whose only blocker is reachable *only through a dropped
   intermediate*; confirm the pin no longer treats it as unblocked.
5. `rg -n 'TERMINAL_STATUSES|isNonBlocking|=== "done"' plugins/{tasks,conversations}` returns no
   remaining ad-hoc settled checks in the migrated files — all route through `isSettled`.

## Critical files
- `plugins/tasks/plugins/tasks-core/core/task-graph.ts` (new — the abstraction)
- `plugins/tasks/plugins/tasks-core/core/index.ts` (export)
- `plugins/tasks/plugins/tasks-core/server/internal/mutations/tasks.ts` (`dropTaskTree` — skip settled)
- `plugins/tasks/plugins/tasks-core/server/internal/queries/tasks.ts` (`taskDependsOn`)
- `plugins/conversations/plugins/conversation-view/plugins/dependent-count/web/components/dependent-count-badge.tsx` (badge bug fix)
- `plugins/tasks/plugins/task-graph/web/components/task-graph.tsx` (closure migration)
- `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/pinned.ts` (server latent-bug fix)
