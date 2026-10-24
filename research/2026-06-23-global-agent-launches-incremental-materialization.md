# Hand-rolled incremental materialization for `agent-launches` (pilot)

> **Category:** global (database/change-feed, database/derived-tables [new], conversations/agents, framework/resource-runtime)
> **Status:** design / plan (no code yet)
> **Parent research:** [`2026-06-19-global-live-state-sync-engine.md`](./2026-06-19-global-live-state-sync-engine.md) (L3/IVM rung, §6) and [`2026-06-22-global-live-state-l2-persisted-materialization.md`](./2026-06-22-global-live-state-l2-persisted-materialization.md) (which rejected pg_ivm as a base).

## Context

A few live-state aggregations have an *irreducible per-recompute cost even after scoping* — the cost is the query itself, not how often it runs. The original ask was to pilot **pg_ivm** (incrementally-maintained materialized views) for these. Two findings killed the literal pg_ivm path:

1. **pg_ivm is not available.** The embedded cluster is `@embedded-postgres/darwin-arm64@18.3.0-beta.17`. Confirmed on disk: it ships 62 contrib extensions but **no `pg_ivm`** (`.control` / `.dylib` both absent). pg_ivm is third-party and its stable releases target PG 16/17 — a PG18-beta build is of uncertain feasibility, for 4 platforms. The prior L2 doc (§2) already evaluated and rejected it on exactly this basis.
2. **Fit/cost mismatch.** From a live `get_runtime_profile` of `singularity` (using `workMs`, which strips connection-gate waits): the resources that *fit* pg_ivm's restricted SQL subset (`conversations_v`, `conversations-gone-stats`) are already cheap (~140–230 ms), while the genuinely expensive DB loaders — `agent-launches` (~4.9 s) and `attempts` (~4.1 s) — are TS-shaped multi-query joins pg_ivm **cannot** express.

**Decision (user):** keep the IVM *idea*, drop the extension. Build a **trigger-maintained materialized rollup table** ("hand-rolled pg_ivm") for **one** genuinely expensive aggregate: `agent-launches`. It needs no extension, is maintained transactionally (so it also catches out-of-process writes, matching the change-feed philosophy), and works on PG18 today.

### Why `agent-launches` is expensive

`agentLaunchesResource` (`plugins/conversations/plugins/agents/server/internal/resources.ts:30-92`) returns one `AgentLaunchWithStatus` per launch, each decorated with `latestConversation` = the latest (by `created_at` desc) **non-system** conversation for the launch's `taskId`. The loader computes this by calling `listConversationsForDisplay(taskIds?)` — which scans `conversations_v` (conversations ⋈ attempts, `views.ts:230`) ordered by `created_at desc` — and rolling up "first row per `taskId`" in JS (`resources.ts:77-82`). Every recompute re-derives the whole per-task latest map.

The materialized unit is therefore: **the latest non-system conversation per task.** Maintain it incrementally; the loader becomes an indexed two-table join.

## Design

### 1. New derived table `task_latest_conversation`

```sql
CREATE TABLE IF NOT EXISTS task_latest_conversation (
  task_id         text PRIMARY KEY,
  conversation_id text NOT NULL,
  title           text,                       -- conversations.title is nullable
  status          text NOT NULL,
  created_at      timestamptz NOT NULL
);
```

Derived state (fully recomputable from `conversations`/`attempts`) — created `CREATE TABLE IF NOT EXISTS` on boot, **not** a drizzle migration (same class as `__singularity_derived_view_state` / `live_state_changelog`). The drizzle handle the loader reads lives in a **non-glob file** (`agents/server/internal/rollup-table.ts`), NOT `tables.ts`/`schema.ts`, so codegen never emits a migration for it (same reason views live in `views.ts`).

Defining query (source of truth = `listConversationsForDisplay`: `kind <> 'system'`, newest-first, first-per-task):

```sql
SELECT DISTINCT ON (a.task_id) a.task_id, c.id, c.title, c.status, c.created_at
FROM conversations c JOIN attempts a ON a.id = c.attempt_id
WHERE c.kind <> 'system'
ORDER BY a.task_id, c.created_at DESC, c.id DESC
```

The `c.id DESC` tie-break makes equal-`created_at` ties deterministic — a strict improvement over the JS Map's arbitrary scan-order first-wins (note it in the commit message).

### 2. STATEMENT-level maintenance trigger on `conversations`

`CREATE OR REPLACE FUNCTION task_latest_conversation_maintain()` on boot, with three triggers (i/u/d) using transition tables — mirroring the change-feed's `live_state_notify` (`change-feed/server/internal/triggers.ts:74-118, 226-246`). On each statement: collect affected `attempt_id`s from the transition table → resolve to distinct `task_id`s via `attempts` → recompute each affected task's latest row, `INSERT … ON CONFLICT (task_id) DO UPDATE`, and `DELETE` rollup rows for tasks whose last non-system conversation was just removed. Sketch:

```sql
CREATE OR REPLACE FUNCTION task_latest_conversation_maintain() RETURNS trigger AS $tlc$
DECLARE affected_attempt_ids text[];
BEGIN
  IF    TG_OP = 'DELETE' THEN SELECT array_agg(DISTINCT attempt_id) INTO affected_attempt_ids FROM old_rows;
  ELSIF TG_OP = 'INSERT' THEN SELECT array_agg(DISTINCT attempt_id) INTO affected_attempt_ids FROM new_rows;
  ELSE  SELECT array_agg(DISTINCT attempt_id) INTO affected_attempt_ids
          FROM (SELECT attempt_id FROM new_rows UNION SELECT attempt_id FROM old_rows) u;  -- UPDATE
  END IF;
  IF affected_attempt_ids IS NULL THEN RETURN NULL; END IF;

  WITH affected_tasks AS (
    SELECT DISTINCT a.task_id FROM attempts a WHERE a.id = ANY(affected_attempt_ids)
  ), latest AS (
    SELECT DISTINCT ON (a.task_id) a.task_id, c.id AS conversation_id, c.title, c.status, c.created_at
    FROM conversations c JOIN attempts a ON a.id = c.attempt_id
    WHERE a.task_id IN (SELECT task_id FROM affected_tasks) AND c.kind <> 'system'
    ORDER BY a.task_id, c.created_at DESC, c.id DESC
  ), upserted AS (
    INSERT INTO task_latest_conversation (task_id, conversation_id, title, status, created_at)
    SELECT * FROM latest
    ON CONFLICT (task_id) DO UPDATE SET
      conversation_id = EXCLUDED.conversation_id, title = EXCLUDED.title,
      status = EXCLUDED.status, created_at = EXCLUDED.created_at
    RETURNING task_id
  )
  DELETE FROM task_latest_conversation t
   WHERE t.task_id IN (SELECT task_id FROM affected_tasks)
     AND t.task_id NOT IN (SELECT task_id FROM latest);
  RETURN NULL;
END; $tlc$ LANGUAGE plpgsql;
```

**Why `conversations`-only is complete:** verified there is **no reparenting path** — `conversation.attempt_id` is immutable (`UpdateConversationPatch` has no `attemptId`) and `attempt.task_id` is immutable (attempts are only inserted/deleted, never re-`task_id`'d). Attempt DELETE cascades to its conversations → fires the conversation DELETE trigger. Document the immutability assumption in the function header; the boot reconcile (below) is the safety net regardless.

### 3. Boot reconcile (self-healing)

After creating the table + function + triggers, run an idempotent full rebuild from source (`INSERT … ON CONFLICT DO UPDATE` over the defining query, then `DELETE` rollup rows whose task no longer has a non-system conversation). Heals any drift from downtime / bulk loads — mirrors `rebuildDerivedViews`. Guard with `to_regclass('public.conversations') IS NOT NULL` so a pre-migration fresh-DB boot no-ops instead of erroring (the next boot reconciles).

### 4. Rewrite the `agent-launches` loader

Replace the `listConversationsForDisplay()` scan + JS Map rollup (`resources.ts:61-91`) with a read of `task_latest_conversation` joined to launches:
- **Scoped path** (`ctx.affectedIds`): `select launches WHERE id IN (...)`, then `SELECT * FROM task_latest_conversation WHERE task_id IN (taskIds)` — indexed point lookups.
- **FULL path**: `select all launches LEFT JOIN task_latest_conversation ON task_id`.

**Keep unchanged** the `identityTable: "agent_launches"` and the `dependsOn: [conversationsActiveResource]` edge with its `signature: conversationCascadeSignatures` gate and `affectedMap` (conv ids → launch ids) — the live-state cascade still triggers + scopes `agent-launches` on conversation changes exactly as today; only the loader *body* gets cheap.

### 5. Feed-exempt the rollup table (mandatory)

`agent-launches`' read-set will include `task_latest_conversation`. If the change-feed installed its `live_state` notify triggers on it, every conversation change would route to `agent-launches` a *second* time via the rollup table (`task_id` ids, no identity match → a redundant **FULL** recompute that coalesces over and defeats the correctly-scoped conversations-driven path — verified against the router at `resource-runtime/core/runtime.ts:1926-1943`, where `coveredOrigins(agent-launches) = {agent_launches, conversations}`). The conversations change already drives the scoped recompute; the rollup is a pure read-cache. So it must **not** be fed — same class as `live_state_changelog` / `live_state_snapshot` in the change-feed `DENYLIST`.

### 6. The thin `derived-tables` registry (collection-consumer)

The feed-exemption needs a registration surface, and we must NOT have the DB-infra change-feed import an agents-specific table name (boundary smell + wrong dependency direction). Introduce a **deliberately thin** registry — opaque SQL strings only, no query-builder abstraction — so `agents` *contributes* the rollup spec and `change-feed` *consumes* the collection generically (the collection-consumer separation the root CLAUDE.md mandates). One contributor today; a second rollup registers with zero edits to change-feed/derived-views/read-set.

New plugin `plugins/database/plugins/derived-tables/`:
- `core/` — `DerivedRollupSpec` type `{ table, createDdl, functionDdl, triggerDdl, reconcileDdl }` (opaque SQL strings). Pure.
- `server/` — `DerivedTable` server contribution (same pattern as `View` in `derived-views/server/internal/contribution.ts`), a generic `rebuildDerivedTables(tx)` that executes each contributed spec's DDL inside a passed-in transaction (takes `tx` as a param like `rebuildDerivedViews`/`rebuildTriggers` → never imports `database/server`, no cycle), and `feedExemptTables(): Set<string>`.

The concrete SQL (table, function, triggers, reconcile) lives in `agents/server/internal/rollup-spec.ts` as one `DerivedRollupSpec` constant — the generic layer only orchestrates "create table, function, triggers, reconcile" from the opaque strings.

### 7. Boot ordering — run inside change-feed's `rebuildTriggers` transaction

`onReadyBlocking` hooks run under a flat `Promise.all` with **no topo ordering** (`server-core/bin/index.ts:266-279`) — they race. The race-free home is **inside change-feed's existing `rebuildTriggers` transaction** (`triggers.ts:198-248`), after the per-table trigger loop, calling `await rebuildDerivedTables(tx)`. This is exactly where/why the L2 changelog table is already created (`triggers.ts:200-205`). It gives us, for free:
- **Atomic exclusion from feed enumeration**: `listPublicTables` is computed *before* the txn (`triggers.ts:190-196`), so the rollup table doesn't exist when the feed's table set is snapshotted → no feed trigger is ever installed on it. The post-txn `warnOnCoverageGaps` re-enumerates, but the `DENYLIST` (now merged with `feedExemptTables()`) excludes it → no false gap warning.
- **Before any `onReady`**: change-feed's `onReadyBlocking` completes before `markServerReady`, hence before the live-state-snapshot catch-up replay and the boot-critical FULL recompute that read the rollup.

## File-by-file

**New:**
- `plugins/database/plugins/derived-tables/{core,server}/…` — registry plugin (barrels, `DerivedRollupSpec` type, `DerivedTable` contribution, `rebuildDerivedTables(tx)`, `feedExemptTables()`), `CLAUDE.md`, `package.json`.
- `plugins/conversations/plugins/agents/server/internal/rollup-spec.ts` — the concrete `DerivedRollupSpec` (all SQL above).
- `plugins/conversations/plugins/agents/server/internal/rollup-table.ts` — drizzle `pgTable("task_latest_conversation", …)` read handle (non-glob file).

**Edited:**
- `plugins/database/plugins/derived-views/core/internal/imperative-tables.ts` — add `TASK_LATEST_CONVERSATION_TABLE = "task_latest_conversation"` and include it in `IMPERATIVE_PUBLIC_TABLES` (**required** for `imperative-create-table-allowlisted` + `orphaned-db-tables` checks).
- `plugins/database/plugins/change-feed/server/internal/triggers.ts` — merge `feedExemptTables()` into `DENYLIST` (`:29`); `await rebuildDerivedTables(tx)` inside the txn after the trigger loop (`:247`).
- `plugins/conversations/plugins/agents/server/index.ts` — add `DerivedTable(taskLatestConversationSpec)` to `contributions` (`:45`, alongside the existing `View({ view: agents })`).
- `plugins/conversations/plugins/agents/server/internal/resources.ts` — rewrite the loader body (`:61-91`); keep `identityTable` + `dependsOn`/`signature`/`affectedMap` (`:30-60`).
- **read-set `_debug` endpoint** — filter `readSetBases` by `feedExemptTables()` before emission, so `agent-launches` does not show as a false "silent FULL recompute" in the Debug → Read-set pane (the ceiling at `read-set/web/components/read-set-view.tsx:107-121` flags base tables outside `coveredOrigins`; the rollup is one but is feed-exempt). If the emission site in `server-core`/`runtime.ts` can't reach `feedExemptTables()` without a feature-plugin import, use the existing boot-injection pattern (like `setRelationResolver`): change-feed injects the feed-exempt set into server-core at boot. Keeps server-core free of feature imports.
- Docs: `plugins/database/CLAUDE.md` (+`derived-tables`); `docs/plugins-compact.md` / `plugins-details.md` regenerate via `./equin build`.

## Verification

1. **workMs drop** — `get_runtime_profile(kind:"loader", worktree:"singularity")` before/after: `agent-launches` `workMs` falls from ~4.9 s to single-digit ms; its `db` child spans no longer show the `conversations_v` scan.
2. **In-app correctness** — change a conversation's status/title in the UI; `agent-launches` updates (cascade unchanged) and `query_db "SELECT * FROM task_latest_conversation WHERE task_id='<t>'"` matches.
3. **Out-of-process correctness** — `psql UPDATE conversations SET status='done' WHERE id='<latest-for-task>'`: the STATEMENT trigger updates the rollup transactionally; the change-feed's `conversations` trigger separately drives the recompute. Then `DELETE` the only non-system conversation for a task and confirm its rollup row is **removed** (last-conversation case).
4. **Boot reconcile heals drift** — with the server down, `psql` corrupt the rollup (`UPDATE task_latest_conversation SET title='STALE'`) and change a conversation; restart; the reconcile overwrites `STALE` with truth. Confirm via `query_db`.
5. **No double-routing / no false warning** — Debug → Read-set: `agent-launches` not under "silent FULL recomputes"; the rollup table emits no NOTIFY on conversation writes.
6. **Checks green** — `./equin check imperative-create-table-allowlisted` and `orphaned-db-tables`, plus `type-check` / `plugin-boundaries`.

## Risks & notes

- **The read-set `_debug` edit is the one framework-level change** — confirm the exact emission site; fall back to boot-injection if needed to avoid a server-core→feature import.
- **Fresh-DB boot race (pre-existing).** change-feed's `rebuildTriggers` does not `await` migrations; on a truly fresh DB it already assumes base tables exist (it triggers `conversations`). The reconcile's `to_regclass` guard makes the rollup setup no-op safely in that window. The underlying change-feed↔migrations ordering gap is pre-existing — **surface it to the user / `add_task`, don't route around it** beyond the guard.
- **Scope is a deliberate pilot.** The registry is thin by design (opaque SQL, no rollup-shape abstraction). Generalizing the *shape* of a rollup waits for a 2nd case (e.g. `attempts`, the next-most-expensive loader) — measure this one first.
</content>
</invoke>
