# Atomic net-effect `tasks.statusChanged` emit for multi-edge operations

## Context

A dependency **rewire** ("replace edge A with edge B") is one *logical* operation
but is implemented as several separately-committed dependency mutations. Each
mutation (`addTaskDependency` / `removeTaskDependency`) snapshots the task's
status, writes, and calls `emitStatusChangeIfChanged(taskId, prev)` — emitting
its own durable `tasks.statusChanged` trigger on its own before/after.

Because every edge emits independently, a multi-edge operation can emit a
**spurious intermediate status transition** that downstream trigger consumers
act on. Concretely: a `removeTaskDependency` that momentarily drops a task's last
blocking edge emits a `blocked → unblocked` transition, which drives
`maybeLaunchDependentsJob` (Case 2, `plugins/conversations/server/internal/auto-start-jobs.ts:122`)
to **auto-launch an already-armed, still-blocked task** before the replacement
blocking edge commits.

Commit `2062ee08d` applied a **point fix** to `rewireDependencies`
(add-before-remove ordering) so the task never observes a zero-blocker
intermediate state. But that only patches one call site. The class of bug
remains, and there is already a **second live instance**:
`plugins/tasks/server/internal/handle-insert-between.ts:28-29` does
`removeTaskDependency(target, source)` **then** `addTaskDependency(target, row)`
— the exact remove-before-add that momentarily unblocks `target`.

The structural fix is the **trigger-event equivalent of `withNotifyBatch`**
(which today batches only live-state UI notifications, not durable event/job
triggers): wrap a multi-edge mutation in a single DB transaction, snapshot each
affected task's status once before and once after, and emit **at most one**
`tasks.statusChanged` per task reflecting the true net transition. This
eliminates every spurious intermediate trigger at the source, so no future
multi-edge caller has to hand-order its mutations.

## Design

### New primitive: `withTaskStatusBatch` (tasks-core server)

A batch that (a) runs its body in **one DB transaction** and (b) **coalesces**
all `tasks.statusChanged` emits to the net before→after of the whole operation.
Modelled on `withNotifyBatch` (`plugins/framework/plugins/resource-runtime/core/runtime.ts:1386`):
ambient (not threaded) batch state, flush at the end. The executor threading
follows the existing `RankExecutor` precedent
(`plugins/primitives/plugins/rank/server/internal/helpers.ts:6`,
`findNextRankInFolder(folderId, executor = db)`).

New file `plugins/tasks/plugins/tasks-core/server/internal/status-batch.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "@plugins/database/server";
import type { TaskStatus } from "./schema";

// db-or-tx executor, same shape as RankExecutor.
export type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

interface StatusBatch {
  tx: DbExecutor;                        // the open transaction handle
  before: Map<string, TaskStatus | null>; // earliest entry-status per task
}

const store = new AsyncLocalStorage<StatusBatch>();
export const currentStatusBatch = () => store.getStore();

// Run `fn` in ONE transaction with tasks.statusChanged emits coalesced to the
// NET before→after of the whole operation. Every emitStatusChangeIfChanged call
// inside records its task's entry status but SUPPRESSES its own emit; on commit,
// one trigger is emitted per task whose net status actually differs — enqueued
// on the tx so it lives or dies with the edge writes.
export async function withTaskStatusBatch<T>(
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const batch: StatusBatch = { tx, before: new Map() };
    const result = await store.run(batch, () => fn(tx));
    await flushStatusBatch(batch);   // reads net status on tx, emits with {tx}
    return result;
  });
}
```

`flushStatusBatch` lives next to `emitStatusChangeIfChanged` (it reuses
`readTaskStatus`/`readFolder`/`taskStatusChanged.emit`): for each recorded task,
read the net status **on the tx**, skip if unchanged or the task is gone, else
emit one `tasks.statusChanged({ ... , previousStatus: entryStatus }, { tx })`.

### Make `emitStatusChangeIfChanged` batch-aware + executor-aware

`plugins/tasks/plugins/tasks-core/server/internal/status-emit.ts`:

- `readTaskStatus(taskId, exec: DbExecutor = db)` and `readFolder(taskId, exec = db)`
  gain an executor param (so reads inside the tx see uncommitted writes).
- `emitStatusChangeIfChanged(taskId, previous, exec: DbExecutor = db)`:
  ```ts
  const batch = currentStatusBatch();
  if (batch) {
    // Record entry status once (earliest wins ⇒ = status at batch entry),
    // suppress the per-edge emit. Net emit happens in flushStatusBatch.
    if (!batch.before.has(taskId)) batch.before.set(taskId, previous);
    return;
  }
  // ...unchanged, but read via `exec` and, when exec is a tx, emit with { tx }.
  ```

Non-batch callers (single-edge routes, `createTask`, `updateTask`,
`dropTaskTree`) are unaffected — `exec` defaults to `db`, no batch ⇒ emit
immediately, exactly as today.

### Thread the executor through the dependency mutations

`plugins/tasks/plugins/tasks-core/server/internal/mutations/tasks.ts`:

- `addTaskDependency(taskId, dependsOnTaskId, exec: DbExecutor = db)` — use
  `exec` for the existence checks, the cycle check, the insert, and pass `exec`
  to `emitStatusChangeIfChanged`. The cycle check must read on `exec` so it sees
  edges added earlier in the same batch.
- `removeTaskDependency(taskId, dependsOnTaskId, exec: DbExecutor = db)` — use
  `exec` for the delete and the emit.

The cycle check reaches `taskDependsOn`/`listTasks`
(`plugins/tasks/plugins/tasks-core/server/internal/queries/tasks.ts`), so:

- `listTasks(filters?, exec: DbExecutor = db)` and
  `taskDependsOn(start, target, exec: DbExecutor = db)` gain the executor param
  (`taskDependsOn` forwards it to `listTasks`).

All params are optional with `= db` defaults ⇒ every existing caller
(`handle-create.ts`, `handle-dependencies.ts`, `handle-create-chain.ts`,
core barrel re-exports) compiles and behaves identically.

### Convert the two multi-edge consumers

**`plugins/tasks/server/internal/rewire-dependencies.ts`** — wrap the body in
`withTaskStatusBatch`, thread `tx` to each add/remove, and **remove the
add-before-remove ordering workaround + its long comment** (the net emit makes
ordering irrelevant; the intermediate zero-blocker state now lives only inside
the uncommitted transaction, invisible to the launch job which reads a separate
connection):

```ts
export async function rewireDependencies(opts): Promise<void> {
  await withTaskStatusBatch(async (tx) => {
    if (opts.relation === "followup") {
      await addTaskDependency(opts.newTaskId, opts.targetId, tx);
      const ids = opts.selectiveInsertBefore ?? (await listDependentIds(opts.targetId, tx));
      for (const depId of ids) {
        if (depId === opts.newTaskId) continue;
        await removeTaskDependency(depId, opts.targetId, tx);
        await addTaskDependency(depId, opts.newTaskId, tx);
      }
    } else {
      const targetDeps = opts.standalone ? [] : await getTaskDependencyIds(opts.targetId, tx);
      await addTaskDependency(opts.targetId, opts.newTaskId, tx);
      for (const depId of targetDeps) {
        if (depId === opts.newTaskId) continue;
        await addTaskDependency(opts.newTaskId, depId, tx);
        await removeTaskDependency(opts.targetId, depId, tx);
      }
    }
  });
}
```

(`listDependentIds`/`getTaskDependencyIds` also take `exec = db`; pass `tx` so
the snapshot reflects the transaction.)

**`plugins/tasks/server/internal/handle-insert-between.ts`** — replace the
`withNotifyBatch` + bare remove/add with `withTaskStatusBatch`, so the second
instance of the class is fixed by construction:

```ts
return withTaskStatusBatch(async (tx) => {
  const row = await createTask({ folderId: targetFolderId ?? null, groupId, title: "Untitled", author: "user" }, tx);
  await removeTaskDependency(targetTaskId, sourceTaskId, tx);
  await addTaskDependency(targetTaskId, row.id, tx);
  return row;
});
```

`createTask` also gains `exec: DbExecutor = db` (it already reads/writes
`_tasks` and calls `emitStatusChangeIfChanged` — thread `exec` through so the
new row is created in the same transaction and its first-status emit is batched).
Since the whole body is now one transaction, the change-feed coalesces the UI
notify at commit and the explicit `withNotifyBatch` is no longer needed here.

### Why this closes the race

- All edge writes + the coalesced trigger enqueue commit **atomically** on one
  tx. The `events.dispatch` job row (written by `emit(..., { tx })` →
  `eventsDispatchJob.enqueue({ tx })`, see `event.ts:224`) only becomes visible
  to the worker at commit — by then the DB shows the final blocked state, so
  `maybeLaunchTaskJob`'s `hasBlockingDep` re-check returns true and it bails.
- A task whose net status is unchanged (blocked→…→blocked) emits **nothing**.
- Crash mid-rewire rolls the whole thing back instead of leaving a task
  permanently unblocked with no compensating trigger.

## Files to modify

| File | Change |
|---|---|
| `plugins/tasks/plugins/tasks-core/server/internal/status-batch.ts` | **new** — `withTaskStatusBatch`, `currentStatusBatch`, `DbExecutor`, `flushStatusBatch` |
| `plugins/tasks/plugins/tasks-core/server/internal/status-emit.ts` | batch-aware + `exec` param on `emitStatusChangeIfChanged`/`readTaskStatus`/`readFolder`; host `flushStatusBatch` |
| `plugins/tasks/plugins/tasks-core/server/internal/mutations/tasks.ts` | `exec` param on `addTaskDependency`/`removeTaskDependency`/`createTask` |
| `plugins/tasks/plugins/tasks-core/server/internal/queries/tasks.ts` | `exec` param on `listTasks`/`taskDependsOn`/`listDependentIds`/`getTaskDependencyIds` |
| `plugins/tasks/plugins/tasks-core/server/index.ts` | export `withTaskStatusBatch` |
| `plugins/tasks/server/internal/rewire-dependencies.ts` | wrap in `withTaskStatusBatch`, drop add-before-remove hack + comment |
| `plugins/tasks/server/internal/handle-insert-between.ts` | use `withTaskStatusBatch` instead of `withNotifyBatch` |

Reused as-is: `taskStatusChanged.emit(payload, { tx })` (`tables-events.ts`,
`event.ts` — already supports `{ tx }`); `db.transaction`; the `RankExecutor`
executor pattern.

## Implementation notes / caveats

- **`emit({ tx })` typing.** `EmitTx = NodePgDatabase<Record<string, never>>`
  (`plugins/infra/plugins/jobs/server/internal/registry.ts:19`) while the
  transaction handle is a `PgTransaction`. This `{ tx }` path has no existing
  call site, so expect a minor type reconciliation — pass the tx typed as
  `DbExecutor` and cast to `EmitTx` at the `emit` call if tsc complains (do NOT
  widen by suppressing — verify the runtime `enqueue({ tx })` accepts it).
- **AsyncLocalStorage** is already used in-repo (`runtime-profiler`,
  `checks/scan-context`, `inflight`) and works under Bun — correct choice over a
  module-global so concurrent operations don't clobber each other's batch.
- Keep `dropTaskTree` as-is: it already snapshots all befores up front and does
  a single UPDATE, so its per-task emits are already net (no intermediate
  flips). It's a natural *future* `withTaskStatusBatch` consumer for atomicity,
  but not required for this fix.
- The executor param is optional everywhere (`= db`), so this is a purely
  additive API change — no existing caller needs editing beyond the two
  consumers above.

## Verification

1. `./equin build` (regenerates nothing schema-wise here; confirms tsc +
   checks pass — especially `type-check` and `plugin-boundaries`).
2. **Reproduce the original bug is gone (rewire path).** Create task A (armed,
   auto-start) blocked by prerequisite B. Insert a new prerequisite C between
   B and A via the rewire (`insert-between` / chain / MCP). Confirm A does **not**
   auto-launch and stays blocked on C. Query the emission log to confirm a
   single net `tasks.statusChanged` (or none) for A rather than a
   `blocked→unblocked` intermediate:
   ```
   mcp__singularity__query_db:
     SELECT event_name, payload, matched_count, emitted_at
     FROM tasks_statuschanged_triggers -- (trigger table) and
     -- the emission audit:
     SELECT event_name, payload FROM event_emissions
     WHERE event_name = 'tasks.statusChanged' ORDER BY emitted_at DESC LIMIT 20;
   ```
   Expect no `previousStatus:"blocked" → status:"unblocked"/"new"` transient for
   the rewired task.
3. **`handle-insert-between` path.** Repeat via the "insert between" affordance
   (`POST /api/tasks/insert-between`) with the target armed+blocked; confirm no
   premature launch and no spurious intermediate emit.
4. **Regression / atomicity.** Confirm single-edge add/remove
   (`POST`/`DELETE /api/tasks/:id/dependencies`) still emit immediately (one
   trigger each) — no behaviour change. Confirm a forced cycle rejection inside
   a rewire rolls back cleanly (no partial edges left).
5. Optionally drive it end-to-end in the app (Tasks pane: build a chain with an
   armed leaf, insert a task between two nodes, watch the leaf stay blocked)
   using `e2e/screenshot.mjs`.
