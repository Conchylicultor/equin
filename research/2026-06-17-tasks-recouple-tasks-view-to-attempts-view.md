# Re-couple `tasks_v` → `attempts_v`: define attempt status exactly once

## Context

`attempts_v` and `tasks_v` (both in
`plugins/tasks/plugins/tasks-core/server/internal/views.ts`) each derive every
attempt's `status` / `active` from the base tables. They share the TypeScript
helpers `attemptFactCtes` / `attemptStatusSql` / `attemptActiveSql`, but at
**query time** both views still independently rebuild the same `conv_agg` +
`push_agg` grouped CTEs and re-apply the same status/active CASE expressions over
`_conversations` / `pushes` / `_attempts`. `tasks_v` does not read `attempts_v`;
it re-derives attempt status from scratch.

This duplication exists for one historical reason: a view-on-view dependency
used to be un-migratable under drizzle-kit 0.28.1, which emitted `DROP VIEW` in
alphabetical (snapshot) order with no topological sort, so Postgres rejected the
out-of-order drop when `tasks_v` depended on `attempts_v`.

**That constraint is now gone.** Plain views are derived code (commit `1f9e1d9`):
they are declared via the `View` server contribution + rebuilt from source on
every boot by `rebuildDerivedViews`, in dependency order, and are no longer in
the migration chain. (Even if a migration *did* touch them, the generator's
`reorderViewStatements` now topo-orders any view DROP/CREATE it emits.) The
`View` contribution already accepts `dependsOn: ["attempts_v"]`, and
`rebuildDerivedViews` drops in reverse-topo / creates in forward-topo order.

So `tasks_v` can read `attempts_v` directly again, defining attempt status
exactly once and removing the duplicated derivation. The 37×/50× buffer-read win
from the set-based rewrite (commit `b5837810b`) must be preserved.

## Why perf is preserved

Plain (non-materialized) views are inlined by the Postgres planner as rewrite
rules; the non-recursive `conv_agg` / `push_agg` CTEs inside `attempts_v` are
each referenced once, so PG12+ inlines them too. When `tasks_v`'s
`task_attempt_agg` CTE does `SELECT task_id, bool_or(status='completed'),
bool_or(active) FROM attempts_v GROUP BY task_id`, the planner folds `attempts_v`
in and produces the *same* grouped-scan-then-hash-join plan the current inline
`attempt_status` CTE produces. The only nominal difference is that `attempts_v`
also projects all `_attempts` columns + `finished_at`; those are unreferenced by
the outer aggregate and pruned (or, for `finished_at`, a per-row CASE over ~2k
rows — negligible, zero extra buffer reads). The 37× win came from killing
correlated subqueries; both the old-inline and new-via-view forms use the same
grouped scans, so buffers are preserved. **This must be confirmed with
`EXPLAIN (ANALYZE, BUFFERS)` (see Verification) — it is the load-bearing risk.**

## Changes

### 1. `plugins/tasks/plugins/tasks-core/server/internal/views.ts`

**`attempts_v`** — inline the now single-use helpers. Move the `conv_agg` /
`push_agg` CTE construction and the `status` / `active` CASE expressions directly
into the `attempts` view body (they were only factored out to share with
`tasks_v`). `finished_at` already lives inline here. Delete the standalone
`attemptFactCtes`, `attemptStatusSql`, `attemptActiveSql` functions and the
`AttemptFacts` type. Net: `attempts_v` becomes the **single** definition of
per-attempt status/active.

**`tasks_v`** — stop calling `attemptFactCtes`. Replace the `attempt_status` CTE
(which re-derived status from base tables) with a `task_attempt_agg` that
aggregates `attempts_v` directly:

```ts
import { attempts, ... } from "./..."; // `attempts` (= attempts_v) already in-module

const attemptAgg = qb.$with("task_attempt_agg").as(
  qb
    .select({
      taskId: attempts.taskId,
      hasAttempt: sql<boolean>`true`.as("has_attempt"),
      hasCompleted: sql<boolean>`bool_or(${attempts.status} = 'completed')`.as("has_completed"),
      hasActive: sql<boolean>`bool_or(${attempts.active})`.as("has_active"),
    })
    .from(attempts)
    .groupBy(attempts.taskId),
);
```

This removes the `attempt_status` CTE and the `convAgg` / `pushAgg` from
`tasks_v`'s `.with(...)` list (they were only feeding `attempt_status`). The
remaining CTEs — `task_waiting`, `task_completed_push`, `task_completed`,
`task_blocking`, `task_deps` — and the final SELECT are **unchanged** (they read
base tables, not attempt status). Update the file's header comment to state the
views are now coupled and attempt status is defined once in `attempts_v`.

> Note: `task_waiting` and `task_completed_push` derive their own facts straight
> from `_conversations` / `pushes` (not from attempt status), so they stay as-is
> — only the attempt status/active aggregate moves to read `attempts_v`.

### 2. `plugins/tasks/plugins/tasks-core/server/index.ts` (line ~173)

```ts
View({ view: tasks, dependsOn: ["attempts_v"] }),
```

`rebuildDerivedViews` will then create `attempts_v` before `tasks_v` and drop in
reverse order. (`conversations_v` stays independent.)

### Not changed

- `queries/tasks.ts` `hasBlockingDep` / `listBlockingDepIds` already query the
  `attempts` view via raw SQL (`SELECT 1 FROM attempts_v a WHERE … status =
  'completed'`) — repository-layer helpers, not the view definition. No change.
- `conversations/.../queue/server/internal/pinned.ts` references `attempts_v` by
  name string — unaffected.
- `conversations_v` — independent, base-table only. Unchanged.
- All consumers of `tasks` / `attempts` view objects (`resources.ts`,
  `status-emit.ts`, `queries/tasks.ts`) — the view *output columns* are
  identical, so no consumer changes.

## Critical files

- `plugins/tasks/plugins/tasks-core/server/internal/views.ts` — the rewrite.
- `plugins/tasks/plugins/tasks-core/server/index.ts` — add `dependsOn`.
- (read-only ref) `plugins/database/plugins/derived-views/{server,core}/internal/`
  — `View`, `rebuildDerivedViews`, `topoSortViews`.

## Verification

1. `./equin build` — regenerates nothing in the migration chain (views are
   derived code); server reboot runs `rebuildDerivedViews`, which must succeed
   (it throws loudly on a missing `dependsOn` name or cycle). A clean boot proves
   the dependency ordering works.

2. **Row-for-row equivalence** — before building, capture the current output;
   after, compare. Via the `query_db` MCP tool against the worktree DB (a fork of
   `singularity`, so it carries real data):
   - Before: `SELECT md5(string_agg(t::text, '|' ORDER BY id)) FROM tasks_v t;`
   - After rebuild: same query; the md5 must match. (Also spot-check
     `SELECT status, count(*) FROM tasks_v GROUP BY status` before/after.)

3. **Buffer-read parity (the load-bearing check)** — `query_db`:
   `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM tasks_v;` after the change. Confirm
   the plan is grouped scans + hash joins (no correlated SubPlan / per-row
   re-evaluation of attempt status) and shared+read buffers are in the same
   order of magnitude as the pre-change `tasks_v` (~700–1.3k buffers on the main
   DB, NOT the 36k of the old correlated form). Run the same EXPLAIN against the
   current `tasks_v` first to get the exact baseline on this DB to compare.

4. `./equin check` — `type-check` and boundary checks pass.

5. Sanity-check the app at `http://att-1781701923-56ck.localhost:9000` — the
   Tasks list renders with correct statuses (done/in_progress/blocked/etc.).

If buffer reads regress in step 3, do not ship: investigate whether PG is failing
to inline (e.g. unexpected materialization) and either keep the base-table
derivation or add a targeted fix.
