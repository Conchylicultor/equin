# Make `tasks.statusChanged` true, so every task edit re-checks the tasks it affects

**Date:** 2026-08-18
**Category:** global (`tasks`, `conversations`)
**Status:** proposed — supersedes `2026-08-18-global-task-launch-woken-by-db-change.md` (v1)

> **What changed from v1.** v1 proposed leaving the event as-is and waking the launcher
> from the DB change-feed instead. Measurement killed it. v1 assumed the closure walk would
> put a per-dependent recursive-view read inside interactive transactions; in fact a
> `tasks_v` status read is O(whole graph) *regardless of how many ids you ask for*, so
> batching the closure into ONE read makes edge edits and `dropTaskTree` **cheaper than
> today**, not more expensive. With the cost objection gone, fixing the event beats routing
> around it: it fixes both broken consumers instead of one, keeps emission transactional,
> and gives you the notion your mental model asks for — "the tasks this edit modified" —
> as a real, shared thing rather than one consumer's private workaround. The change-feed
> subscriber idea is recorded under Rejected alternatives.

## Context

Four tasks are armed for auto-start right now and will never launch: `tv67jc` and `4c14re`
(armed 2026-08-17), `nzprnm` (2026-07-07), `mue8h1` (2026-05-05). All four are unblocked,
undropped, unheld, zero attempts, marker intact. Every gate in the launcher passes —
**nothing ever told it to look.**

Status is derived from the graph, but the wake-up is a hand-emitted event, and the event
only fires for task ids a call site remembered to name. Traced: removing the edge
`i6clxu → ctdd81` recorded only the edge's own dependent end (`i6clxu`), whose status did
not change — it already read `done`, which outranks `blocked` in the `tasks_v` CASE — so
**no event was emitted at all**. `tv67jc`, unblocked by that removal, was never named by
anything. When `ctdd81` later finished, the fan-out walked `task_dependencies` for armed
dependents over an edge that no longer existed, and reached nobody.

Second victim, same root cause: `queue.task-status-rerank` keys on the identical
blocked↔unblocked transition with no transitive fallback at all, so a graph edit leaves a
conversation ranked above the tasks now blocking it.

## The defect, precisely

Correctness currently lives in a **convention**: *snapshot the status before your write,
then call `emitStatusChangeIfChanged` after it, for every task you think you touched.*
Three things can go wrong — forget the call, name the wrong task, pass a stale `previous` —
and the incident is the middle one, systematically: an edge write can only name its own
endpoint, never the downstream tasks whose derived status it just changed.

So the fix is not "emit better events at the deps-tree endpoints". It is to stop asking
call sites to name the affected set or to pair two calls at all.

## The design

### One primitive

```ts
// plugins/tasks/plugins/tasks-core/server/internal/status-scope.ts   (new)
withTaskStatusChange(seedIds: string | readonly string[], exec: DbExecutor, write: () => Promise<T>): Promise<T>
```

The write happens **inside** the recorder. There is no "afterwards" to forget, no ordering
to get wrong, and no `previous` parameter to supply stalely — the primitive reads it. The
affected set is derived from the graph, not named by the caller.

This is rung 1: the mistake loses its spelling. `emitStatusChangeIfChanged` and
`readTaskStatus` are then deleted / unexported from the barrel (nothing outside tasks-core
imports either — verified), so the wrong primitive is not even reachable.

### The closure rule

For a write recorded against `T`, the tasks whose status can change are exactly
`{T} ∪ transitiveDependents(T)`.

Read the `tasks_v` CASE (`views.ts:278-302`): a task's status is a function of its own
`dropped_at`/`held_at`, its own attempts/conversations/pushes, and
`task_blocking_v.has_blocking_dep` — which is a function of its transitive **ancestors'
settledness**, never of their blocked-ness. Influence flows downstream only, and the graph
is acyclic (`taskDependsOn` bars cycles on insert), so it never re-enters.

**The edge write is safe to bracket.** Writing `A → B` does not change `dependents(A)`, so
the closure is identical before and after the write: the dependents walk from `A` traverses
an edge only if its `depends_on` endpoint is already visited, and this edge's `depends_on`
endpoint is `B`; `B = A` is rejected by the self-check, and `B ∈ dependents(A)` would be a
cycle — rejected on insert, impossible for a removal in an already-acyclic graph. ∎

**Record before the write, not at flush.** Flush-time expansion is set-correct but
status-incorrect: a task entering the closure at flush has no recoverable batch-entry
status, and `previousStatus` is load-bearing for the rerank consumer. Correctness of
record-time: `T` is inserted by the *first* write whose closure contains it; every earlier
write had `T` outside its closure and so could not have changed `T`'s status. Earliest-wins
on the map makes that the one that lands. ∎

### The two queries

Deliberately not fused — fusing costs 38 ms every time, splitting costs 1.5 ms in the
common case.

```sql
-- (a) closure, one recursive CTE seeded with the whole id array
WITH RECURSIVE closure(id) AS (
  SELECT unnest($1::text[])
  UNION                              -- dedupes ⇒ terminates on a cycle
  SELECT td.task_id FROM task_dependencies td JOIN closure c ON td.depends_on_task_id = c.id
) SELECT id FROM closure
```

```ts
// (b) ONE batched status read for whatever is not already snapshotted
select({ id, status, folderId }).from(tasks /* tasks_v */).where(inArray(tasks.id, missing))
```

`tasks_v` carries every base column, so reading `folderId` here deletes `readFolder`
outright. `flushStatusBatch` collapses to one batched read plus a pure
`computeStatusEmits(before, after)` — unit-testable with no DB.

Behaviour with no batch active: same shape inline (read before, write, read after, emit the
differences), so the eleven single-write mutations do not suddenly start opening
transactions.

## What the launcher becomes

Once the event is closure-correct, "becomes launchable" and "leaves `blocked`" are the same
event, because for an armed, attempt-less, undropped, unheld task, `blocked` is exactly the
status it carries while it is not launchable. Branch (1) — the armed-dependents fan-out —
has nothing left to find.

| Z becomes launchable because… | seed recorded | Z in closure | transition | one rule | today |
|---|---|---|---|---|---|
| a dep completes | the dep | ✅ | blocked → new | ✅ | ✅ |
| a dep is dropped | the dep(s) | ✅ | blocked → new | ✅ | ✅ |
| a dep is un-held | the dep | ✅ | blocked → new | ✅ | ✅ *by luck* (reports `done`) |
| **an edge is removed** | edge's dependent end | ✅ | blocked → new | ✅ | ❌ **the incident** |
| **a rewire / deps-tree move** | each write's dependent end, unioned | ✅ | blocked → new | ✅ | ❌ |
| **Z is un-dropped** | Z | ✅ | dropped → new | ✅ | ❌ branch (2) needs `previousStatus === "blocked"` |
| **Z is un-held** | Z | ✅ | held → new | ✅ | ❌ same |
| Z is newly armed | — (no status change) | — | none | `armTaskAutoStart` enqueues | ✅ |

The job collapses to an armed-marker guard plus one enqueue, and is renamed
`tasks.maybe-launch-on-status` ("dependents" becomes a lie). The intermediary job must stay:
a `Trigger`'s `with` is a static input, and `taskId` arrives on the separate `event`
argument, so `maybeLaunchTaskJob` cannot bind to the event directly. Its body is untouched —
`claimAutoStart` remains the exactly-once CAS, which is what makes over-broad wake-ups free.

`listArmedDependentsOf` loses its only caller. Deleting it leaves **one** transitive-dependents
walk in the codebase where there are two today.

`queue.task-status-rerank` is fixed **with zero edits to it** — it starts receiving the whole
closure, so a conversation whose task was blocked by an ancestor several hops up actually
sinks below its blockers, and one unblocked by a detach returns to the top.

## Cost — measured on the live main DB, not estimated

Two premises I stated earlier were wrong. Real shape: **4,189 tasks, 1,468 edges**; max
transitive-dependent closure **47**, max depth **46**, mean **6.5**; 67 % of tasks have no
dependents at all.

| read | cost |
|---|---|
| `SELECT status FROM tasks_v WHERE id = $1` (today's per-task read) | **5.2 ms** |
| same for 10 ids via `= ANY($1)` | **28.6 ms** |
| the closure CTE alone (9-node closure) | **1.2 ms** |
| the full armed-ready query (whole `task_blocking_v`) | **38 ms** |

The load-bearing fact: **a `tasks_v` status read is O(whole dependency graph), not O(ids
requested)** — even the single-id read fully materialises `task_blocking_v`'s recursive
ancestors CTE (8,946 rows over all 1,468 edges), because a plain view's recursive CTE takes
no predicate pushdown. So N separate reads cost N × O(graph), and batching is the whole game.

Consequences:

- **Edge edits get faster.** `rewireDependencies` over a 12-dependent target: ~25
  single-id reads (~125 ms) + a per-task flush loop (~65 ms) today → one 30 ms closure
  snapshot + ~24 × 1.5 ms CTEs + one 30 ms flush read ≈ 100 ms. The closure is
  downward-closed, so after the first record later records find nothing new and skip the
  expensive read.
- **`dropTaskTree` gets much faster**: it loads all 4,189 tasks into JS today and then does N
  sequential status reads (~240 ms for a 47-node subtree) → one seeded CTE + one batched read
  ≈ 35 ms.
- **The path that pays** is a single-task write on a task that *has* dependents
  (`updateConversation` on every turn transition, `insertPush`, `createAttempt`): +1.5 ms CTE,
  +25 ms on the read, not held inside a transaction. For the 67 % with no dependents, cost is
  unchanged.

No cap or bound is warranted: the expensive term is already paid by every existing status
read, and the closure term is bounded by an acyclic 4k-node graph. If the graph grows an
order of magnitude the right fix is to parameterise or roll up `task_blocking_v` (fixing
every reader at once), not to truncate the closure — a cap would be fake safety that drops
correctness silently.

**Event amplification is the real second-order cost** and needs its two mitigations: a settle
on a 47-dependent task now emits up to 48 events instead of 1. (a) the armed-marker guard in
the collapsed job keeps `maybeLaunchTaskJob` enqueues as rare as today; (b) give
`maybeLaunchTaskJob` `dedup: { key: ({taskId}) => taskId }` so repeat wake-ups collapse onto
one graphile row — safe because the CAS is the real gate. Leave rerank on `dedup: "none"`
(its input is `{}`; a key would collapse unrelated events) — it early-returns in one indexed
query when the task has no live queued conversation, the overwhelming case.

## Making it stay fixed

- **Rung 1** — the primitive above.
- **Rung 4** — inside `withTaskStatusChange`, if a batch is active and `exec !== batch.tx`,
  throw. Catches "captured a batch tx and used it outside its batch", which no type can see.
- **Rung 3, existing rule** — register `withTaskStatusBatch` (callbackArg 0) and the new
  `runStatusBatchOn` (callbackArg 1) in `TX_SCOPE_OPENERS`
  (`plugins/database/lint/no-pool-await-in-transaction.ts:99`). It is a transaction chokepoint
  and is **not currently registered**, so pool-awaits inside a status batch go unflagged
  today. This immediately catches a real one: `dropTaskTree`'s `await listTasks()` reads the
  pool, and it is about to be wrapped in a batch.
- **Rung 3, new (phase 2)** — `plugins/tasks/lint/status-write-in-scope.ts`: inside
  `tasks-core/server/internal/mutations/**`, an awaited `.insert/.update/.delete` on one of the
  five status-source relations must be lexically inside a `withTaskStatusChange` callback.
  This closes the only hole rung 1 leaves — a *new* mutation that skips the wrapper entirely.

**Rejected: the branded executor** (`tx: StatusBatchTx` mintable only by the batch). It
catches "no batch" statically but not "wrote and forgot to record", forces
`handle-dependencies.ts` and `dropTaskTree` into transactions they do not need, and would
break `deps-tree-move.test.ts`, which legitimately passes a plain tx. "Outside a batch" was
never the bug — a single-write op needs no coalescing.

## Backlog and self-healing

The fix is forward-only: no future event will name the four tasks stuck now. Add a
host-scoped boot reconcile modelled on `pushReconcileWarmup`
(`plugins/tasks/server/internal/push-watcher.ts:150`), new file
`plugins/tasks/server/internal/auto-start-reconcile.ts`, enqueuing `maybeLaunchTaskJob` for
**every** armed task id.

It deliberately re-derives nothing: `maybeLaunchTaskJob` is already the single gate
(dropped/held → bail, no marker → bail, blocked → bail, claim, attempts → bail). A
"launchable" pre-filter here would be a second copy of that gate that can drift, which is the
disease being cured. 181 markers → 181 indexed job rows at boot, collapsed by the dedup key.
Main rebuilds on every push, so this is continuous healing, not a once-at-boot hope — and it
is the net for the one hole this design cannot close: a write from outside TypeScript (a
migration, a hand-run `psql`).

**On first deploy, four agents launch**, two of them from intent three months old
(`nzprnm` — "Sweep scopedMembership onto remaining eligible keyed scans"; `mue8h1` — "Verify
packages auto-doc consistency"). No age cutoff in the code — "armed and launchable means
launch" is the whole rule. If those two are stale, disarm them first from the task detail's
Prompt card (auto-start → Off).

**The 181 markers, counted:** 104 on dropped tasks, 21 on tasks that already have an attempt,
4 launchable, the rest legitimately blocked. The 21 self-clean on the first reconcile (the job
claims, then bails on `attempts.length > 0`). The 104 never clean up, because the job bails on
`droppedAt` *before* the claim — so a dropped task keeps a live marker, and un-dropping it
would surprise-launch an agent. Structural fix: a small job in the auto-start plugin subscribed
to `tasks.statusChanged`, deleting the marker on `status === "dropped"` — possible *only
because* the event is now trustworthy, and it avoids the import cycle a direct call from
tasks-core would create (auto-start extends tasks-core, not the reverse) — plus a one-time
sweep of the 104 legacy rows. **This is a visible behaviour change** (after it, un-dropping a
task will not resume its queued launch) and is listed as its own step so it can be dropped.

## Rejected alternatives

- **Wake the launcher from the L4 change-feed** (v1's proposal): add a
  `TableChangeSubscriber` seam next to `routeChange`, subscribe the six status-source tables,
  and sweep the armed set (38 ms, 4 ready rows today). Genuinely appealing — it covers even
  out-of-TypeScript writes, and it is a net deletion in the domain. Rejected because it leaves
  `tasks.statusChanged` a known-false event that every future consumer inherits, it does not
  fix `queue.task-status-rerank` (a table change carries no before/after, so that consumer
  needs its own persisted `was_blocked` column and a rewrite), its wake-up is post-commit and
  therefore losable, and it adds a new seam to a load-bearing plugin to avoid a cost that
  measurement showed does not exist. The boot reconcile above recovers most of its unique
  benefit for one file.
- **A `task_launch_ready` derived-table rollup.** `bool_or` over a transitive closure is not
  incrementally maintainable — with fan-in, removing one edge may or may not remove the
  ancestor — so every write forces the same re-walk, at the price of a third hand-written copy
  of the blocking rule inside opaque SQL. Rollups are also change-feed exempt, so nothing would
  learn a row appeared.
- **`graphile_worker.add_job` from a trigger.** Banned by the `jobs:no-raw-addjob` check
  (which greps inside string literals precisely for this), and it would bypass `queueNameFor`,
  the zod input parse, and dedup namespacing.
- **A live-state resource carrying the launchable set.** Its only server-side hook,
  `onResourcePush`, fires *only when a browser is subscribed*, and the set is neither a window
  nor a point selector — exactly the unbounded shape
  `research/2026-07-18-global-bounded-working-set-resource-contract.md` closed.

## Ordered implementation

1. **`tasks-core/server/internal/queries/tasks.ts`** — add `listDependentClosure(seedIds, exec)`
   (the CTE) and `readTaskStatuses(ids, exec) → Map<id, {status, folderId}>`. `exec` required, no
   default, matching the documented `listDependentIds` convention. Delete `listArmedDependentsOf`.
2. **New `tasks-core/server/internal/status-scope.ts`** — `withTaskStatusChange` with both paths
   and the `batch.tx === exec` assert. Carry the edge theorem and the record-time induction as the
   file header; they are why the code is shaped this way.
3. **`…/status-emit.ts`** — extract pure `computeStatusEmits(before, after)`; rewrite
   `flushStatusBatch` as one batched read + that function; delete `readFolder`; delete
   `emitStatusChangeIfChanged`.
4. **`…/status-batch.ts`** — split out `runStatusBatchOn(tx, fn)`; `withTaskStatusBatch` becomes
   the transaction-opening wrapper. (Also what lets a test drive a batch inside its own
   rolled-back transaction — not a bypass spelling, a real batch on the caller's connection.)
5. **Convert the 14 call sites** to `withTaskStatusChange(ids, exec, () => write)`, each losing
   its `readTaskStatus` line and its trailing emit: `mutations/tasks.ts` (`createTaskOn`,
   `updateTaskOn`, `addTaskDependency`, `removeTaskDependency`, `dropTaskTree` — the last seeded
   with the whole id array, wrapped in `withTaskStatusBatch`, its `listTasks()` moved onto `tx`),
   `mutations/attempts.ts` (2), `mutations/conversations.ts` (6), `mutations/pushes.ts` (1),
   `sweep-orphaned-attempts.ts` (1).
6. **`tasks-core/server/index.ts`** — unexport `emitStatusChangeIfChanged`, `readTaskStatus`,
   `listArmedDependentsOf`; export `runStatusBatchOn`.
7. **`plugins/database/lint/no-pool-await-in-transaction.ts`** — register the two batch openers in
   `TX_SCOPE_OPENERS`; fix what it now reports.
8. **`plugins/conversations/server/internal/auto-start-jobs.ts`** — delete branch (1); collapse to
   armed-guard + single enqueue; rename to `tasks.maybe-launch-on-status` (update the `Trigger` in
   `plugins/conversations/server/index.ts` and its contributes doc line); add `dedup: { key }` to
   `maybeLaunchTaskJob`.
9. **`plugins/tasks/server/internal/arm-auto-start.ts`** — enqueue unconditionally; drop the
   duplicated `hasBlockingDep` gate (`maybeLaunchTaskJob` re-checks it, so the pre-check can only
   drift).
10. **`auto-start/server/internal/mutations.ts`** — add `listArmedTaskIds()`, export from that
    plugin's barrel.
11. **New `plugins/tasks/server/internal/auto-start-reconcile.ts`** + register in
    `plugins/tasks/server/index.ts` beside `pushReconcileWarmup`.
12. **Drop-cancels-arm subscriber** + the one-time sweep of the 104 dropped-task markers
    (behaviour change — drop this step to defer it).
13. Fix stale comments while adjacent: `handle-clear-auto-start.ts` and `arm-auto-start.ts` still
    describe "per-dep oneShot triggers" that no longer exist.

## Verification

**Unit, pure** — `…/internal/status-emit.test.ts`: `computeStatusEmits` — unchanged status → no
emit; task absent from `after` → no emit; `before === null` → emits with
`previousStatus === status`; a closure member changed while the seed did not → emits for the
member only.

**Integration, real DB** — `…/internal/status-closure.test.ts`, using the rolled-back-transaction
+ `Rollback` sentinel pattern already established in
`plugins/tasks/server/internal/deps-tree-move.test.ts` (which documents why: `tasks_v` only
exists in a booted DB). Run with `./equin test plugins/tasks` after a build.
1. Closure SQL: `C → B → A` ⇒ `closure([A]) = {A,B,C}`, `closure([C]) = {C}`; a diamond dedupes;
   a multi-id seed returns the union.
2. **The incident as a three-row regression test.** The edge's dependent end must be **settled**,
   or the test is vacuous — under the shared rule (`depIsBlocking`) a *plain* task is unresolved
   and therefore blocks, so an all-plain `A`, `B→A`, `C→B` fixture would leave `C` blocked by `B`
   and would emit for `B` even under today's code. Correct fixture: `A` plain, **`B` dropped**,
   `C` plain, edges `B→A` and `C→B`. `C` is blocked transitively *through* the dropped `B` by the
   plain `A`. Remove `B→A`: `C`'s only remaining ancestor is `B`, which is dropped and does not
   block, so `C` goes `blocked → new`, while `B` reads `dropped` either side and `A` never moves.
   That is exactly the traced incident — the edge's own endpoint shows no change, so today's code
   emits **nothing at all** and `C` is invisible. Assert the emitted set is exactly
   `[{C, blocked → new}]`, plus the entry/exit status of all three so it cannot pass vacuously.
3. Batch-entry semantics, on the same fixture: write 1 removes `B→A` (records `C` at `blocked`,
   moves it to `new`), write 2 holds `C`; the flushed emit must carry `previousStatus: "blocked"`,
   not the intermediate `new` — and assert the intermediate really is `new`, so a
   record-at-second-write bug fails the test.
4. Cycle safety: seed a cycle by raw SQL and assert the closure query terminates.

**Live, in the worktree** (emission only — `maybeLaunchTaskJob` and the host-scoped warmup both
no-op when `!isMain()`, so a worktree cannot spawn a duplicate agent): detach a real blocking
edge through the UI, then `query_db` `event_emissions` for recent `tasks.statusChanged` and
assert the *downstream* task ids appear with `previousStatus: "blocked"` — the whole fix in one
row — and that `tasks.maybe-launch` was enqueued for the newly-unblocked armed task.

**On main after the push** — this query is the standing definition of "stuck" and returns 4 rows
today; it must return 0 once the reconcile drains:

```sql
SELECT a.parent_id, t.status FROM tasks_ext_auto_start a JOIN tasks_v t ON t.id = a.parent_id
 WHERE t.dropped_at IS NULL AND t.held_at IS NULL AND t.status <> 'blocked'
   AND NOT EXISTS (SELECT 1 FROM attempts WHERE task_id = t.id)
```

Then: the four tasks each have an attempt within a minute of boot; `SELECT count(*) FROM
conversations WHERE created_at > now() - interval '10 minutes'` shows exactly 4 new launches, not
a runaway; marker count falls from 181 to ~60 if step 12 is included.
