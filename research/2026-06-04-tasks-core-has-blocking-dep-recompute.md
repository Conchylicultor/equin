# Eliminate the `tasks_v.has_blocking_dep` recompute

## Context

After indexing the view correlated subqueries (merged:
`research/2026-06-04-global-conversations-live-cascade-amplification.md`, commit
`d02ea98cd`), the dominant remaining cost in the `notifyConversationsChanged`
cascade is the `has_blocking_dep` clause of the `tasks_v` view
(`plugins/tasks-core/server/internal/schema.ts:102-111`). It re-runs on every
poller tick (≤1 Hz) and every conversation mutation, via the `tasks` loader.

`EXPLAIN ANALYZE SELECT * FROM tasks_v` on the main `singularity` DB (2250 tasks,
2076 attempts, 2221 conversations, 1585 pushes, 408 live deps) confirms and
*extends* the research finding — two compounding problems:

1. **Double evaluation.** `facts.hasBlockingDep` is referenced **twice** in the
   status `CASE` (`schema.ts:123` and `:129`). The `task_facts` CTE inlines, so
   the planner expands the expensive subquery at *both* sites — `SubPlan 62`
   (57 ms) + `SubPlan 110` (71 ms) = **~128 ms of the ~157 ms** total `tasks_v`
   time.
2. **O(deps × all-history-attempts) anti-join.** Each evaluation is a
   `Nested Loop Anti Join` that **re-derives `attempts_v` status inside the
   correlated subquery** (the full 6-subplan `attempts_v` CASE) and joins it
   against every non-dropped dependency — `Rows Removed by Join Filter:
   1,310,531` (1635 deps × ~802 materialized completed-attempt rows). Base-table
   indexes can't help: the join is over the *derived* `attempts_v` subquery, not
   a physical table.

Intended outcome: make a genuine status flip cheap by **computing each task's
"has a completed attempt" exactly once** and reusing that precomputed boolean for
both the task's own `has_completed` and its dependencies' blocking check — with
**zero behavior change** (the view returns identical rows).

## Approach — precompute per-task completion in a CTE, reuse it

The redundancy is structural: `has_blocking_dep(T)` asks "does any non-dropped
dependency of T lack a completed attempt?" — i.e. it re-derives, per dependency,
the very `has_completed` boolean the view *already computes* for that dependency
row. The fix is to compute completion once per task and join to it.

Restructure the `tasks_v` definition (`schema.ts:75-153`) to add a first CTE:

```sql
WITH task_completed AS (                       -- one pass over all tasks
  SELECT t.id AS task_id,
         EXISTS (SELECT 1 FROM attempts_v a
                  WHERE a.task_id = t.id AND a.status = 'completed') AS has_completed
  FROM tasks t
),
task_facts AS (
  SELECT t.id,
         tc.has_completed,                     -- reuse, was a correlated EXISTS
         ... has_attempt, has_active, has_waiting, min_completed_push_at ...,
         EXISTS (                              -- cheap hash join, no re-derivation
           SELECT 1 FROM task_dependencies td
             JOIN tasks dep          ON dep.id = td.depends_on_task_id
             JOIN task_completed dtc ON dtc.task_id = dep.id
            WHERE td.task_id = t.id
              AND dep.dropped_at IS NULL
              AND NOT dtc.has_completed
         ) AS has_blocking_dep
  FROM tasks t
  JOIN task_completed tc ON tc.task_id = t.id
)
SELECT ... CASE using task_facts.has_completed / has_blocking_dep ...
```

Why this is fast and safe:

- **Single computation.** `task_completed` is referenced multiple times
  (`hasCompleted` join + the `has_blocking_dep` join, the latter expanded twice
  by the CASE), so PostgreSQL 12+ **auto-materializes** it — the expensive
  `attempts_v`-derivation runs **once** for all 2250 tasks (~3.7 ms), not per
  dependency and not twice. **`MATERIALIZED` keyword not needed** (and drizzle
  0.36.4 can't emit it — only materialized *views*). Verified: the plain-CTE plan
  is identical to the explicit-`MATERIALIZED` plan.
- **`has_blocking_dep` becomes a hash join** over 465 deps + the materialized
  per-task booleans (~1.3 ms), even when expanded twice by the CASE.
- **Result-identical.** Verified on main: current vs. rewritten `has_blocking_dep`
  yield the **same 59 true task ids**, byte-for-byte.

### Measured impact (main `singularity` DB, `EXPLAIN ANALYZE`)

| | `has_completed` + `has_blocking_dep` portion |
|---|---|
| Current | ~157 ms (128 ms in the two `has_blocking_dep` anti-joins) |
| Rewritten | **~6 ms** (3.7 ms materialize + ~1.3 ms join) |

The full `tasks_v` (which also computes `has_active`, `has_waiting`,
`min_completed_push_at`) should drop from ~157 ms toward ~35–40 ms.

## Files

- **Edit** `plugins/tasks-core/server/internal/schema.ts` — the `tasks` /
  `tasks_v` `pgView` definition (lines 75-153):
  - Add a `task_completed` CTE via `qb.$with("task_completed").as(...)` (mirrors
    the existing `qb.$with("task_facts")` / `qb.$with("attempt_facts")` style at
    `schema.ts:16,76`). Its body is the existing `has_completed` EXISTS
    (`schema.ts:83-86`).
  - In the `task_facts` CTE: `innerJoin` `task_completed` on `task_id` and select
    `hasCompleted: taskCompleted.hasCompleted` (replacing the inline EXISTS at
    `schema.ts:83-86`); rewrite `hasBlockingDep` (`schema.ts:102-111`) as a raw
    `sql` EXISTS that adds `JOIN ${taskCompleted} dtc ON dtc.task_id = dep.id` and
    replaces the inner `NOT EXISTS (SELECT … attempts_v …)` with `NOT
    dtc.has_completed`.
  - Pass both CTEs to the final builder: `qb.with(taskCompleted, taskFacts)
    .select(...)`. drizzle's `.with()` is variadic; `task_completed` declared
    first so `task_facts` can reference it. The status `CASE`, `active`,
    `finishedAt`, and `dependencies` selects are unchanged.
- Then `./equin build --migration-name tasks-v-precompute-completion`
  (regenerates the `DROP VIEW`/`CREATE VIEW "tasks_v"` migration under
  `plugins/database/plugins/migrations/data/` and applies it on restart). **Never**
  run `drizzle-kit generate` or the migration runner manually.

No client, protocol, or consumer changes. No base-table or index changes.

### Out of scope (no change needed)

- **Standalone `hasBlockingDep()` / `listBlockingDepIds()`**
  (`plugins/tasks-core/server/internal/queries/tasks.ts:35,80`): called per *single*
  task by the auto-start engine — not the whole-list cascade — so they carry no
  amplification. They remain semantically identical to the view (the
  `schema.ts`-mirror comment at `queries/tasks.ts:31-34` still holds). Leave as-is.
- **Active/archive view split** and **per-row incremental notify** (research
  alternatives): more invasive (touch view schema + consumers / wire format). This
  rewrite reaches O(active)-like cost for the blocking check while staying
  contained to one view definition, so they stay deferred.

## Implementation risk to watch

drizzle has no existing precedent in this repo for a `$with` CTE that references
*another* `$with` CTE (the only two `$with` uses are in this same file and are
self-contained). The one thing to verify at build time is that drizzle emits
`with "task_completed" as (…), "task_facts" as (…) select …` with the reference
resolving — inspect the generated migration SQL before it applies. If drizzle
mis-scopes the cross-CTE reference, fall back to writing the `tasks_v` body as a
single raw `sql` template (the view is already heavily raw-`sql`), preserving the
same two-CTE structure.

## Verification

1. **Baseline** (already captured): `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM
   tasks_v;` via `query_db` on `database: "singularity"` — two `has_blocking_dep`
   subplans (~57 ms + ~71 ms), `Rows Removed by Join Filter: ~1.31M` each.
2. **Build**: `./equin build --migration-name tasks-v-precompute-completion`;
   open the generated `…__tasks_v_precompute_completion.sql` and confirm the
   `CREATE VIEW "tasks_v"` body declares both CTEs and that `has_blocking_dep`
   references `task_completed`. Confirm server restarts cleanly (no view-dependency
   errors).
3. **Correctness — result identity** (`query_db`): compare the live worktree view
   to the old definition's blocking set. The diff was already verified on main:
   both produce the **same 59 `has_blocking_dep = true` task ids**. Re-run a row
   count of each `tasks_v.status` value before/after and confirm it is unchanged.
4. **Post-rewrite plan** (`query_db`): re-run `EXPLAIN (ANALYZE, BUFFERS) SELECT *
   FROM tasks_v;` — confirm `task_completed` shows `CTE Scan … Storage: Memory`
   (auto-materialized), `has_blocking_dep` is now a `Hash Join` (no
   `Nested Loop Anti Join`, no million-row `Rows Removed by Join Filter`), and
   total time dropped to ~35–40 ms.
5. **Profiler**: `POST /api/debug/profiling/runtime/reset`, drive a conversation
   flipping `working ↔ waiting`, then `get_runtime_profile` (`kind: "loader"`):
   the `tasks` loader `avgMs` / `maxMs` should be markedly lower than baseline.
6. **No behavior change**: task tree statuses (esp. `blocked` and `done`), the
   dependency chips, and auto-start gating all render/behave exactly as before.
   Spot-check that completing a blocking dependency's attempt unblocks the
   dependent task live.
