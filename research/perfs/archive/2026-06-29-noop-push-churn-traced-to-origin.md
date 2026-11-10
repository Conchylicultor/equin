# No-op-push churn, traced from the snapshot-UPSERT symptom up to its origin (the 1 Hz conversations poller) — plus the methodology that finally got there

**Date:** 2026-06-29 (fourth session of the day)
**Status:** Root cause traced to the origin and confirmed with converging evidence. **No code
changes** — handed off for an agent to implement the layered fix. Fix direction in
`research/2026-06-29-global-noop-statement-invalidation-churn.md`.
**Method note:** this session also extracted the investigation methodology into the
[`perfs-investigation`](../../.claude/skills/perfs-investigation/SKILL.md) skill — the method
that catches the very mistake the first three sessions (and this session's own first plan) made.

## TL;DR

The notifications fix (session 2, `a8f9da4b6`) landed and worked. The multi-second stalls
persisted one layer down, so this session chased them — and, applying the "trace to the origin,
not the hotspot" method, walked the chain three hops past where it first appeared "solved":

```
no-op recompute (×12/s)  ← FULL-table invalidation
  ← change-feed trigger fires on a ZERO-ROW statement
  ← INSERT … ON CONFLICT DO NOTHING that fully conflicts (0 rows inserted)
  ← the conversations poller re-adopts an already-known session as an "orphan"
  ← it classifies cross-worktree live tmux sessions as orphans, every tick
  ← it polls every 1 s (setInterval)   ← ORIGIN (illegitimate per the repo's no-polling rule)
```

Each downstream node was a real cost, but only the **origin** (the 1 Hz spurious re-adoption)
is illegitimate behavior. The expensive symptom everyone fixates on (the snapshot UPSERT / TOAST
bloat) is the most *amplified* node, not the driver.

## What this session did (and corrected)

1. **Re-validated session 2 on `singularity`.** notifications snapshot value **1.88 MB → 42 kB**;
   undismissed `report` rows **21,803 → 27**; `deliver:notifications` max **5.9 s → 341 ms**. The
   landed fix is real.
2. **Found the new dominant cost:** a 22.4 s `flushNotifies` = one `live_state_snapshot` UPSERT
   stalling **21.9 s** (avg 26 ms — a lone outlier) that serial-blocked every co-flushed resource.
   `live_state_snapshot` = **181 MB TOAST for 20 rows** (11 k dead TOAST tuples, ~3 M lifetime
   UPDATEs). (Detail: `research/perfs/2026-06-29-snapshot-toast-bloat-noop-persist.md`.)
3. **Wrote a first plan — then recognized it as the tail.** "Skip the snapshot UPSERT when the
   value is unchanged" (`research/2026-06-29-global-skip-unchanged-snapshot-persist.md`) removes
   the *persist*, but the loader still recomputes on every no-op. It treated rate as a given.
4. **Traced the rate to its origin.** The `live-state-noop` monitor logged **32,107** redundant
   pushes across 6 resources at ~2/s each. `live_state_changelog` showed `conversations` INSERT
   statements at **2.62/s** (75,987 total) against only **2,280 rows ever inserted** — the tell.
   The writer is `insertConversationOnConflictDoNothing` (`.onConflictDoNothing()`), called by the
   conversations poller's orphan adoption, on a `setInterval(tick, 1000)`, where the "orphan" set
   is every host-wide tmux session minus the local DB — so cross-worktree sessions are re-adopted
   (and fully conflict) every tick.
5. **Extracted the methodology.** The reason three sessions missed this is general, not
   instance-specific → captured as the `perfs-investigation` skill (rate×cost, trace-to-origin,
   the four stopping gates, containment-vs-cure altitudes, counterfactual exit).

## Evidence (converging — profile + DB + code)

- **Profile (`singularity`):** worst flush 22,379 ms; worst `live_state_snapshot` UPSERT
  21,919 ms (avg 26 ms / 1,503 calls); every co-flushed `deliver:*` pinned to the same ~22 s
  cycle (pure wait, `workMs == avgMs`).
- **DB:** `live_state_snapshot` heap 160 kB / **TOAST 181 MB** / 20 live rows / 11,004 dead TOAST
  tuples / `n_tup_upd` ≈ 3.0 M / `last_vacuum = null`. `live-state-noop` reports: `tasks`,
  `attempts`, `conversations-system/gone/active`, `agent-launches`, each ~2.0/s (32,107 total).
  `live_state_changelog`: `conversations` op `I` 2.62/s vs `pg_stat_user_tables.n_tup_ins` = 2,280.
- **Code:** `change-feed/server/internal/triggers.ts` `live_state_notify()` is STATEMENT-level
  with transition tables and fires unconditionally (empty `new_rows` → `array_agg` NULL →
  FULL-for-table). `tasks-core/.../mutations/conversations.ts:84` `insertConversationOnConflictDoNothing`
  → `.onConflictDoNothing()`. `conversations/server/internal/poller.ts:25,263` `TICK_MS=1000`,
  `setInterval`; orphans = host-wide tmux sessions − `listConversationsForInfra()`.

## The fix direction (layered — for the continuing agent)

Full plan: `research/2026-06-29-global-noop-statement-invalidation-churn.md`. Two altitudes:

- **Containment (boundary invariant) — ready to implement.** In `live_state_notify()`, early-
  return when the statement affected zero rows (`SELECT EXISTS(SELECT 1 FROM new_rows/old_rows)`)
  before the `pg_notify` + changelog INSERT. Makes the whole class structurally harmless for every
  table and every caller. Data-less DDL (`CREATE OR REPLACE`, rebuilt on boot — no migration).
- **Cure (origin) — needs one more investigation hop.** Stop the poller's 1 Hz spurious
  re-adoption: fix the orphan classification so a known/cross-worktree live session isn't
  re-upserted every tick, and move adoption toward event-driven (the repo forbids polling).
  Confirm the exact misclassification before writing it.

### Lower-altitude follow-ups (already-known, do not re-derive)
- **Persist-skip** (`…-skip-unchanged-snapshot-persist.md`) — now defense-in-depth for
  same-value-UPDATE tails and real-change TOAST growth. Low priority once the above land.
- **One-time `VACUUM (FULL, ANALYZE) live_state_snapshot` on `singularity`** — reclaim the
  existing 181 MB TOAST. Manual; not a migration; not via the read-only MCP tool. Run *after* the
  churn is stopped, else it re-bloats.
- **Class hardening:** a check/lint flagging an unbounded `mode:"push"` resource over a growing
  table (`pushes`/`attempts`/`tasks` are ~0.4 MB each).

## Why the first three sessions (and this one's first plan) missed it

Each landed on *where time was spent*, never *what made the work happen so often* — they applied
the sufficiency gate (or not even that) and skipped the legitimacy gate. That is now encoded as
enforced phases + stopping gates in the [`perfs-investigation`](../../.claude/skills/perfs-investigation/SKILL.md)
skill, cross-linked as MANDATORY from this directory's `CLAUDE.md`.
