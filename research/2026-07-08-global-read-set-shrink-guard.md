# Read-set shrink guard: surface a shed dependency for human confirmation

Date: 2026-07-08
Scope: global (live-state L2 persisted materialization; Debug → Reports)
Follows: `research/2026-07-07-global-read-set-self-heal-on-full-recompute.md`

## Problem

The read-set self-heal (replace-not-union on FULL recompute) persists the tables a
`bootCritical` resource read on its **last FULL run**, so a dropped dependency is
shed from `live_state_snapshot.tables_read`. This is safe today only because an
empirical fact holds: every persisted resource FULL-recomputes a **fixed,
data-independent** table set (verified by inspection at ship time). Nothing
structurally enforces that invariant.

A future `bootCritical` resource whose loader issues a **data-dependent conditional
query** (reads table X only for some data states) would, on a FULL recompute where
the condition isn't met, persist a read-set missing X. If X then changes during
downtime and the resource's UI is hydrated-but-never-subscribed that session, its
first-paint value could be briefly stale.

The core difficulty: **code-change-removed-a-dependency (safe to shed)** and
**conditional-query-didn't-fire (unsafe to shed)** are indistinguishable at persist
time. We cannot auto-decide — auto-refusing to shed would defeat the self-heal;
auto-shedding is the current (correct) behaviour. So the right move is a **cheap,
non-fatal signal for a human to confirm**, not a behaviour change.

## Why not a static `./equin check`

Detecting a data-dependent conditional table read requires static analysis of loader
bodies to find branches that read a table only under a runtime condition — brittle,
not cleanly expressible, and defeated by any indirection (helper calls, dynamic SQL,
`queryResource` compiles). A **runtime signal at the exact moment a shed happens** is
both cheaper and strictly more accurate: it observes the real read-sets rather than
guessing from source.

## Design: shrink detection at persist + a Debug → Reports kind

### Signal

At the persist chokepoint (`persistSnapshot`), compare the read-set we're about to
write (REPLACE) against the **currently-persisted** set for that
`(resource_key, params_key)`. If the new set **drops** any table the old set had
(`dropped = old − new` is non-empty), that is the ambiguous shed — emit a signal.

This is the ONLY place the shed is observable: after the upsert the durable set equals
the new set, so on the next persist `old == new` (no shrink). The detection is
therefore **one-shot per shed**, which is exactly right — a legitimate code-change
shed fires once, a human confirms, and dedup absorbs the rest.

The old value is captured in the **same upsert statement** via a data-modifying CTE, so
there is zero extra round-trip and the read is snapshot-consistent (the CTE `SELECT`
sees the row as of statement start, before the upsert's effect):

```sql
WITH prev AS (
  SELECT tables_read AS old_tables
  FROM live_state_snapshot
  WHERE resource_key = $key AND params_key = $paramsKey
)
INSERT INTO live_state_snapshot (...) VALUES (...)
ON CONFLICT (resource_key, params_key) DO UPDATE SET ...
RETURNING (SELECT old_tables FROM prev) AS old_tables, tables_read AS new_tables
```

On a fresh INSERT (no prior row) `prev` is empty → `old_tables` is NULL → no shrink.

Comparing against the **durably-persisted** old value (not an in-memory last-run) is
deliberate: the primary scenario is a code change that shed a table, first detected on
the **first boot with the new code**, where the persisted old value still carries the
dropped table. An in-memory baseline would be NULL on that first post-boot persist and
miss it.

### No false positives today

Every persisted resource reads its fixed table set on every FULL (and scoped —
same `FROM`/`JOIN`, only `WHERE` differs) run, so `old == new` after the first stable
persist → the report never fires in steady state. It fires only on a genuine shed:
a code change (fires once, expected) or the hypothetical future conditional query
(fires, possibly recurring — the signal we want). The `persistReadSet` union fallback
(scoped cycle that ran no loader) yields `new ⊇ old`, so it can never produce a false
shrink.

### Plumbing (mirrors the live-state-churn monitor precedent)

- **Seam** — `live-state-snapshot` exposes `onReadSetShrink(cb)` (server barrel) +
  an internal `emitReadSetShrink(e)`. `persistSnapshot` calls `emitReadSetShrink`
  when it detects a shed. The seam keeps the database-infra plugin free of any
  dependency on `reports`/`debug` (dependency inversion, like `onResourcePush`).
- **New debug plugin** `plugins/debug/plugins/read-set-shrink/` (flat under the
  `debug` umbrella, mirroring `op-rate` / `queue-health`):
  - `onReady` subscribes `onReadSetShrink(recordShrink)` — the handler is a **pure
    in-memory write** into a small accumulator (`Map<resourceKey, event>`, capped),
    so the persist path never touches async report I/O.
  - A per-worktree scheduled `defineJob` (`cron: "* * * * *"`) drains the accumulator
    and calls `recordReport` — `recordReport` throwing inside a job's `run` is safe
    (retried), which is why the accumulator+job split is used rather than filing
    inline from the sync persist hook. This is the exact churn/op-rate pattern.
  - Report kind `read-set-shrink`, source `server-read-set-monitor`, variant
    `warning`, fingerprint `read-set-shrink:${resourceKey}` (dedup per resource; the
    row `count` discriminates one-time code change vs recurring conditional query),
    6h notif cooldown.
  - `config_v2` descriptor `read-set-shrink` with a single `enabled` toggle
    (checked in the job before filing), registered server + web.
  - Web: a one-line `Reports.KindView` summary + `ConfigV2.WebRegister`.

### Report payload

`{ resourceKey, droppedTables, oldTables, newTables }`. The `renderTask` description
explains the two possibilities and points the reader at the discriminator: `count == 1`
→ likely a one-time code-change shed (safe, dismiss); recurring → likely a
conditional query firing intermittently (audit the loader — add the table to a stable
read path so the persisted set stays a superset).

## Behaviour changes

None to the self-heal. `tables_read` is still REPLACE-persisted exactly as before;
live routing still uses the in-memory union. The only addition is an observability
signal on the rare shed. On the first boot after this ships, any resource still
carrying a historical mis-attribution in its persisted set (that the 2026-07-07
self-heal hasn't yet shed) will fire one confirming report as it sheds — expected and
self-limiting.

## Follow-ups

- If a future conditional-query resource is genuinely intended, the fix is to make its
  FULL loader read the conditional table unconditionally (e.g. a cheap `EXISTS`/count
  on a stable path) so the persisted set stays a superset — the report is what
  prompts that.
