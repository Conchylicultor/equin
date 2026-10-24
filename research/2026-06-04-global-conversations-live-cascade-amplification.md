# Tame the `conversationsLiveResource` notify cascade

## Context

Every `notifyConversationsChanged()` (fired by the 1 Hz conversation poller and by
every conversation mutation) cascades through the live-state `dependsOn` graph and
re-runs the loaders of its downstream resources. The runtime profiler flagged this as
the dominant source of repeated DB load during active agent work. This was surfaced as
a follow-up while bounding the infra poller query
(`research/2026-06-04-conversations-infra-poller-query-scope.md`).

**Investigation reframed the problem in three important ways:**

1. **The cascade is 5 resources, not ~15, and `reorder.*` is not in it.** The complete
   fan-out from `conversationsLiveResource` is exactly:

   ```
   conversationsLiveResource (conversations, push)            ← trigger
     ├─ attemptsResource (attempts, push)                     dependsOn conversations + pushes
     │    └─ tasksResource (tasks, push)                      dependsOn attempts
     ├─ agentLaunchesResource (agent-launches, push)          dependsOn conversations
     └─ queueRanksResource (queue-ranks, push)                dependsOn conversations
   ```

   `reorderPrefsResource` / `reorderGroupsResource` have **no `dependsOn`** — their high
   profiler call-count (~318) is per-slot subscription churn (one loader run per slot on
   subscribe / HTTP fallback), completely unrelated to this cascade. The "~15 downstream
   resources" figure conflated the two.

2. **None of the 5 edges are spurious — they are all semantically real.** `tasks` and
   `attempts` in the loaders are Postgres **views** (`tasks_v`, `attempts_v`,
   `plugins/tasks-core/server/internal/schema.ts:15,75`). Their `status` column is *computed*
   by correlated subqueries over conversations/attempts/pushes — there is no stored status
   column (`status-emit.ts:9`). A conversation flipping `waiting↔working` genuinely changes
   `tasks_v.status` (`has_waiting`/`has_active`) and the `attempts_v` status + embedded
   `ConversationSummary`. So **we cannot fix this by deleting dependency edges** — every
   downstream resource really does reflect conversation state.

3. **The dominant cost is the view recompute, not redundant fan-out.** A single
   live-conversation status flip forces an **O(all-history) recompute of `attempts_v` and
   `tasks_v`** — correlated subqueries over the full attempts/conversations/pushes tables —
   re-run on every poller tick (≤1 Hz) and every mutation. That recompute, on the genuine
   status-flip path that dominates active agent work, is the load to attack.

Intended outcome: make a genuine status flip *cheap* by indexing the columns the views
correlate on, turning each per-tick recompute from O(all-history) toward O(active) — with
**zero behavior change** (indexes change query plans, not results).

## Scope

**This plan does B (indexes) only** — the load-bearing fix for the reported DB load,
lowest blast radius (one plugin, no protocol change, no primitive touched). A separate
diff-and-prune improvement to the live-state primitive was considered and **deferred** (see
below): it does not help the dominant status-flip path and its benefit is marginal once the
recompute is cheap.

## Approach — index the view correlated subqueries

A genuine status flip's cost is the per-row correlated subqueries in `attempts_v`/`tasks_v`
scanning all history. The hot correlation columns are **missing indexes** — `tables.ts`
declares indexes on tasks/pushes but none on `conversations.attempt_id` or
`attempts.task_id` (`plugins/tasks-core/server/internal/tables.ts:52,80,100-102`):

- **`attempts_v`** (`schema.ts:15`) correlates on `conversations.attempt_id` in `has_conv`,
  `has_live_conv` (`status NOT IN ('gone','done')`), and `max_ended_at`; and on
  `pushes.attempt_id` (already covered by `pushes_attempt_id_idx`). → add
  **`conversations(attempt_id, status)`** (composite covers the status-filtered subqueries
  too).
- **`tasks_v`** (`schema.ts:75`) correlates on `attempts.task_id` in `has_attempt` and in the
  `attempts_v` re-derivation per task, joins `conversations` by `attempt_id` for `has_waiting`,
  and joins `pushes.attempt_id` (already indexed). → add **`attempts(task_id)`**.

Implementation:

1. **`EXPLAIN ANALYZE` first** (via the `query_db` MCP tool) on
   `SELECT * FROM tasks_v` and `SELECT * FROM attempts_v`, capturing the current plan
   (expect seq scans / per-row subplans on `conversations` and `attempts`). This is the
   baseline and confirms the indexes target the real bottleneck.
2. Add the indexes as Drizzle `index(...)` entries in `tables.ts` on the base-table builders
   (`_conversations`, `_attempts`) — indexes live on tables, not views; the views benefit
   because their subqueries hit those base tables.
3. `./equin build` (generates + applies the migration; first build after a schema
   change needs `--migration-name`, e.g. `view-correlation-indexes`). **Never** run
   `drizzle-kit generate` or the migration runner manually.
4. Re-run `EXPLAIN ANALYZE` and **keep only the indexes the planner actually uses.** At
   ~2k rows Postgres may still prefer a seq scan for some subqueries — if so, drop that index
   (it's a no-op, not a regression) and note that the per-row subquery cost is dominated by
   something else worth a follow-up.

### Why this is low-risk

- **Correctness:** none at stake — an index cannot change what the views return, only plan
  speed. No functional surface to regress.
- **Migration:** small tables → plain `CREATE INDEX` completes in ms; no `CONCURRENTLY`
  needed. Standard hash-tracked migration via `./equin build`.
- **Reversible:** drop the index; no data transformation.
- **Cost:** two narrow indexes add negligible write overhead on non-write-hot tables.

### Deferred (explicitly out of scope here)

- **Diff-and-prune in the live-state primitive** (`server-core/core/resources.ts`
  `flushNotifies`): cache last-pushed value, skip re-push + downstream cascade when a
  recomputed value is byte-identical. Correct and clean, but it does **not** help a genuine
  status flip (the value really changes) and its DB benefit is marginal once indexes make
  recomputes cheap; its residual value is suppressing redundant *client* re-render storms on
  no-op/title-only ticks. Touches a primitive used by every resource (largest blast radius)
  and would also require fixing the queue loader's `validatePin()` write side-effect plus a
  poller pin-advancement gap. Revisit as its own change only if client re-render churn proves
  felt after indexing.
- **Active/archive view split** (recompute only the ~31 live rows per tick): structural
  O(active), but touches view schema + consumers.
- **Per-row incremental notify** (one row changed → push one row, not the whole list):
  requires a delta wire format + client cache merge; poor fit for the current whole-list
  level-state protocol. This is the only thing that would make a genuine status flip push
  less than the full list.
- **Time-based debounce of `notify`:** the poller is already 1 Hz (ticks ≫ the microtask
  window), so a trailing debounce wouldn't coalesce the steady drip; microtask coalescing +
  `withNotifyBatch` already collapse same-tick bursts. Not recommended.

## Files

- **Edit** `plugins/tasks-core/server/internal/tables.ts` — add
  `index("conversations_attempt_id_status_idx").on(t.attemptId, t.status)` on the
  conversations table and `index("attempts_task_id_idx").on(t.taskId)` on the attempts table
  (EXPLAIN-guided; keep only what the planner uses), then `./equin build`.

No code/protocol changes; no client edits.

## Verification

1. **Baseline:** `EXPLAIN ANALYZE SELECT * FROM tasks_v;` and `... attempts_v;` via
   `query_db` — record total time and confirm seq scans / per-row subplans on `conversations`
   / `attempts`.
2. `./equin build` with `--migration-name view-correlation-indexes`. Confirm the
   migration applied (server restart, no errors).
3. **Post-index plan:** re-run both `EXPLAIN ANALYZE` — confirm the targeted subqueries now
   use index scans and total time dropped. Drop any index left unused.
4. **Profiler:** reset the runtime profiler (`POST /api/debug/profiling/runtime/reset`), drive
   real activity (a conversation flipping `working↔waiting`), then `get_runtime_profile`
   (`kind: "db"` or `loader`): the `tasks` / `attempts` loader `avgMs`/`maxMs` should be
   markedly lower than the pre-index baseline.
5. **No behavior change:** task tree statuses, attempt rows, agent-launch latest-status, and
   queue ordering all render exactly as before (indexes are result-preserving). Spot-check a
   status flip and a title change propagate live as today.
