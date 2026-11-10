# Issue: live-state no-op churn & unbounded `push` resources

**Status: COMPLETED** — both fix altitudes landed on main (`1f6b27092`; notifications `a8f9da4b6`)
and validated on `singularity` (session 6, 2026-06-29).

The headline symptom — multi-second flush stalls, "simple pages take seconds" — traced past two
amplified hotspots (the `notifications` 1.88 MB mega-blob; the 181 MB `live_state_snapshot` TOAST
bloat) to its origin: the conversations poller re-issuing a **zero-row write every 1 s**, which the
STATEMENT-level change-feed trigger amplified into FULL-table invalidations → a ~12/s no-op recompute
+ full-blob snapshot-UPSERT storm. Fixed with a **boundary invariant** (trigger never notifies on a
zero-row statement) + an **origin cure** (stop re-adopting `done`-but-live tmux sessions). The
confirmed cause/amplifier/effect chain is in the checklist below.

Residual follow-ups (flagged, not fixed): the 1 Hz poll itself (now cheap/harmless — event-driven
liveness is a separate redesign), and a class-hardening check for unbounded `push` resources over
growing tables.

## Causes — checklist

Legend: ✅ confirmed with data · ❌ discarded (with reason) · 🔬 open / needs proof

### Confirmed root cause + FIXED + VALIDATED on main (2026-06-29 sessions 5–6)
> Both altitudes landed on main (`1f6b27092`) and are now **behaviorally validated on `singularity`**
> (session 6): `flushNotifies` **22.4 s → 571 ms**, `conversations` INSERT **4.0/s → 0.003/s with
> zero NULL-id statements**, `live_state_snapshot` **155 MB → 14 MB** (autovacuum self-reclaimed once
> the churn stopped — the deferred `VACUUM FULL` proved unnecessary), `live-state-noop` accumulation
> stopped. The exact misclassification (session 4's "one remaining hop") was confirmed in session 5:
> orphans are computed against the **active-only** infra list, so a `done` conversation with a
> lingering host-wide tmux session is an eternal orphan (**86 `done`/`poller` rows** in `singularity`).
- ✅ **ORIGIN: the conversations poller re-issues a zero-row write ~4/s** (re-measured; was 2.6/s).
  It runs on a 1 Hz `setInterval` (`conversations/server/internal/poller.ts:25,263`) and re-adopts a
  `done`-but-still-live host-wide tmux session as an "orphan" (it's missing from the active-only
  `dbById`) via `insertConversationOnConflictDoNothing` → `.onConflictDoNothing()` that fully
  conflicts (0 rows inserted). Evidence: `live_state_changelog` `conversations` INSERT 4.0/s,
  1200/1201 NULL-id, vs `n_tup_ins` = 2,285 rows ever. **FIX:** `listExistingConversationIds(ids)`
  gate — a session whose row exists in *any* status (incl. `done`) is adopted at most once.
  *Lower-altitude residue: the 1 Hz poll itself still violates the no-polling rule — flagged, not
  fixed (tmux death has no push signal today; event-driven adoption is a separate redesign).*
- ✅ **AMPLIFIER 1 — change-feed trigger fires on zero-row statements.** `live_state_notify()`
  is STATEMENT-level; an empty transition table still NOTIFYs, and `array_agg(pk)` over it is
  NULL → routed as **FULL-for-table**, invalidating *every* resource reading `conversations`.
  **FIX (boundary invariant, session 5):** early-return on `NOT EXISTS(SELECT 1 FROM new_rows/
  old_rows)` before `pg_notify` + the changelog INSERT — kills the whole class for every table
  (also covers the `job_steps`/`job_waits` zero-row DELETEs at 0.28/s each). Verified live via
  `pg_get_functiondef`.
- ✅ **AMPLIFIER 2 — invalidation → no-op recompute.** 6 keyed resources fire **~2 no-op
  pushes/s each** (32 k logged `live-state-noop`): loader reruns, value identical, empty diff.
- ✅ **AMPLIFIER 3 — unconditional full-value snapshot UPSERT (the persist tail).** `drainEntry`
  persists the full ~0.4 MB blob even on a no-op (persist precedes the diff; no value compare;
  `resource-runtime/core/runtime.ts` 1404–1419).
- ✅ **EFFECT 1 — `live_state_snapshot` TOAST bloat — RESOLVED (session 6).** Was **181 MB TOAST /
  20 live rows** (11 k dead TOAST tuples, ~3 M lifetime `n_tup_upd`). Once the no-op UPSERT firehose
  stopped, **autovacuum reclaimed it to 14 MB on its own** (12:08; `n_dead_tup` 11 k → 7). The
  deferred one-time `VACUUM FULL` proved **unnecessary** — closed.
- ✅ **EFFECT 2 — multi-second flush stalls (the headline symptom).** A single UPSERT into the
  bloated TOAST stalled **21.9 s**; `flushNotifies` serializes, so it inflated every co-flushed
  resource's delivery to ~22 s (pure wait). *This is the most-amplified node — fixated on by
  sessions 1–3 — not the driver.*

> Fix altitudes (see `research/2026-06-29-global-noop-statement-invalidation-churn.md`):
> **boundary invariant** at AMPLIFIER 1 (trigger never invalidates on zero rows — kills the
> whole class), **cure** at ORIGIN (fix the poller). AMPLIFIER 3's persist-skip + the one-time
> `VACUUM FULL` are defense-in-depth.

### Confirmed + FIXED (landed on main `a8f9da4b6`, 2026-06-29 session 2)
- ✅ **`notifications` was a 1.88 MB unbounded monolith** (21,803 undismissed rows, no
  `LIMIT`) — the worst single blob. **GROWTH:** `recordReport` filed a notification per
  report (~281/h), deduped by `(reportId, timeBucket)` → ~26× row blow-up, never
  auto-dismissed for `warning`/`error`. **Fix:** one notification row per fingerprint
  (count + in-place re-surface) + TTL closes the warning/error gap. Re-validated session 3:
  value **1.88 MB → 42 kB**, undismissed report rows **21,803 → 27**, `deliver:notifications`
  max **5.9 s → 341 ms**.

### Discarded
- ❌ **Client↔DB transport latency / adopt a sync engine (Zero)** — 2026-06-28: the
  dominant cost is server-side work+contention; git/fs-derived resources can't live
  in a Postgres replica anyway. Keep Zero only for future multi-device/offline sync.
- ❌ **DB-pool exhaustion as a chronic state** — 2026-06-29 (2): intermittent symptom of
  the big-blob storms, not a standing condition (81 ms acquire between storms).

## Sessions

- **2026-06-28 — [boot & git-loader slowness assessment](./archive/2026-06-28-boot-and-git-loader-slowness-assessment.md).**
  First pass (genesis of all three perf threads). Concluded the bottleneck is server-side
  *work + contention*, not client↔DB transport, so adopting Rocicorp Zero would not help. Named three
  root causes: (A) git-derived loaders — see [git-derived loaders](./issue-git-derived-loaders.md);
  (B) event-loop / heavy-read-pool starvation; (C) `live_state_snapshot` table bloat. (B) and (C) are
  this issue. *Superseded in part by 2026-06-29: (B) turned out to be specifically
  DB-connection-pool exhaustion, itself a downstream symptom.*

- **2026-06-29 — [DB-pool exhaustion vs git loaders (root-cause hunt)](./archive/2026-06-29-db-pool-exhaustion-flush-cascade-findings.md).**
  Re-measured before building the planned git fix. The live profile shows the real bottleneck: across
  all loaders, **DB-connection-pool wait (`loader-acquire`) = 243,614 ms** vs **host heavy-read gate
  (`heavy-read-acquire`) = 17 ms**. `flushNotifies` (the live-state cascade) maxes at **97 s** and
  owns 43,721 of 95,465 pool acquires. The git loaders are *victims* of pool exhaustion, not a cause.
  **Root cause not yet confirmed beyond doubt — see that doc's open questions.** *Superseded by the
  next session: pool exhaustion is a downstream, intermittent symptom, not the driver.*

- **2026-06-29 (2) — [notifications unbounded resource = the driver (root cause confirmed)](./archive/2026-06-29-notifications-unbounded-resource-root-cause.md).**
  Answered all five open questions with converging profile + DB + code evidence. The driver is a
  handful of **oversized monolithic `push` live-state resources** that load an entire unbounded table
  as one blob and re-serialize/re-snapshot/re-deliver the *whole* blob on every change — worst by 4×
  is **`notifications`: 1.88 MB, 21,803 undismissed rows, loaded with no `LIMIT`**. Its full-blob
  UPSERT bloated `live_state_snapshot` TOAST to **112 MB** (4.95 s writes); its delivery is the
  slowest push (5.9 s). The blob grows forever because the **reports system files a notification per
  report (~281/h)** and the TTL sweep never auto-dismisses `warning`/`error` variants. Re-validated
  the prior session: `[acquire]` max is **81 ms**, not 44.6 s — pool exhaustion spikes only *during*
  these big-blob storms, so it is a symptom. The fix (one notification row per fingerprint)
  **landed on main** (`a8f9da4b6`).

- **2026-06-29 (3) — [snapshot TOAST bloat + unconditional no-op persist (root cause confirmed)](./archive/2026-06-29-snapshot-toast-bloat-noop-persist.md).**
  Re-validated the landed notifications fix: `notifications` value **1.88 MB → 42 kB**, undismissed
  report rows **21,803 → 27**. But the multi-second flush stalls persist one layer down. The new
  dominant event is a **22.4 s `flushNotifies` = one `live_state_snapshot` UPSERT stalling 21.9 s**
  (avg 26 ms — a lone outlier) that serial-blocks every co-flushed resource. Cause:
  `live_state_snapshot` is **181 MB TOAST for 20 rows** (11 k dead TOAST tuples, ~3 M lifetime
  UPDATEs) — pure bloat, never reclaimed because session 2's deferred `VACUUM FULL` **was never run**.
  Re-fed structurally: the runtime **UPSERTs the full value on every flush unconditionally, including
  no-op pushes** (persist precedes the diff; 6 keyed resources fire ~2 no-op pushes/s each = 32 k
  logged `live-state-noop`). *Refined by session 4: the persist-skip is the tail; the no-op pushes
  themselves have an upstream origin.*

- **2026-06-29 (4) — [no-op-push churn traced to its origin (the 1 Hz poller) + methodology](./archive/2026-06-29-noop-push-churn-traced-to-origin.md).**
  Traced the residual stalls *upstream* instead of optimizing the hotspot. Walked the chain three
  hops past "solved": no-op recompute (×12/s) ← FULL-table invalidation ← change-feed trigger firing
  on a **zero-row statement** ← `INSERT … ON CONFLICT DO NOTHING` that fully conflicts ← the
  conversations poller re-adopting cross-worktree tmux sessions as "orphans" ← **it polls every 1 s**
  (the origin — illegitimate per the no-polling rule). Evidence: `live_state_changelog`
  `conversations` INSERT 2.62/s vs only 2,280 rows ever inserted; 32,107 `live-state-noop` across 6
  resources. Layered fix: **boundary invariant** (trigger never invalidates on zero rows) + **origin
  cure** (fix the poller); persist-skip + one-time `VACUUM FULL` demoted to defense-in-depth.
  Extracted the method into the mandatory
  [`perfs-investigation`](../../.claude/skills/perfs-investigation/SKILL.md) skill. **No code changes
  — handed off for implementation.**

- **2026-06-29 (5) — [the layered fix implemented (boundary invariant + origin cure)](./archive/2026-06-29-noop-churn-fix-implemented.md).**
  Re-validated session 4 on fresh `singularity` data (did not inherit): `conversations` INSERT is
  **4.0/sec, 1200/1201 NULL-id** (zero-row); the churn is still live and neither prior fix had landed.
  Closed session 4's "one remaining hop": orphans are computed against the **active-only**
  `listConversationsForInfra` list, so a `done` conversation with a lingering host-wide tmux session
  is an eternal orphan, re-adopted every tick (**86 `done`/`poller` rows** confirm it). **Implemented
  both altitudes:** (1) the trigger boundary invariant (zero-row statement → no notify, all tables)
  and (2) the origin cure (`listExistingConversationIds` gate in the poller). `build` + `check` green.
  **Not pushed**; behavioral confirmation deferred to `singularity` (orphan adoption is
  `isMain()`-only).

- **2026-06-29 (6) — [the layered fix validated on `singularity` (deferred behavioral confirmation)](./archive/2026-06-29-noop-churn-fix-validated-on-main.md).**
  The fix landed on main (`1f6b27092`). Re-measured `singularity` live (did not inherit): **all three
  lines converge on the churn being gone.** Profile: `flushNotifies` **22.4 s → 571 ms** (avg 77 ms,
  zero wait); the `[acquire]` pool wait fell off the board entirely. DB: `live_state_changelog`
  `conversations` INSERT **4.0/s → 0.003/s with ZERO NULL-id statements** (the boundary invariant
  holds for `job_steps`/`job_waits` too); `live_state_snapshot` **155 MB → 14 MB** (autovacuum
  reclaimed it *on its own* once the churn stopped — the deferred `VACUUM FULL` proved unnecessary);
  `live-state-noop` accumulation stopped. The new top-frequency op is the cure's own
  `listExistingConversationIds` SELECT (423×, ~1.2/s, 7 ms, **no write**) — acknowledged
  **containment** of the 1 Hz poll, not a missed root. **Confirmed fixed; deferral closed.**
