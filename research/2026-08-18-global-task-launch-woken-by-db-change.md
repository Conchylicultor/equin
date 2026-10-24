# Auto-start woken by the database, not by call sites

**Date:** 2026-08-18
**Category:** global (`database/change-feed`, `tasks`, `conversations`)
**Status:** SUPERSEDED by `2026-08-18-global-task-launch-woken-by-db-change-v2.md` — the cost
premise below ("expanding the event's recorded set puts a recursive-view read per closure
member inside interactive transactions") was measured and is false: a `tasks_v` status read is
O(whole graph) regardless of id count, so one batched read is cheaper than today's per-task
loop. Kept for the rejected-alternatives record.

## Context

Four tasks are armed for auto-start right now and will never launch. Two were armed
tonight (`task-1786980794589-tv67jc`, `task-1786981110324-4c14re`), one on 2026-07-07,
one on 2026-05-05. All four are unblocked, undropped, unheld, have zero attempts, and
still carry their `tasks_ext_auto_start` marker. Nothing is going to start them.

The cause is not in the launcher's gates — every gate passes. It is that **nothing ever
told the launcher to look**. A task's status is derived from the graph, but the wake-up
is a hand-emitted event, and the event only fires for task ids a call site remembered to
record.

Traced concretely: the edge `i6clxu → ctdd81` was removed. `removeTaskDependency`
records only the edge's dependent end (`i6clxu`), and `i6clxu` already reported `done`
(in the `tasks_v` CASE, `done` outranks `blocked`), so its status did not change and
**no event was emitted at all**. `tv67jc`, which that removal unblocked, was never named
by anything. Later, when `ctdd81` finished at 22:59:59, the fan-out walked
`task_dependencies` looking for armed dependents — over an edge that no longer existed —
and reached nobody.

The intended mental model is: *editing the deps tree re-checks the tasks it affects.*
Today only two shapes do: a dependency going `done`/`dropped`, and a task itself leaving
`blocked`. Everything else — detach, drag-move, insert-between, rewire — is silent.

## The decisive fact

`blocked(Z) ⇔ ∃ A ∈ ancestors(Z) : blocking(A)`. Z becomes launchable in two ways:

- **(a) an ancestor stops blocking.** Always emitted today — the ancestor is the task the
  call site wrote, and call sites do record the task they write.
- **(b) an ancestor leaves Z's ancestor set** — an edge on the path `Z ⇝ A` is removed.
  Here the written task is the edge's dependent end, whose own status frequently does
  **not** change (it is `done`, or `dropped`, or still blocked by something else), so no
  event is emitted at all — and even when one is, it names the wrong task.

Case (b) cannot be recovered by making the launcher sweep harder on
`tasks.statusChanged`, because in case (b) there is no event to sweep from. **The wake-up
has to come from the write itself.**

Same root cause, same blindness, second victim: `queue.task-status-rerank`
(`plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/task-status-rerank-job.ts`)
keys on the identical blocked↔unblocked transition and has no transitive fallback at all,
so a graph edit leaves a conversation ranked above the tasks now blocking it. Out of scope
here — see Follow-ups.

## The principle

Stop notifying the launcher. **Nobody notifies it; it is woken by the data.**

The L4 change-feed already fires a STATEMENT-level trigger on every write to every table
and delivers it post-commit
(`plugins/database/plugins/change-feed/server/internal/{triggers,listener,route-change}.ts`).
It is the mechanism that makes missed invalidations structurally impossible for
live-state. It just has no seam for anything other than live-state resources:
`applyDbChange` looks the table up in `tableToResources()` and returns early for a table
no resource reads.

Add that seam, and let the launcher observe the armed set instead of enumerating the
ways a task can become launchable. This removes the whole class: no call site
participates in the launcher's liveness, including a future one, including a migration or
a hand-run `psql`.

The second half is an observation that collapses the problem: **the armed set is tiny and
self-clearing.** 181 marker rows today, 4 of them launchable, and `claimAutoStart` deletes
the row on launch. Everything in the current design — `listArmedDependentsOf`'s recursive
dependents walk, the transitive fan-out, the two-case transition logic — exists only to
avoid re-checking that set. Re-checking it costs ~40 ms. Delete the machinery.

## Fix-ladder placement

Rung 1 (inexpressible). The wrong thing today is "a mutation that changes derived
blocking without telling the launcher". After this change there is nothing to tell, so the
mistake has no spelling. The alternative considered — keeping the hand-emitted event but
expanding the recorded set to the transitive-dependents closure — reaches rung 2 at best:
it requires every one of the ~16 `emitStatusChangeIfChanged` call sites to snapshot
*before* the write (they currently snapshot the single written task and emit after), it
puts a recursive-CTE-backed status read per closure member inside interactive transactions
like `markConversationClosed`, and its guarantee still stops at the TypeScript boundary.
Rejected.

Also rejected: a `DerivedTable` rollup for launchability (`bool_or` over a transitive
closure is not incrementally maintainable — fan-in means an edge deletion may or may not
remove an ancestor — so each write forces the same re-walk, at the price of a third
hand-written copy of the blocking rule inside opaque SQL, and rollups are change-feed
exempt so nothing would learn a row appeared); emitting `graphile_worker.add_job` from a
trigger (banned by the `jobs:no-raw-addjob` check, which greps inside string literals
precisely for this, and it would bypass `queueNameFor`, the zod input parse and the dedup
namespacing); and a live-state resource carrying the launchable set (its only server-side
hook, `onResourcePush`, fires **only when a browser is subscribed**, and the set is
neither a window nor a point selector, so it is exactly the unbounded shape
`research/2026-07-18-global-bounded-working-set-resource-contract.md` closed).

## The change

### 1. New primitive: `TableChangeSubscriber`

`plugins/database/plugins/change-feed/server/internal/subscribers.ts`

```ts
TableChangeSubscriber({
  name: string,                    // stable id, for logs
  tables: readonly string[],       // base tables this consumer cares about
  onChange(change: { table, op, ids }): void,   // synchronous; the contributor owns async
})
```

Built with `defineServerContribution` (`plugins/framework/plugins/server-core/core/contributions.ts:18`).
Resolve `tables` into a `Map<string, Subscriber[]>` on first dispatch (contributions are
complete before `onReadyBlocking`). `dispatchTableChange(change)` iterates the matches and
calls each inside a try/catch that logs to the change-feed sink — a throwing subscriber
must be loud but must never kill the listener, matching the listener's existing posture on
a malformed payload.

`onChange` returns `void` deliberately: the contributor owns the promise (`void
runTracked(...)` from `@plugins/infra/plugins/runtime-profiler/core`), so change-feed
gains no dependency on jobs or on the profiler, and stays the thin registry that
`derived-tables/CLAUDE.md` already describes for its own contribution
(*"the DB-infra change-feed must NOT import a feature-specific table name"*). It names no
table and no consumer, so collection-consumer separation holds.

### 2. Wire it

`plugins/database/plugins/change-feed/server/internal/route-change.ts` — one call to
`dispatchTableChange(change)` after the existing view fan-out. Export
`TableChangeSubscriber` from `change-feed/server/index.ts`; widen the barrel description
and `CLAUDE.md` to say there are now two routing targets.

This placement is what buys catch-up for free: `routeChange` is called by **both** the live
LISTEN consumer and `live-state-snapshot`'s changelog replay, so "catch-up ≡ replay the
missed rows as if they just arrived" extends to subscribers with no extra code.

### 3. The ready query

`plugins/tasks/plugins/tasks-core/server/internal/queries/tasks.ts` — add
`listLaunchReadyTaskIds(exec)`:

```sql
SELECT a.parent_id
  FROM tasks_ext_auto_start a
  JOIN tasks t ON t.id = a.parent_id
  LEFT JOIN task_blocking_v b ON b.task_id = a.parent_id
 WHERE t.dropped_at IS NULL
   AND t.held_at   IS NULL
   AND NOT COALESCE(b.has_blocking_dep, false)
   AND NOT EXISTS (SELECT 1 FROM attempts at WHERE at.task_id = t.id)
```

It reads `task_blocking_v`, the shared blocking definition (`views.ts`), so this adds **no
new spelling of the rule** — the invariant `views.ts` opens with (one rule, interpolated,
never mirrored) is preserved. Measured on the live main DB: 4189 tasks, 1468 edges, 181
markers → **38 ms, 4 rows**.

**Delete `listArmedDependentsOf`** and its export from `tasks-core/server/index.ts`.

### 4. Collapse the launcher

`plugins/conversations/server/internal/auto-start-jobs.ts` — replace
`maybeLaunchDependentsJob` with:

```ts
export const launchSweepJob = defineJob({
  name: "tasks.launch-sweep",
  input: z.object({ cause: z.string().default("db-change") }),
  event: z.never(),
  dedup: "singleton",           // N wake-ups upsert onto ONE pending graphile row
  run: async ({ input: { cause } }) => {
    if (!isMain()) return;
    for (const taskId of await listLaunchReadyTaskIds(db)) {
      await maybeLaunchTaskJob.enqueue({ taskId, cause });
    }
  },
});
```

Give `maybeLaunchTaskJob` `dedup: { key: (i) => i.taskId }` so repeat wake-ups for one
task collapse instead of stacking rows. **Its body does not change** — every gate stays,
and `claimAutoStart` stays the exactly-once CAS, which is what makes an over-broad sweep
free of consequence. Replace the two-case comment block with the case-(a)/(b) proof above.

Note a property that falls out: notifications are delivered at **commit**, so the sweep
can only ever read committed state. The transient zero-blocker intermediate that
`withTaskStatusBatch` exists to hide from auto-start
(`deps-tree-move.ts:14`, `handle-deps-move.ts:16`) becomes unreachable by construction
rather than by careful batching.

### 5. The contribution

`plugins/conversations/server/index.ts` — drop the
`Trigger({ on: taskStatusChanged, do: maybeLaunchDependentsJob })` contribution and the
job's registration; add:

```ts
TableChangeSubscriber({
  name: "tasks.launch-sweep",
  tables: ["task_dependencies", "tasks", "tasks_ext_auto_start",
           "attempts", "conversations", "pushes"],
  onChange: () => {
    if (!isMain()) return;
    void runTracked("tasks.launch-sweep", () => launchSweepJob.enqueue({}));
  },
})
```

All six tables are needed: the first three change the graph and the armed set, the last
three flip a dependency to `done`. Gating on `isMain()` keeps every worktree fork's
backend at one function call — the forks inherit the markers at fork time and must not act
on them.

### 6. Boot net

Same plugin's `onReady`: `if (isMain()) void runTracked("tasks.launch-sweep-boot", () =>
launchSweepJob.enqueue({ cause: "boot" }))`.

NOTIFY is post-commit, so a crash in the window between commit and enqueue drops that one
wake-up; the boot sweep closes it. Deliberately not a `defineWarmup` — warmup's contract
is "an optimization, never a correctness dependency", and this is the correctness backstop.
This is also the step that unsticks the four tasks stuck today.

### 7. Simplify arming

`plugins/tasks/server/internal/arm-auto-start.ts` — with `tasks_ext_auto_start` subscribed,
the marker insert wakes the sweep by itself, so the `hasBlockingDep` check and the
conditional enqueue are no longer the correctness path. Keep the direct enqueue only as a
latency optimization (skipping one NOTIFY round-trip) and say so in the comment; drop the
`hasBlockingDep` branch either way.

## What this deletes

`listArmedDependentsOf` (recursive CTE), `maybeLaunchDependentsJob` (both branches and the
transition reasoning), the `taskStatusChanged` trigger contribution in `conversations`, and
`armTaskAutoStart`'s blocking check. Net deletion in the domain; one new ~60-line primitive
in `change-feed`.

## Cost

One sweep = one `listLaunchReadyTaskIds` (38 ms measured) plus one enqueue per ready task.
That is roughly the cost of a **single** existing `maybeLaunchTaskJob` gate check today
(`getTask` reads `tasks_v` and `hasBlockingDep` reads `task_blocking_v` — the same
recursive walk), and it replaces the whole per-dependent fan-out, which paid that cost once
per armed dependent. Bursts collapse onto one pending row via singleton dedup, so
steady-state cost is bounded by sweep execution rate, not write volume.

The new coupling worth watching after deploy: conversation/push churn (~1k writes/day,
bursty during active agent work) now enqueues sweeps. Check Debug → Queue health for
`tasks.launch-sweep` backlog. If it proves hot, the narrowing is to scope the ancestor walk
to the armed set rather than materializing `task_blocking_v` whole — but do not do that
pre-emptively, and do not do it by writing a second copy of `depIsBlocking`.

## Consequence on first deploy — read this before building

The boot sweep will launch **every** armed-and-launchable task, which today is four:

| task | armed | title |
|---|---|---|
| `task-1786980794589-tv67jc` | 2026-08-17 | Clicking "Serve sonata" opens a run labelled main… |
| `task-1786981110324-4c14re` | 2026-08-17 | RuntimeName in boundaries/core/types.ts is dead… |
| `task-1783420059574-nzprnm` | 2026-07-07 | Sweep scopedMembership onto remaining eligible keyed scans |
| `task-1777990028284-mue8h1` | 2026-05-05 | Verify packages auto-doc consistency |

The two older ones are stale intent. There is deliberately **no age cutoff in the code** —
"armed and launchable means launch" is the whole rule, and a one-off exception would be the
kind of special case this change exists to remove. If those two should not run, disarm them
first (task detail → Prompt card → auto-start "Off", i.e. `DELETE /api/tasks/:id/auto-start`).

## Out of scope / follow-ups

1. **`queue.task-status-rerank` has the same bug** and this change does not fix it: a
   table-change subscriber carries no before/after, and rerank genuinely needs the
   transition. The right fix is to stop needing an event for it — persist `was_blocked` on
   `conversations_ext_queue` (the table the job already writes), rebind the job to the same
   subscriber, and have it compare stored against current per live ranked conversation.
   That is one column, and it is a higher rung than any event: the transition becomes
   derivable from persisted state. Separate task — it is a cosmetic ordering bug, while the
   launcher is stuck today.
2. **~177 markers sit on dropped tasks.** Inert now (the launcher bails on dropped), but a
   marker survives a restore, so un-dropping a task would surprise-launch it. Proposal:
   dropping a task clears its marker, plus a one-time purge. Separate task — it is a
   behaviour change, not a bug fix.
3. `TableChangeSubscriber` stays inside `change-feed` for now. Split it into its own plugin
   only if a third consumer arrives *and* the dispatch grows policy (id filtering,
   coalescing windows).

## Verification

1. `./equin build` (background), then `./equin check`.
2. **Unit, DB-backed**, in the shape `plugins/database/plugins/change-feed/.../listener.test.ts`
   already establishes (`createTestDb`, real Postgres), placed beside the source and run with
   `./equin test plugins/database/plugins/change-feed`: seed `Z → Y → X` with X
   blocking and Z armed; delete the `Y → X` edge **over a raw connection, not through any
   TypeScript mutation**; assert the subscriber fired and `tasks.launch-sweep` was enqueued.
   The raw-connection part is the assertion that matters — it proves no call site
   participates.
3. **Query-level**, beside `plugins/tasks/server/internal/deps-tree-move.test.ts`:
   `listLaunchReadyTaskIds` returns exactly the armed ∧ unblocked ∧ undropped ∧ unheld ∧
   attempt-less set — one fixture per excluded reason.
4. **Live end-to-end** on the worktree deploy: file two chained tasks with `add_task`
   (autostart on), confirm the second is `blocked` and armed via `query_db`, then detach the
   dependency in the deps tree UI and confirm within seconds that its `tasks_ext_auto_start`
   row is gone and an attempt exists. Re-run the same check for a drag-move and for
   insert-between.
5. **Regression guard on main after deploy:** `query_db` the ready-set query — it should be
   empty in steady state. A non-empty result that persists means a sweep is not firing.
