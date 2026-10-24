# L4 — DB change-feed: structural live-state invalidation

> **Category:** global (resource-runtime, server-core, database, debug)
> **Status:** design / plan (no code yet)
> **Parent vision:** [`2026-06-19-global-live-state-sync-engine.md`](./2026-06-19-global-live-state-sync-engine.md) — this is **step 2 / L4** of its phasing.
> **Sibling (shared contract):** [`2026-06-19-global-live-state-work-admission-model.md`](./2026-06-19-global-live-state-work-admission-model.md) (worktree `att-1781872031-6620`).
> **Builds on (landed):** L3 read-set capture — `07923fdf8`.

## 1. Context

Live-state keeps the DB as source of truth and propagates values via **hand-called
`notify()`** at ~155 mutation sites. Consistency rides on discipline, not
guarantees: a skipped `notify()` silently serves stale state, the planned
server-side read-through cache makes that staleness survive reloads, and
out-of-process writes (agent `psql`, the DB fork, MCP tooling) are invisible to
`notify()` entirely.

L3 (just landed) gives us the missing dependency primitive: an automatic
`table → [resource keys]` index (`readSetIndex` in
`plugins/infra/plugins/runtime-profiler/core/recorder.ts`, exposed as
`getReadSetIndex()` and wired into the runtime as the `readSet(key)` hook). **L4
adds the missing *source of change*:** generic Postgres triggers that
`pg_notify` on every commit, and one `LISTEN` consumer that routes each change —
through the L3 index — into the existing recompute cascade.

**Outcome:** a missed invalidation becomes *structurally impossible* for any
DB-backed resource, and out-of-process writes become visible. This task ships the
feed **alongside** hand-`notify()` (self-verifying migration) — it does **not**
delete any `notify()` call (that is step 3 of the parent doc, a follow-up).

## 2. The shared contract (define now, reconcile later)

Define in `resource-runtime/core` exactly as the parent doc specifies, so the
work-admission scheduler (separate worktree) can consume it when it lands:

```ts
export type RecomputeIntent = {
  resource: string;          // resource key
  key: ResourceParams;       // the params tuple (paramsKey-able)
  delta:
    | { table: string; ids: string[]; op: "I" | "U" | "D" }
    | "FULL";
};
```

Today there is **no scheduler**; the "admit" side is `scheduleNotify` →
`mergePending` → `flushNotifies`. So the feed *produces* `RecomputeIntent`s and
routes them through `scheduleNotify` (mapping `delta → affected`). When the
scheduler lands, it replaces only the consumption side — the producer is
unchanged. Reconcile the type with that worktree if it diverged.

## 3. Architecture

```
 commit (app OR psql/fork/MCP)
   │  AFTER STATEMENT trigger (transition tables)
   ▼
 pg_notify('live_state', {t, op, ids})           ← one NOTIFY per statement, capped
   │  (delivered on COMMIT, via direct socket)
   ▼
 LISTEN consumer  [plugins/database/plugins/change-feed]
   │  parse → DbChange { table, op, ids }
   ▼
 runtime.applyDbChange(change)  [resource-runtime/core, exposed via server-core]
   │  ① table → [resourceKeys]   (invert the L3 readSet hook)
   │  ② fan out to subscribed params per resource (param-less → {})
   │  ③ build RecomputeIntent per (resource, key) with the delta
   │  ④ map delta → affected:  op U → Set(ids) (scoped);  op I/D or ids=null → null (FULL)
   ▼
 scheduleNotify(entry, params, affected, { source: "feed" })   ← existing cascade
   │  mergePending → flushNotifies → drainEntry → affectedMap → clients
```

The change-feed plugin is **pure transport** (own the socket, parse payloads).
**All routing lives in the runtime**, where the registry, the `readSet` hook, and
the subscriber map already are — keeping runtime internals unexposed.

## 4. Part A — Triggers (derived DDL on boot)

Triggers are deterministic, data-less code — rebuilt on every boot like
derived-views, **never a migration** (confirmed: mirrors
`plugins/database/plugins/derived-views/server/internal/rebuild.ts`).

**New: `plugins/database/plugins/change-feed/server/internal/triggers.ts`**

- One generic function `live_state_notify()` (plpgsql, `STATEMENT`-level). Uses
  `TG_OP` + dynamic SQL over the transition table (`new_rows` for I/U,
  `old_rows` for D) to collect the changed PK values into a `text[]`:
  ```sql
  EXECUTE format('SELECT array_agg(%I::text) FROM %I', pk_col, transition_tbl) INTO ids;
  ```
  PK column is passed per-table as `TG_ARGV[0]`. Builds payload
  `json_build_object('t', TG_TABLE_NAME, 'op', left(TG_OP,1), 'ids', ids)`; if
  `octet_length(payload) > 7000` (the ~8 KB NOTIFY limit) it re-emits with
  `ids = null` → consumer treats it as **FULL-for-table**. `RETURN NULL`.
- `rebuildTriggers(db)`:
  1. Enumerate every public-schema user table (`SELECT relname FROM
     pg_stat_user_tables WHERE schemaname='public'`), minus a small denylist
     (start: `__singularity_migrations`; graphile lives in its own schema, auto-excluded).
  2. For each, find the single-column PK via `pg_index`/`pg_attribute`
     (`indisprimary`). Single col → pass as `TG_ARGV[0]`; composite/none → pass
     empty → function emits `ids=null` (FULL-for-table, still correct).
  3. `CREATE OR REPLACE FUNCTION` once; per table issue `DROP TRIGGER IF EXISTS`
     + 3 `CREATE TRIGGER` (INSERT / UPDATE / DELETE, each declaring its
     transition table). Idempotent; wrapped in one transaction like
     `rebuildDerivedViews`.
- Called from the change-feed plugin's `onReadyBlocking()` (after the DB is
  migrated; order vs derived-views is irrelevant). Uses the `db` handle from the
  database server barrel.

Why all-tables-auto (your choice): a new table is covered with zero code; a
trigger on an unread table is harmless (consumer finds no resource and drops it).
A new `change-feed:triggers-cover-tables` check asserts every public table (minus
denylist) carries the trigger — a consistency check, not hand-work.

## 5. Part B — LISTEN consumer (transport + reconcile)

**New: `plugins/database/plugins/change-feed/server/internal/listener.ts`**

- A single raw `pg` `Client` on `connectionString()` from
  `@plugins/database/plugins/admin/server` — the **direct socket** (pgbouncer
  breaks `LISTEN`; this is the path graphile-worker already uses). `await
  client.query("LISTEN live_state")`.
- `client.on("notification", n => applyDbChange(parse(n.payload)))` →
  `applyDbChange` from `@plugins/framework/plugins/server-core/server`.
- **Reconnect + reconcile**, mirroring git-watcher
  (`plugins/infra/plugins/file-watcher/server/internal/create-file-watcher.ts`
  `reconcileMs`): on `error`/`end`, reconnect with backoff; a periodic liveness
  `setInterval` re-establishes a dead socket. **On every (re)connect, fire a FULL
  invalidation for all currently-subscribed resources** (a dropped connection may
  have missed NOTIFYs — mark-stale-on-reconnect, can never strand state).
- Wired from the plugin's `onReady()` (background, after the ready barrier);
  stopped in `onShutdown()`.

## 6. Part C — Runtime routing (`applyDbChange`)

**`plugins/framework/plugins/resource-runtime/core/runtime.ts`** (+ re-expose via
`plugins/framework/plugins/server-core/core/resources.ts`):

- `applyDbChange(change: { table: string; op: "I"|"U"|"D"; ids: string[] | null })`:
  1. **Invert the read-set:** build `table → [resourceKey]` by iterating the
     registry and calling the existing `opts.readSet(key)` hook. Memoize, keyed
     by the readSet index size (it only grows). Raw-SQL loaders fall back to
     whole-table (L3 already coarsens these), which is correct, just broad.
  2. For each affected resource: if param-less, `key = {}`; else **fan out to all
     currently-subscribed params** (recover the `ResourceParams` objects from the
     socket `subs` map — internal to the runtime). Admit-if-subscribed: an unread
     param needs no work; a fresh subscribe loads from scratch.
  3. Build a `RecomputeIntent` per `(resource, key)` carrying the delta.
  4. Map `delta → affected`: **op `U` with ids → `Set(ids)` (Layer-2 scoped)**;
     **op `I`/`D`, or `ids=null` → `null` (FULL)** — matches today's discipline
     (membership/order change = full; scope can't express a vanished row), and a
     scoped keyed loader naturally filters by `param AND id IN (…)`.
  5. Route each through `scheduleNotify(entry, key, affected, { source: "feed" })`.
- `scheduleNotify` gains an optional `source: "hand" | "feed"` (default `"hand"`)
  threaded only to the self-verification recorder below — the cascade is otherwise
  byte-identical. `notify()` (the public method) stays `(params?, {affectedIds?})`
  — **unchanged**.

## 7. Self-verifying parallel run

The feed and hand-`notify()` run together; divergence is surfaced, not silent:

- Per-resource counters `{ hand, feed, lastHandAt, lastFeedAt }` recorded in
  `scheduleNotify` (tagged by `source`). A small ring buffer of recent feed
  intents `(resourceKey, pk, t)`.
- When a **hand**-notify fires with no matching feed intent for the same
  `(resource, pk)` within a short window → log a **read-set-gap candidate**
  (points straight at a table the L3 capture missed → the bug class we're
  eliminating). A **feed-only** intent is expected (out-of-process writes, or a
  hand-notify that is now provably redundant → a future deletion).
- Surface the counters + gap flags in the existing **read-set debug pane**
  (`plugins/debug/plugins/read-set/`): extend the `_debug` payload
  (`handleResourcesDebug` in `runtime.ts`) and `resourceReadSetSchema` with
  `notifyStats: { hand, feed }`, and add a column/flag in `read-set-view.tsx`
  alongside the existing `dependsOn` diff.

## 8. Critical files

| File | Change |
|---|---|
| `plugins/framework/plugins/resource-runtime/core/runtime.ts` | `RecomputeIntent` type; `applyDbChange`; table→resource inverse (memoized); subscribed-param fan-out; `source` on `scheduleNotify`; notify-stat counters; extend `handleResourcesDebug` payload |
| `plugins/framework/plugins/server-core/core/resources.ts` | re-expose `applyDbChange` from the runtime instance |
| `plugins/database/plugins/change-feed/` *(new)* | `server/internal/triggers.ts` (`rebuildTriggers`), `server/internal/listener.ts` (LISTEN + reconcile), `server/index.ts` (`onReadyBlocking` → triggers, `onReady` → listener, `onShutdown` → stop), barrels |
| `plugins/database/plugins/change-feed/check/index.ts` *(new)* | `change-feed:triggers-cover-tables` — assert every public table (minus denylist) carries the trigger |
| `plugins/debug/plugins/read-set/shared/{schema,endpoints}.ts` + `web/components/read-set-view.tsx` | add `notifyStats` + gap flag |

**Reused (do not reinvent):** `getReadSetIndex()` / `readSet` hook (L3);
`scheduleNotify`/`mergePending`/`flushNotifies`/`affectedMap` (cascade);
`connectionString()` (direct socket); `rebuildDerivedViews` (DDL-on-boot model);
`createFileWatcher` `reconcileMs` (reconnect pattern); `Resource.Declare` boot
metadata.

## 9. Boundary & layering notes

- The change-feed plugin imports two barrels only:
  `@plugins/database/plugins/admin/server` (`connectionString`) and
  `@plugins/framework/plugins/server-core/server` (`applyDbChange`) + the db
  handle. All legal barrel imports.
- `applyDbChange` is DB-agnostic (`{table, op, ids}`) — the runtime already
  reasons about table names via `readSet`, so this adds no new coupling.
- No polling: the feed is push (NOTIFY on commit); the only timers are the
  reconnect-liveness check and the existing debounce — both push-adjacent, not
  change-polling.

## 10. Known caveats / follow-ups (flag, don't silently absorb)

- **Lazy index gap.** `readSetIndex` is populated only after a loader first runs.
  A change to a table no loader has yet read maps to no resource. Covered during
  this task by (a) hand-`notify()` still firing in parallel, (b) the
  on-reconnect FULL sweep, and (c) a fresh subscribe always loading from scratch.
  Genuinely closed only at step 3 (delete-notify), gated on the debug pane showing
  the feed covers the table.
- **Bulk-write degradation.** Over-cap statements emit `ids=null` → FULL-for-table
  (correct, coarse). Acceptable for the rare bulk path (fork/backup).
- **Composite/PK-less tables** → FULL-for-table (no scoping). Fine; refine later.
- **DELETE scoping** is intentionally FULL (a vanished row can't feed a scoped
  `WHERE id IN`). Matches existing hand-notify discipline.
- **Predicate-level read-sets** (which *param* reads which row) remain out of
  scope — table-level match + subscribed-param fan-out first, per the parent doc.

## 10b. Implementation addendum — view-dependency expansion (REQUIRED, found during impl)

The original plan missed an impedance mismatch that broke the feature for most
core resources: **triggers fire on base tables, but loaders read the
derived-views layer** (`tasks_v`, `attempts_v`, …), so the L3 read-set records
the *view* name, not the base table. A write to `tasks` mapped to no resource
because `tasks` resource reads `tasks_v`.

Fix (shipped): `plugins/database/plugins/change-feed/server/internal/view-deps.ts`
computes, once at `onReady` (after derived-views are rebuilt), the **transitive
closure** `base relation → every view that depends on it` from
`information_schema.view_table_usage` (handles views-on-views, e.g.
`tasks_v` → `attempts_v`). The listener's `routeChange()` applies the base-table
change directly (scoped via ids) **and** fires a FULL (`ids:null`) invalidation
for each dependent view — because a view's row identity isn't guaranteed to match
the base PK. `fullSweep()` (on every pg-socket (re)connect) routes through the
same expansion. This lives in the DB-aware change-feed, not the framework runtime.

## 11. Verification

1. **Triggers exist:** after `./equin build`, `mcp__singularity__query_db`
   `SELECT tgname FROM pg_trigger WHERE tgname LIKE 'live_state_%'` lists 3 per
   public table; the new check passes.
2. **Out-of-process write is caught:** subscribe a tab to tasks, then `psql`/
   `query_db`-style direct `UPDATE tasks SET …` (out-of-process) → the feed-intent
   counter increments and the tab updates. (Today, with hand-`notify()` only, an
   out-of-process write does **not** update — this is the new capability.)
3. **Scoped vs full:** `mcp__singularity__get_runtime_profile kind:"loader"` shows
   a single-row `UPDATE` recomputing scoped (op `U`), an `INSERT`/`DELETE` going
   FULL.
4. **Reconcile:** kill the `LISTEN` client (or restart PG) → on reconnect a FULL
   sweep fires for subscribed resources; state recovers within the liveness window.
5. **Self-verification:** the read-set debug pane shows per-resource `hand` vs
   `feed` counts; exercise each mutation surface and confirm no persistent
   read-set-gap candidates (each gap = a real L3 capture miss to fix).
6. `./equin build` + `./equin check` pass (incl. boundaries, type-check,
   the new trigger-coverage check).
