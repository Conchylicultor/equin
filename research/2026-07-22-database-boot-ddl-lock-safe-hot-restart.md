# Remove the hot-restart boot-DDL deadlock (structurally, no timeout)

## Context

`./equin build` deploys via a **ready-gated blue/green hot restart** (gateway
`worktree.go`): it spawns the new backend while the **old backend keeps serving full
DB traffic** (holding `AccessShareLock`s on the relations it reads), and drains the old
one only *after* the new backend passes `/api/health/ready`. So for the whole duration
of the new backend's boot, the old backend is a live concurrent reader.

The new backend's `onReadyBlocking` runs schema-mutating boot DDL that takes
`AccessExclusiveLock`. It intermittently crashes before ready with a Postgres deadlock
(`40P01`); the new process exits, the gateway reports *"backend exited before ready —
old backend intact"*, and the deploy fails. A retry usually succeeds only because lock
timing differs. Observed twice on worktree `claude-1784290448` (2026-07-17, stderr in
`~/.singularity/logs/claude-1784290448.log`), thrown from
`[plugin.database.change-feed] onReadyBlocking failed`.

**This plan removes the deadlock at the source — it does not add a timeout to survive
it.**

## Why the deadlock exists

A `40P01` requires a **cycle of hold-and-wait**. From the log:

- **New backend (boot DDL)** holds `AccessExclusiveLock` on relation `15784592` (a table
  it already `DROP/CREATE TRIGGER`-ed) **and waits** for `AccessExclusiveLock` on
  `15784782` (the next table in the loop).
- **Old backend (a live read)** holds `AccessShareLock` on `15784782` **and waits** for
  `AccessShareLock` on `15784592`.

The load-bearing condition is on *our* side: change-feed's `rebuildTriggers`
`DROP/CREATE TRIGGER`s **every table in one transaction** (`triggers.ts` ~407-462), so
mid-loop it holds exclusive locks on a whole prefix of the schema *while asking for more*.
That is textbook hold-and-wait. The old backend's ordinary reads are innocent — they just
lock the same two tables in the opposite order and close the cycle.

## The fix: eliminate hold-and-wait via single-relation transactions

**A transaction that only ever holds one relation's exclusive lock cannot be a node in a
cycle.** It either acquires that one lock or waits for exactly one holder — and that holder
(an old-backend reader) is not waiting on *us* for a second relation. The wait-for graph
becomes a forest **by construction**; the deadlock is impossible, not retried.

So: stop bundling independent DDL into one giant transaction.

### change-feed — split the trigger rebuild per table (the fix)

`plugins/database/plugins/change-feed/server/internal/triggers.ts`. The fingerprint
fast-path (`triggerLayerUpToDate`, ~397-405) is unchanged. When a real rebuild is needed,
restructure the single `db.transaction` (407-462) into:

1. **Prelude tx** — `ensureChangelogTable` (`CREATE TABLE IF NOT EXISTS live_state_changelog`)
   + `CREATE OR REPLACE FUNCTION live_state_notify`. Touches only the changelog table + the
   function; the function must exist before any trigger references it.
2. **Per-relation txs** — for **each** desired table, its own `db.transaction` running that
   table's 3×`DROP TRIGGER IF EXISTS` + 3×`CREATE TRIGGER` (locks that one table only). For
   **each** now-excluded (stale) table, its own tx running just the `DROP`s. Every
   table-level lock is thus acquired and released in isolation.
3. **Signature-stamp tx** — write `TRIGGER_STATE_DDL` + the signature upsert **last**, only
   after every per-relation tx committed, and set the `coveredTables` cache from the desired
   set.

Delete the now-unnecessary `runRebuildTx` retry wrapper (286-304), its constants
`RETRYABLE_SQLSTATES`/`MAX_REBUILD_RETRIES`/`rebuildRetryDelay` (280-282), and the
`retryUntil/exponential/withJitter` import (line 4) — single-relation transactions cannot
deadlock, so there is nothing to retry.

### derived-tables — no change for the deadlock (already single-relation)

`rebuildDerivedTables` (`derived-tables/server/internal/rebuild.ts`) already runs its four
statements per spec as **autocommit** on the pool `db` (26-45). `triggerDdl` locks only its
source table (`conversations`/`pushes`) and commits immediately; `reconcileDdl` takes only
`AccessShare`/`RowExclusive`. It can *block* on a live reader but cannot deadlock. **Leave
it as-is for correctness. Do NOT wrap `create+function+trigger+reconcile` in one
transaction** — that would hold `AccessExclusive` on the source table across the reconcile
*and* touch the rollup table, re-introducing a multi-relation hold-and-wait.

*Optional optimization (not required for the fix):* give it the same skip-when-unchanged
fingerprint its siblings have (SHA-256 over each spec's DDL in `derived_table_state`,
catalog-re-verified: table + all three triggers + function must exist before skipping —
because rollups hold data and the skip also skips the reconcile). This only avoids
re-locking/re-blocking the hot source tables on every boot; it changes no deadlock
property. Ship the fix first; treat this as a follow-up unless we want the steady-state
polish now.

### derived-views & migrations — stay atomic (accepted residual)

These *require* multi-relation atomicity and must NOT be split:

- **derived-views** (`derived-views/server/internal/rebuild.ts`, one tx at ~60) — splitting
  would open a **missing-view window** (a reader hitting a dropped-but-not-recreated view
  errors), and `CREATE OR REPLACE VIEW` can't do incompatible column changes without a
  `DROP CASCADE` fallback. It is already fingerprint-skipped (rare rebuild).
- **migrations** (`migrations/server/internal/runner.ts`, per-migration tx at 155-160) —
  atomicity is the point; a single-table migration is already deadlock-free by the same
  single-relation argument, and multi-table migrations are rare.

Residual risk for these two: a rare deadlock where the **new** backend is the victim and
boot fails (then succeeds on retry, as today). Mitigation without new machinery: the **old**
backend's queries go through `pool.query`, which already auto-retries `40P01`/`40001`
(`client.ts:146-296`) — so Postgres frequently picks the *old* reader as victim and it
recovers transparently while the atomic DDL proceeds. We accept this residual rather than
adding a timeout; it can be revisited (e.g. quiescing the old backend during migration
apply) if it ever actually bites.

## Why splitting change-feed is safe and self-healing

Three invariants (see also `change-feed/CLAUDE.md`):

1. **No object is ever half-built.** Each table's `DROP…IF EXISTS` + `CREATE` is one tx, so a
   table always has a *complete* trigger set — old or new, never none. The notify function is
   committed first, so old and new triggers both call the current function. A write mid-rebuild
   fires whichever trigger is installed; both emit a compatible NOTIFY ⇒ **no feed event lost**.
2. **"Done" is recorded last.** The signature is stamped only after all per-table txs commit,
   and is trusted only alongside a catalog re-verify. A boot that dies mid-loop never records a
   matching signature ⇒ the next boot re-runs the full idempotent rebuild ⇒ converges.
3. **Partial state is "old-but-working," never "broken."** The only thing lost vs. one-big-tx is
   "all tables flip in the same instant," which nothing consumes (triggers are independent, all
   call the same function).

Constraint to preserve: the notify function's *signature* must stay compatible with existing
triggers (already true — body changes, not the `(pkCol)` contract). Worst case is a loud error
on a concurrent write, self-healed next boot — never silent corruption.

Trade in the no-timeout model: a single-relation tx can't deadlock but *can block* until a
reader releases its `AccessShareLock`. The old backend's reads are short (loaders/polls, ms), so
this is a brief wait, not a hang — and a hang would be a visible liveness issue, never
corruption.

## Critical files

- `plugins/database/plugins/change-feed/server/internal/triggers.ts` — split rebuild into
  prelude / per-table / signature-stamp transactions; delete `runRebuildTx` + retry constants +
  the retry import. **The whole fix.**
- `plugins/database/plugins/change-feed/CLAUDE.md` — replace the "one transaction over every
  table + skip-when-unchanged + `runRebuildTx` retry" description with the per-table-transaction
  model and the three self-healing invariants.
- *(optional)* `plugins/database/plugins/derived-tables/server/internal/rebuild.ts` +
  `derived-views/core/internal/imperative-tables.ts` — the derived-tables fingerprint follow-up.
- `plugins/database/plugins/derived-tables/CLAUDE.md` — fix the stale claim that
  `rebuildDerivedTables` "runs inside change-feed's `rebuildTriggers` transaction" (it runs in
  `database/server`'s own `onReadyBlocking` on plain `db`).

No new plugin, no `lock_timeout`, no retry, no `runBootDdlTx` primitive.

## Verification

**Reproduce the deadlock (pre-fix).** Two `psql` sessions on the worktree DB:
Session A `BEGIN; LOCK TABLE pushes IN ACCESS SHARE MODE;` (simulates the old-backend read),
then trigger a whole-layer change-feed rebuild that already holds `AccessExclusive` on an
earlier table and now wants `pushes`; in A, `SELECT 1 FROM <that earlier table>;` → cycle →
`40P01`. Reproduces `build-1784288281433-w62dep`.

**Prove the fix.**
1. *No deadlock possible:* with the per-table rebuild, Session A `BEGIN; LOCK TABLE conversations
   IN ACCESS SHARE MODE;`. Run the rebuild → its `DROP/CREATE TRIGGER … ON conversations`
   *waits* (single relation), never `40P01`. Release A → the rebuild acquires and commits. There
   is no lock combination that yields a cycle — the structural proof.
2. *Self-heal on partial:* kill the backend mid-rebuild (after some per-table txs commit) →
   confirm every table still has a working trigger set (old or new), the signature is unchanged,
   and the next `./equin build` re-runs the full rebuild and reaches ready.
3. *Steady-state no-op:* `./equin build` twice with no trigger-set change → change-feed
   logs "up to date … skipping"; zero rebuild, zero blocking.

**End-to-end** (`/verify`): force a real trigger-set change (add/remove a table) and run an actual
`./equin build` hot swap against the concurrently-serving old backend; confirm the deploy
completes with no "backend exited before ready."

Then `./equin build` and `./equin check`.
