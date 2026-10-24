# Kill the no-op-push churn: a boundary invariant (zero-row statements never invalidate) + the origin fix (the 1 Hz poller)

> **Supersedes** `research/2026-06-29-global-skip-unchanged-snapshot-persist.md` (the persist-skip)
> as the primary direction. The persist-skip removed only the snapshot-UPSERT *tail* of a no-op
> push. This doc attacks higher up the chain, at two altitudes:
>
> - **Containment (boundary invariant):** the change-feed trigger must never invalidate on a
>   zero-row statement. Makes the whole class structurally harmless for any caller.
> - **Cure (origin):** the conversations poller issues those zero-row `INSERT … ON CONFLICT DO
>   NOTHING`s ~2.6/sec because it polls every 1 s and re-classifies cross-worktree live tmux
>   sessions as "orphans." That illegitimate behavior is the actual root.
>
> See the methodology note for why the trigger fix alone is *containment, not the root* — and the
> stopping criteria that locate the origin at the poller. The persist-skip + one-time
> `VACUUM FULL` remain as lower-altitude defense-in-depth.

## Context

`research/perfs/archive/2026-06-29-snapshot-toast-bloat-noop-persist.md` found that six keyed,
boot-critical live-state resources (`tasks`, `attempts`, `conversations-system/gone/active`,
`agent-launches`) each fire **~2 no-op pushes/sec**, sustained (32k logged `live-state-noop`).
Each no-op push runs the loader, recomputes a byte-identical value, diffs it, walks the
cascade, and re-UPSERTs its ~0.4 MB snapshot blob. The snapshot UPSERT bloated
`live_state_snapshot` TOAST to 181 MB and produced a 21.9 s flush stall — but that is the
*tail*. The **upstream cost is the recompute itself**: ~12 loaders/sec firing for nothing.

**Why the no-op pushes happen (confirmed with data):**

- The dominant change source on main is `conversations` **INSERT statements at 2.62/sec**
  (`live_state_changelog`: 75,987 `I` entries) — yet the table has only **2,280 rows ever
  inserted** (`pg_stat_user_tables.n_tup_ins`). The mismatch is the tell.
- The runtime profile shows the writer: `INSERT INTO conversations … ON CONFLICT DO NOTHING`,
  1,512 calls, `parent: null` — the **hibernation poller re-adopting running conversations
  every cycle**. Almost every row hits the conflict, so **zero rows are actually inserted**.
- But the change-feed trigger is **STATEMENT-level** (`live_state_notify()`,
  `plugins/database/plugins/change-feed/server/internal/triggers.ts:91`). An `AFTER INSERT …
  FOR EACH STATEMENT` trigger fires once per *statement*, even when the statement inserted
  zero rows. Worse: `array_agg(pk) FROM new_rows` over the **empty** transition table returns
  `NULL` ids → the change is routed as **FULL-for-table**, invalidating *every* resource that
  reads `conversations`/`conversations_v` and *every* pk. That is the ~12 no-op recomputes/sec.

**Intended outcome:** stop generating the no-op invalidations at the source, so the loaders
never run, nothing recomputes, nothing persists. This is the cost the persist-skip could not
touch.

## The fix — one early-return in the trigger function

`live_state_notify()` already declares the transition table (`REFERENCING NEW TABLE AS
new_rows` for INSERT/UPDATE, `OLD TABLE AS old_rows` for DELETE). Add an emptiness check at the
top: if the statement affected **zero rows**, `RETURN NULL` before the `pg_notify` and the
`live_state_changelog` INSERT.

In `NOTIFY_FUNCTION_DDL` (`triggers.ts:91-135`), at the start of the `BEGIN` block:

```sql
DECLARE
  pk_col   text := TG_ARGV[0];
  ids      text[];
  has_rows boolean;
  payload  text;
BEGIN
  -- A statement that touched zero rows changed no data — e.g. INSERT … ON CONFLICT
  -- DO NOTHING that fully conflicted, or an UPDATE/DELETE matching no rows. The
  -- STATEMENT-level trigger still fires; suppress it here so a no-op statement never
  -- drives a (FULL-for-table) live-state recompute. Cannot miss a real invalidation:
  -- no affected row ⇒ no data change.
  IF TG_OP = 'DELETE' THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM old_rows)' INTO has_rows;
  ELSE
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM new_rows)' INTO has_rows;
  END IF;
  IF NOT has_rows THEN
    RETURN NULL;
  END IF;

  -- … existing body unchanged (array_agg ids, payload, octet_length cap,
  --     pg_notify, INSERT INTO live_state_changelog) …
```

- `EXISTS (SELECT 1 …)` short-circuits at the first row — O(1), cheaper than the `array_agg`
  the function already runs.
- Correct for all three ops: an INSERT/UPDATE/DELETE with an empty transition table affected
  no rows and therefore changed nothing. Nothing legitimately depends on a zero-row notify —
  the sole consumer is `applyDbChange` → recompute.
- **General**: fixes no-op-statement churn for *every* table, not just `conversations`.
- Data-less DDL: `CREATE OR REPLACE FUNCTION` is rebuilt on every boot by `rebuildTriggers`
  (not a migration). The fix lands purely by editing `NOTIFY_FUNCTION_DDL` and rebuilding.

### Single file
- `plugins/database/plugins/change-feed/server/internal/triggers.ts` — `NOTIFY_FUNCTION_DDL`
  (the `live_state_notify()` body, lines 91-135).

### Scope note — what this does and does not cover
- **Covered (the dominant churn):** zero-row statements — the `ON CONFLICT DO NOTHING`
  re-adoption upserts (~2.6/sec) and any UPDATE/DELETE matching no rows.
- **Not covered (smaller, separate):** a *same-value* UPDATE that does touch a row (Postgres
  still writes a new tuple and includes it in `new_rows`) would still notify. The changelog
  shows this is minor (`conversations` `U` = 446 vs `I` = 75,987). If it later matters, address
  it separately (row-level `WHEN (OLD.* IS DISTINCT FROM NEW.*)`, or the persist-skip below
  catches its tail). Out of scope here.

## Verification

1. `./equin build` (worktree); confirm clean restart and the change-feed boot log
   (`installed live_state triggers on N table(s)`).
2. **Trigger-level proof** via `query_db` on the worktree: capture
   `SELECT count(*) FROM live_state_changelog WHERE t='conversations' AND op='I'`, then run an
   `INSERT … ON CONFLICT DO NOTHING` that fully conflicts (e.g. re-insert an existing
   conversation id) and confirm the count **does not increase** — vs a genuinely new row, which
   **does** add exactly one changelog entry. (A non-mutating way to exercise this is to let the
   hibernation poller run a cycle and watch the count flatten.)
3. **No-op churn gone** via `get_runtime_profile` (worktree, kind `db`): the
   `live_state_snapshot` UPSERT count and the `tasks_v`/`attempts_v`/`conversations_v` loader
   query counts should drop to near the real-change rate; the `live-state-noop` monitor should
   stop accumulating for these six resources.
4. **Live correctness unaffected:** mutate a task/conversation in the app and confirm the lists
   still update live (real changes still notify); create a brand-new conversation and confirm it
   appears (a real insert still fires).

## Methodology lesson to record (land with this fix)

Add to `research/perfs/CLAUDE.md` (Method section) — the general principle this investigation
violated for three sessions, plus the stopping criteria (without which "go upstream" is just as
unfounded as stopping early):

> **Explain the rate, not just the cost. Trace to the origin, not the hotspot.**
> Every cost is `rate × cost-per-occurrence`. The profiler ranks by per-occurrence duration,
> which biases you toward making the expensive op faster — but the biggest number in a profile
> is usually a *downstream amplifier* of a smaller upstream driver. Amplitude is not causality.
> Decompose every hot op into rate and per-call cost, and walk the causal chain upstream
> (delivery ← recompute ← invalidation ← the write/trigger that fired it). A `no-op` /
> `redundant` / `unchanged` signal is a *direct instruction to look upstream*: the fix for
> wasted work is to not do it, never to do it more cheaply.
>
> **You can never prove there is no level above — stopping is a judgement, made by criteria, not
> certainty:**
> 1. **Sufficiency (quantitative):** the candidate cause's *rate* must reproduce the symptom's
>    rate (e.g. "writes at 2.6/s ≈ 2 no-op pushes/s/resource"). This proves you found *a
>    sufficient* cause — NOT the deepest. It is the minimum bar, and the one prior sessions
>    skipped.
> 2. **Legitimacy (the real stopping point):** at each node ask "*should* this event happen, at
>    this rate?" Stop ONLY when the answer is yes — behavior that is supposed to occur that
>    often (a user action, a real data change). A zero-row statement, a re-adoption every
>    second, a 1 Hz poll are all illegitimate → keep climbing.
> 3. **Counterfactual:** does fixing this node *remove* the illegitimate behavior or just make
>    it cheap? "Cheap" is containment, not a cure.
> 4. **Requirement boundary:** stop when the next level up is a genuine product requirement or
>    costs more than it saves.
>
> Corollary — fixes exist at multiple altitudes; name each and its altitude rather than crowning
> one "the root". A *boundary invariant* (make a whole class structurally harmless) is worth
> landing even when it is not the origin, but it does not absolve you from finding the origin.

This is why the persist-skip (this session's first plan) and the notifications/pool/git fixes
(prior sessions) were all downstream. **And it caught this very session overclaiming:** the
trigger fix below was first written up as "the origin." It is not — it is a *boundary invariant*.
The legitimacy test (criterion 2) shows the chain continues above it:

```
no-op recompute ← FULL-table invalidation ← trigger fires on a zero-row statement
  ← INSERT … ON CONFLICT DO NOTHING that fully conflicts ← poller re-adopts a non-orphan
  ← poller classifies cross-worktree live tmux sessions as "orphans" ← it polls every 1 s
```

The origin is the poller (illegitimate 1 Hz re-adoption), not the trigger.

## Secondary / follow-up items (no longer the primary fix)

- **Persist-skip (defense-in-depth):** the design in
  `research/2026-06-29-global-skip-unchanged-snapshot-persist.md` (hash-compare in `drainEntry`,
  skip the snapshot UPSERT when the value is unchanged). With the trigger fix, no-op pushes
  largely vanish, so this drops to optional — its remaining value is catching same-value-UPDATE
  tails and bounding TOAST growth from *real* large-blob rewrites. Low priority.
- **One-time `VACUUM (FULL, ANALYZE) live_state_snapshot` on `singularity`** — still required to
  reclaim the already-accumulated 181 MB TOAST (manual; not a migration; can't run via the
  read-only MCP tool). Run after the trigger fix lands.
- **Hibernation poller** (`plugins/conversations/server/internal/poller.ts`) — re-upserting all
  conversations every cycle via `INSERT … ON CONFLICT DO NOTHING` is wasteful query load and is
  interval-polling (against the repo's "no polling — use push-based" rule). The trigger fix
  removes its change-feed sting, but the poller itself is worth a separate look (does it need to
  re-adopt every cycle, or only on process-set change?). Flag, don't fix here.
