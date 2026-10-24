# Live-State L2 — persisted materialization (durable snapshot + bounded catch-up)

> **Category:** global (resource-runtime, server-core, database, infra)
> **Status:** design / plan (no code yet)
> **Parent design:** [`2026-06-19-global-live-state-sync-engine.md`](./2026-06-19-global-live-state-sync-engine.md) — this plan implements its **L2 rung** (§6) and resolves its **position-mechanism decision point** (§6, §10).

## 1. Context

Cold server boots recompute every **boot-critical** live-state resource view from
scratch (>4 s) on each deploy/restart. The runtime keeps **no server-side value
cache**: `warmBootResources()` reruns all ~21 boot-critical loaders at boot purely to
warm Postgres' buffer pool and then **discards the results**, and
`GET /api/resources/boot-snapshot` reruns them again per client request. The L4
change-feed (which already landed) is **purely ephemeral** `pg_notify` — on
reconnect/boot it does a `fullSweep()` (FULL invalidation of every triggered table),
i.e. the full recompute we want to eliminate. Nothing survives a restart.

**Outcome wanted:** cold boot = read a persisted snapshot (instant first paint) + a
**bounded** catch-up that recomputes *only* the resources whose tables actually
changed during downtime — never a full rebuild. For a typical deploy (server down a
few seconds) the catch-up is usually empty.

This is the **L2** rung from the parent doc. L3 (read-set capture) and L4
(change-feed triggers) are already in place and are reused wholesale.

## 2. Decision — durable monotonic position mechanism

The parent doc flagged this rung as the explicit choice between **logical
replication (LSN)**, **pg_ivm**, and **triggers + something durable**. Evaluated
against the actual embedded cluster:

| | **Triggers + changelog + xmin (CHOSEN)** | Logical replication (LSN) | pg_ivm |
|---|---|---|---|
| Correctness | Safe-by-approximation: conservative lower-bound watermark; over-replay harmless, under-replay impossible | Exact commit-ordered LSN | Always-fresh (maintained in write txn) — no position needed |
| Config change | **None** (`wal_level=replica` is fine) | `wal_level=logical` + cluster restart + edit hardcoded `start.ts -o` flags | `shared_preload_libraries=pg_ivm` + restart |
| Infra / op risk | Low — one extra table, bounded by a prune job | High — replication slot pins WAL; a dead worktree consumer can fill disk | **Extension NOT bundled** — needs a custom PG 18 build for all 4 platforms |
| Coverage | All boot-critical DB-backed resources | All | **Restricted SQL subset only** — can't express LIMIT/outer-join/window/TS-shaped/latest-per-task loaders |
| Code reuse | Maximal — extends existing trigger, reuses `routeChange`/`applyDbChange` cascade + boot-snapshot endpoint + `defineJob` | Low — a parallel CDC consumer | Low for the general case |

**pg_ivm rejected as the base:** the extension is absent from
`@embedded-postgres/*` v18.3.0-beta.17 (no `pg_ivm.control`), and even if bundled it
can only materialize a single supported SQL view — which excludes `attempts`
(two-query TS join), `conversations-gone` (`LIMIT 30`), `agent-launches`
(latest-per-task), and the git/fs resources. It cannot fix the cold load for most of
the boot-critical set. **Kept as a documented future selective optimization** (parent
doc's L3) for the 1–2 aggregations that fit, *if/when* a custom PG build lands — out
of scope here.

**Logical replication rejected:** gets an exact LSN for free but needs
`wal_level=logical` (cluster restart + editing the hardcoded `-o` flag string in
`embedded/scripts/start.ts`), introduces the replication-slot/WAL-retention lifecycle
(a crashed worktree consumer pins WAL → disk-fill risk across many worktrees), and a
direct-socket consumer. The parent doc §10 explicitly defers it "until a measured
need." There is no need for L2 that the chosen mechanism cannot meet.

### The key correctness argument (why an exact position is unnecessary)

The catch-up action is an **idempotent scoped recompute** — re-run the loader, diff,
push — **not** a destructive delta-apply to the stored value. So the persisted
position only needs to be a **conservative lower bound**:

- **Over-replay** (recomputing a resource whose change is already in the persisted
  value) is harmless — it re-derives an identical value, produces an empty keyed
  diff, sends no frame.
- **Under-replay** (missing a change) is the only failure mode and must be impossible.

Capture `position = pg_snapshot_xmin(pg_current_snapshot())` **before the loader's
first read**, and replay changelog rows with `xid >= position`. Any write not visible
to the loader's snapshot has `xid ≥ that snapshot's xmin ≥ position`; the trigger
stamps that write's changelog row with the same `xid`; so it satisfies the replay
predicate and is never missed. This dissolves the exact-position requirement that
motivates logical replication's LSN.

## 3. Design

Two derived-state tables (created `CREATE TABLE IF NOT EXISTS` on boot, **not**
migrations — same pattern as `__singularity_derived_view_state`), an extension to the
existing trigger function, a watermark capture + persist hook in the runtime's flush,
a boot-time snapshot read, a bounded catch-up driver, and a prune job.

### 3.1 `live_state_changelog` — the durable, transactional outbox

```sql
CREATE TABLE IF NOT EXISTS live_state_changelog (
  seq        bigserial PRIMARY KEY,        -- stable ordering / prune key only (NOT the watermark)
  xid        numeric   NOT NULL,           -- pg_current_xact_id() — 64-bit xid8, stored as numeric
  t          text      NOT NULL,           -- table name
  op         char(1)   NOT NULL,           -- 'I' | 'U' | 'D'
  ids        text[],                       -- changed PKs, or NULL (bulk / pk-less / over-cap → FULL)
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_state_changelog_xid_idx ON live_state_changelog (xid);
```

Written by **extending the existing `live_state_notify()` trigger function**
(`change-feed/server/internal/triggers.ts`) to also `INSERT` a row alongside its
current `pg_notify`. Because the INSERT is inside the same trigger/txn as the data
change, the changelog row commits **atomically** with the write (true transactional
outbox; a rolled-back write leaves no changelog row).

- `xid` via `pg_current_xact_id()::text::numeric` — **must** use the 64-bit `xid8`
  family (`pg_current_xact_id`, `pg_snapshot_xmin`), never the 32-bit `txid_*` forms
  (wraparound hole). `numeric` storage avoids signed-`bigint` overflow near 2^63.
- The over-cap / composite-PK branch already yields `ids = NULL`; mirror that into the
  changelog (`NULL` → FULL on catch-up).
- **Create `live_state_changelog` inside `change-feed`'s trigger-rebuild transaction,
  before the function DDL** — `onReadyBlocking` hooks run in parallel, so cross-plugin
  ordering isn't guaranteed; the table must exist before any trigger that inserts into
  it fires.
- **Add `live_state_changelog` and `live_state_snapshot` to the trigger `DENYLIST`**
  (`triggers.ts:14`) — a `live_state` trigger on the changelog would recurse
  infinitely.

### 3.2 `live_state_snapshot` — the persisted materialized value

```sql
CREATE TABLE IF NOT EXISTS live_state_snapshot (
  resource_key text    NOT NULL,
  params_key   text    NOT NULL,           -- "{}" for param-less boot-critical resources
  value        jsonb   NOT NULL,           -- the FULL loader output (same granularity as the snapshot endpoint)
  position     numeric NOT NULL,           -- xmin watermark captured before the value's reads
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_key, params_key)
);
```

Lives in the new `live-state-snapshot` plugin (no ordering dependency — only the
runtime/catch-up read & write it, in `onReady`).

### 3.3 Watermark capture + persist (in `drainEntry`)

In `resource-runtime/core/runtime.ts` `drainEntry`, for a persisted entry:

1. **Before** the `getResourceValue` call, `await opts.captureWatermark()` —
   `SELECT pg_snapshot_xmin(pg_current_snapshot())::text` through the normal Drizzle
   pool. (Read-only; does **not** force xid assignment. Does **not** need the same
   connection/txn as the loader — program-order `await` makes it a true floor across
   all of the loader's statements, including multi-query loaders like `attempts`.)
2. Run the loader **FULL** (see §3.6 point 2).
3. On success, `await opts.persistSnapshot(key, paramsKey, value, watermark)` —
   `INSERT … ON CONFLICT (resource_key, params_key) DO UPDATE`. Never persist on the
   loader-failure path (matches the existing snapshot-untouched-on-failure invariant).

New `ResourceRuntimeOptions` hooks (mirroring the existing injected-hook pattern so
core stays acyclic and the central runtime omits them):

```ts
captureWatermark?: () => Promise<string>;
persistSnapshot?: (key: string, pk: string, value: unknown, watermark: string) => Promise<void>;
shouldPersist?: (key: string) => boolean;   // backed by `bootCritical && !externalSource`
```

The server facade (`server-core/core/resources.ts`) backs them with DB calls + the
boot-critical/non-external set; the central facade omits them (identity), exactly as
it omits `wrapLoad` / `onDelivered` today.

### 3.4 Cold boot — instant snapshot read

Modify `boot-snapshot/server/internal/handle-boot-snapshot.ts` (and `boot-keys.ts`):
instead of `loadResourceByKey(k)` per boot-critical key, run one
`SELECT resource_key, value FROM live_state_snapshot WHERE resource_key = ANY(:keys)
AND params_key = '{}'` and return those values directly (low-ms, no loaders on the hot
path). For any boot-critical key with **no** persisted row (first-ever boot, or a
newly-added resource), fall back to `loadResourceByKey(k)` (current behavior).

### 3.5 Bounded catch-up (background, `onReady`)

New `live-state-snapshot/server/internal/catch-up.ts`, run from the plugin's `onReady`
(after the barrier, alongside the listener):

1. `SELECT resource_key, params_key, position FROM live_state_snapshot` →
   `minPosition = min(position)`.
2. `SELECT xid, t, op, ids FROM live_state_changelog WHERE xid >= :minPosition ORDER BY seq`
   — the bounded delta set (tiny after a short downtime; bounded by the prune cap
   otherwise).
3. For each changelog row, **replay it through the existing `routeChange({table:t, op, ids})`
   path** (`change-feed/server/internal/listener.ts:103`) — the exact same cascade the
   live listener uses (view-dependency expansion, identity-base routing, read-set
   inversion, fan-out to subscribed params). Catch-up ≡ "replay the missed changelog
   rows as if they just arrived." Over-replay of a row older than a given resource's
   own `position` is harmless (§2).
4. `op = 'D'` or `ids = NULL` → the routed change already degrades to FULL via
   `applyDbChange` (null ids → FULL). A scoped recompute never asserts membership, so
   deletes **must** go FULL — confirm catch-up passes null ids for `D`.
5. A resource whose `position` predates the oldest retained changelog row (floor older
   than the prune horizon) → enqueue an **unconditional FULL** recompute and log
   loudly (missing-history backstop). The listener's connect `fullSweep()` covers
   subscribed resources as additional defense-in-depth.
6. Recomputed values flow through the normal cascade → push to subscribers →
   re-persist with a fresh watermark, advancing the floor.

### 3.6 Behavior changes to get right

1. **Persist even with zero subscribers.** `drainEntry` currently computes `value`
   only when `needValue`. For persisted entries set `needValue = true` regardless of
   subscribers — otherwise the persisted snapshot never refreshes while no tab is open
   and cold boot serves an ever-staler value. This means **persisted resources
   recompute-on-change even when unsubscribed** (bounded by the ~21-resource set and
   the work-admission scheduler). This is the intended L2 cost of instant boot.
2. **Persist the FULL value, never a scoped partial.** When a recompute is scoped
   (`ctx.affectedIds`), `value` is a partial array. For persisted entries always
   recompute FULL (the persisted set is small) — this also sidesteps the
   scoped-delete-doesn't-assert-membership issue.

### 3.7 Prune job

A `defineJob` with a `schedule` crontab (e.g. hourly), main-only, via graphile-worker
native cron — **not** `setInterval`:

```sql
DELETE FROM live_state_changelog
WHERE xid < (SELECT COALESCE(min(position), 0) FROM live_state_snapshot)
   OR at < now() - interval '<cap>';
```

`xid < min(position)` is the safe lower bound (every snapshot already incorporates
older rows). The `at < now() - cap` hard ceiling bounds the table even if a stale
floor would otherwise pin it forever; down-longer-than-cap → those resources fall to
the FULL backstop (§3.5 step 5) — bounded and correct.

## 4. Scope — which resources persist

- **Boot-critical AND DB-backed** (`bootCritical && !externalSource`): **persist**.
  The expensive cold-load views — `tasks`, `attempts`, `conversations-*`,
  `agent-launches`, `notifications`, `build.history`, etc. Keyed resources persist
  their full value under `params_key = "{}"` (same granularity as the snapshot
  endpoint today).
- **External / non-DB** (`worktree-ops` filesystem, `build.mainAheadCount` git
  subprocess, transcript readers): **excluded.** They read no triggered table, so
  "no changelog rows → already current" would strand them. They keep the existing
  warm path + sub-ack and self-heal via their watcher's reconcile notify. Gate on the
  runtime's existing `entry.externalSource`. (Git-state incrementality is the parent
  doc's separate follow-up cost class.)
- **Param-keyed (route-scoped) resources** (per-conversation, etc.): out of L2 v1 —
  the server can't know a client's route params at snapshot time. They self-heal via
  sub-ack, now fast because catch-up + the snapshot read primed their tables. A future
  extension once a client-params hint exists (parent doc §10 auth-hook seam).

## 5. Critical files

- `plugins/database/plugins/change-feed/server/internal/triggers.ts` — extend
  `live_state_notify()` to INSERT changelog rows; create `live_state_changelog` in the
  rebuild txn; denylist both new tables.
- `plugins/database/plugins/change-feed/server/internal/listener.ts` — the
  `routeChange`/`applyDbChange` cascade catch-up reuses.
- **NEW** `plugins/database/plugins/live-state-snapshot/` — `server/index.ts`
  (`onReadyBlocking` creates `live_state_snapshot`; `onReady` runs catch-up; registers
  prune job), `server/internal/{catch-up,prune,persist,tables-ddl}.ts`.
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — add
  `captureWatermark`/`persistSnapshot`/`shouldPersist` hooks; capture-before-load +
  persist in `drainEntry`; `needValue = true` + FULL recompute for persisted entries.
- `plugins/framework/plugins/server-core/core/resources.ts` — wire the new hooks on
  the server facade, backed by DB + the `bootCritical && !externalSource` set.
- `plugins/infra/plugins/boot-snapshot/server/internal/handle-boot-snapshot.ts` +
  `boot-keys.ts` — serve persisted `live_state_snapshot` values, fall back to
  `loadResourceByKey` on miss.

## 6. Invariants that must hold (correctness-critical)

1. Capture the xmin watermark **before the loader's first query** (the pgbouncer pool
   makes a loader N independent autocommit snapshots — "before the reads" = "before the
   first of N").
2. Use the **`xid8`** family throughout; store `xid`/`position` as `numeric`.
3. **Denylist** `live_state_changelog`/`live_state_snapshot` in the trigger set (recursion).
4. Create `live_state_changelog` **inside** change-feed's trigger-rebuild txn, before
   the function DDL.
5. DELETE ops and `ids = NULL` (bulk / pk-less / over-cap) → **FULL** recompute in catch-up.
6. **External-source (git/fs) resources are excluded** from L2 and never trusted as
   catch-up-complete.
7. Persisted entries recompute **FULL** and persist **even with zero subscribers**;
   never persist a scoped partial.

## 7. Phasing

1. Trigger extension + `live_state_changelog` table + prune job (changelog is durable,
   nothing reads it yet). Verify rows accrue atomically with writes and prune bounds them.
2. `live_state_snapshot` table + `captureWatermark`/`persistSnapshot` hooks in
   `drainEntry`; persist boot-critical DB-backed resources on recompute. Verify the
   table fills with fresh values + correct watermarks.
3. Boot reads the snapshot (boot-snapshot endpoint + warm path). Verify instant first
   paint. Fall back to `loadResourceByKey` on miss.
4. Catch-up driver in `onReady` replaying the changelog through `routeChange`. Verify
   bounded catch-up + convergence.

## 8. Verification (end-to-end)

- **Instant first paint:** `./equin build` + restart → first paint reads
  `live_state_snapshot` (low-ms), not the ~4 s rebuild. Confirm via `get_runtime_profile`
  (zero `loader` runs for persisted keys on the hot request path).
- **Bounded catch-up:** with the server **down**, insert an attempt via `psql`
  (out-of-process). Restart → (a) persisted snapshot served immediately, (b) catch-up
  replays exactly that changelog row, (c) the resource converges, (d) resources whose
  tables were untouched did **zero** catch-up work.
- **Miss-impossible (watermark floor):** persist, then on next boot diff the persisted
  value against a from-scratch `loadResourceByKey` — they must converge after catch-up
  (no silent torn-and-stuck value), including the `attempts` multi-query case.
- **DELETE / membership:** delete a row out-of-process while down → catch-up FULL-recomputes
  and the row disappears from the keyed value (a scoped path would have left it).
- **External self-heal:** advance a git ref while down → the git resource is not trusted
  from a stale snapshot; the git-watcher's reconcile notify corrects it post-boot.
- **Prune:** the job never deletes a row at/above `min(position)`; force a stale floor
  and confirm the time-cap clause bounds the table and triggers the FULL backstop.
- **No config drift:** `wal_level` stays `replica`, `shared_preload_libraries` empty,
  `start.ts -o` unchanged; `./equin check` passes.
