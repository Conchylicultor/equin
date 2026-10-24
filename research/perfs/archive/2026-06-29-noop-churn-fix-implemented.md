# No-op-push churn — the layered fix implemented (boundary invariant + origin cure)

**Date:** 2026-06-29 (fifth session of the day)
**Status:** Both fix altitudes **implemented and built** on branch `claude-web/att-1782729129-nlnv`.
Re-validated session 4's root cause against fresh data first; the churn is still live on `singularity`.
Behavioral confirmation of the rate drop requires landing on `singularity` (the poller's orphan
adoption is main-only and does not reproduce in a worktree). **Not pushed** — awaiting review.

## Phase 0 — re-validated, did not inherit

Re-measured `singularity` before writing any code. Session 4's chain still holds, and the churn has
if anything grown:

- `live_state_changelog` last 5 min: **`conversations` INSERT = 4.0/sec, 1200 of 1201 with NULL ids**
  (zero-row statement → `array_agg` NULL → routed FULL-for-table). Up from session 4's 2.62/sec.
- `pg_stat_user_tables`: `conversations.n_tup_ins` = **2,285** (≈ session 4's 2,280 — still no real
  inserts); `live_state_snapshot` = 20 live rows, **n_tup_upd = 3,058,365**, total **155 MB**,
  `last_vacuum = null` (the deferred one-time `VACUUM FULL` was still never run; autovacuum at
  10:31 trimmed it from 181→155 MB but TOAST bloat persists).
- **Newly surfaced same class:** `job_steps`/`job_waits` DELETEs at 0.28/sec each, also NULL-id
  (zero-row). The boundary invariant covers these too — it is not conversations-specific.

Neither prior fix had landed: the trigger DDL had no zero-row guard, and the worktree was clean.

## The one remaining hop session 4 flagged — the exact misclassification (now confirmed)

Session 4 said the origin cure "needs one more investigation hop: confirm the exact
misclassification." Found it, with converging evidence:

The poller computes `orphans = [...liveSessions].filter((id) => !dbById.has(id))`, where `dbById`
comes from `listConversationsForInfra()` — which is **scoped to `status <> 'done'`** (active rows
only, to avoid scanning all history each tick). tmux is host-wide (one server per host), so main's
poller sees **every** worktree's sessions. A conversation that was adopted into main's DB and later
marked **`done`** — but whose tmux session still lingers host-wide — is therefore **absent from
`dbById`**, re-classified as an orphan **every tick**, and re-adopted via
`adoptOrphanConversation` → `INSERT … ON CONFLICT DO NOTHING` that fully conflicts (0 rows).

Confirming data: `conversations` grouped by `(status, spawned_by)` shows **86 rows
`status='done', spawned_by='poller'`** — exactly the adopted-then-terminal set. ~4 of them have a
currently-live host-wide session, which reproduces the observed 4.0 INSERT statements/sec.

Three converging lines: **profile/changelog** (4/s, 1200/1201 NULL-id) + **DB** (86 done/poller
rows; n_tup_ins flat at 2,285) + **code** (`queries/conversations.ts:69` active-only filter;
`poller.ts:89` orphan filter on `dbById`; `cross-table.ts:101` `onConflictDoNothing`).

## What was implemented (two altitudes — per the method, both)

### 1. Boundary invariant — containment, kills the whole class for every table
`plugins/database/plugins/change-feed/server/internal/triggers.ts`, `live_state_notify()`:
early-return when the statement touched **zero rows**, before `pg_notify` and the
`live_state_changelog` INSERT.

```sql
IF TG_OP = 'DELETE' THEN
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM old_rows)' INTO has_rows;
ELSE
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM new_rows)' INTO has_rows;
END IF;
IF NOT has_rows THEN RETURN NULL; END IF;
```

- Correct for all three ops: an empty transition table ⇒ no affected row ⇒ no data change ⇒
  nothing to invalidate or replay. The sole consumer of a notify is `applyDbChange` → recompute.
- `EXECUTE` (not a static reference) mirrors the existing dynamic `array_agg`, because
  `new_rows`/`old_rows` only exist for the matching `TG_OP`. **Verified every trigger declares the
  transition table** (`CREATE TRIGGER … REFERENCING NEW/OLD TABLE …`, triggers.ts:309–325), so the
  unconditional `EXISTS` is always valid — including pk-less (`pk_col = ''`) triggers, where the old
  code never touched the transition table.
- Data-less DDL: `CREATE OR REPLACE`, rebuilt on every boot by `rebuildTriggers` — no migration.
- **Deployed & verified structurally** via `pg_get_functiondef('live_state_notify()')` on the
  worktree: the guard is present in the live function.

### 2. Origin cure — stop re-adopting `done`-but-live sessions
`plugins/conversations/server/internal/poller.ts` + a new bounded query
`listExistingConversationIds(ids)` in `tasks-core` (`queries/conversations.ts`, exported from the
server barrel):

```ts
const candidates = [...next.keys()].filter((id) => !dbById.has(id));
const existing = await listExistingConversationIds(candidates);  // ANY status, incl. 'done'
const orphans = candidates.filter((id) => !existing.has(id));
```

A session whose conversation row exists in **any** status is recognized as known and adopted at
most once. The new query checks existence against the full table but is bounded by the candidate
count (usually 0) and hits the PK — it does not reintroduce the all-history scan that
`listConversationsForInfra`'s active filter exists to avoid.

## Verification status

- `./equin build` clean; `./equin check` (all checks incl. type-check,
  plugin-boundaries, no-db-backed-notify) green.
- Boundary invariant confirmed live in the worktree DB (function body).
- **Behavioral rate-drop confirmation deferred to `singularity`**: the poller's orphan adoption is
  `isMain()`-only, so the conversations churn cannot reproduce in a worktree DB. A direct mutating
  test on the worktree DB was **not** attempted — the `psql`/`pg_*` guard blocks it and forbids
  workarounds. On landing, confirm via `get_runtime_profile` (worktree `singularity`, kind `db`):
  `conversations` INSERT statement rate → ≈ real-change rate, `live_state_snapshot` UPSERT count and
  the `tasks_v`/`attempts_v`/`conversations_v` loader counts drop, `live-state-noop` stops
  accumulating; and via `live_state_changelog` that `conversations` `I` flattens.

## Still open (defense-in-depth / follow-ups — not blocking)

- **One-time `VACUUM (FULL, ANALYZE) live_state_snapshot` on `singularity`** — reclaim the ~155 MB
  TOAST already accumulated. Manual (not a migration; not via the read-only MCP tool). Run **after**
  this lands, else it re-bloats. Still never run as of this session.
- **Persist-skip** (`research/2026-06-29-global-skip-unchanged-snapshot-persist.md`) — now pure
  defense-in-depth (same-value-UPDATE tails, real large-blob TOAST growth). Low priority.
- **The 1 Hz poller itself** (`conversations/server/internal/poller.ts`) re-upserts via interval
  polling, against the repo's no-polling rule. This fix removes its change-feed sting and the
  wasted writes, but moving liveness detection to event-driven (tmux session death has no push
  signal today) is a larger redesign. **Flag, not fixed here.**
- **Class hardening:** a check/lint flagging an unbounded `mode:"push"` resource over a growing
  table — the deeper structural guard. Separate.
