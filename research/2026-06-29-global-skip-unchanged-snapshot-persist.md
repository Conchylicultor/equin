# Skip the `live_state_snapshot` UPSERT when the value is unchanged

## Context

Performance investigation `research/perfs/archive/2026-06-29-snapshot-toast-bloat-noop-persist.md`
confirmed (live profile + DB + code) the current dominant cause of multi-second page/flush
stalls on main:

- `live_state_snapshot` is **181 MB of TOAST for 20 logical rows** — pure bloat (11k dead
  TOAST tuples, ~3M lifetime `n_tup_upd`). A single UPSERT into it stalled **21.9 s**, and
  because `flushNotifies` serializes, that one write inflated every co-flushed resource's
  delivery to ~22 s.
- The bloat is re-fed structurally: in `drainEntry`, the runtime UPSERTs the **full** snapshot
  value on every flush **unconditionally — including no-op pushes** (the persist runs *before*
  the diff that would reveal the no-op). Six keyed+boot-critical resources (`tasks`,
  `attempts`, `conversations-system/gone/active`, `agent-launches`) each fire **~2 no-op
  pushes/sec**, sustained (32k logged `live-state-noop`), each rewriting its ~0.4 MB blob for
  zero value change.

**Intended outcome:** stop the no-op TOAST re-bloat at its source by skipping the snapshot
UPSERT when the freshly recomputed value is byte-identical to what we last persisted. This
removes the ~12 redundant TOAST rewrites/sec and the 22 s-UPSERT hazard. A separate one-time
`VACUUM (FULL) live_state_snapshot` reclaims the already-accumulated 181 MB (follow-up, below).

## Why this is safe (self-healing)

Skipping a persist leaves that resource's row (`position` xmin watermark, `tables_read`,
`updated_at`) at its prior values. Confirmed safe on all three:

- **`position`** is read only as `min(position)` across all rows — the cold-boot catch-up
  replay floor (`catch-up.ts:57`, predicate `xid >= minPosition`) and the prune lower bound
  (`prune.ts:35`). An un-advanced (older) position makes the floor *more* conservative —
  catch-up replays *more* changelog rows (idempotently recomputing the same value), never
  fewer. Under-replay is structurally impossible.
- **`tables_read`** — if the value is unchanged the read-set is the same; an unchanged loader's
  prior read-set still routes catch-up correctly.
- **`updated_at`** — no consumer reads it for any TTL/staleness/eviction decision (only written
  for observability).

Crucially, this makes the change **self-healing even under a hash collision**: live delivery is
driven by `diffKeyed`/push (independent of the hash), so subscribers still get the new value
live; only the *persisted* L2 row could go stale on a collision, and cold-boot catch-up repairs
it from the un-advanced position floor. So correctness does not depend on a collision-free hash.

## Design

All change detection lives in `drainEntry`; the persist hook becomes a pure "write these bytes".

### 1. `plugins/framework/plugins/resource-runtime/core/runtime.ts`

- **Add per-pk hash memory to `RegistryEntry`** (near the `snapshots` field, ~line 424):
  ```ts
  /** pk → hash of the last value we persisted to L2. Lets drainEntry skip a
   *  redundant snapshot UPSERT when a (no-op) recompute produced an identical
   *  value — the dominant `live_state_snapshot` TOAST-bloat driver. Server-only
   *  (set only on the `persisted` path); central never persists. Coexists with
   *  `snapshots` (keyed-mode diff memory) — they are independent. */
  lastPersistedHash?: Map<string, string>;
  ```
  (Note: keyed + boot-critical resources like `tasks`/`attempts` carry *both* `snapshots` and
  `lastPersistedHash`; that is fine — different concerns.)

- **Replace the unconditional persist block** (currently lines 1408–1419). `captureWatermark`
  stays where it is (line 1377, before the loader — required invariant). After the loader
  computes `value`:
  ```ts
  if (persisted && watermark !== undefined && opts.persistSnapshot) {
    const serialized = JSON.stringify(value);
    const hash = Bun.hash(serialized).toString();
    if (entry.lastPersistedHash?.get(pk) !== hash) {
      const tablesRead = opts.readSet?.(entry.key) ?? [];
      try {
        await opts.persistSnapshot(entry.key, pk, serialized, watermark, tablesRead);
        (entry.lastPersistedHash ??= new Map()).set(pk, hash);
      } catch (err) {
        reportLoaderError(`snapshot persist failed for ${entry.key}`, err);
      }
    }
  }
  ```
  - The hash is set **only after a successful persist**, so a thrown/caught persist retries next
    time (no false "unchanged").
  - `Bun.hash` (Wyhash, 64-bit, zero import — both server-core and central-core run on Bun) is
    chosen for throughput on a ~0.4 MB string at ~12 Hz; collisions are non-catastrophic (see
    above). Acceptable alternative: `createHash("sha1")` (precedent:
    `plugins/conversations/plugins/all-conversations/server/internal/revision-resource.ts:44`).
  - `JSON.stringify(value)` is deterministic for a given loader output (stable key order, same
    query/columns) — the same property `revision-resource.ts` already relies on. We compare our
    serialization to our previous serialization (never to the DB's canonicalized jsonb).

- **Update the `ResourceRuntimeOptions.persistSnapshot` type** (~line 573): the 3rd parameter
  changes from `value: unknown` to `serializedValue: string`.

### 2. `plugins/database/plugins/live-state-snapshot/server/internal/persist.ts`

`persistSnapshot` takes the pre-serialized string instead of the object (the runtime now owns
serialization, so we avoid double-stringifying the blob):
```ts
export async function persistSnapshot(
  key: string, paramsKey: string, serializedValue: string,
  watermark: string, tablesRead: readonly string[],
): Promise<void> { … VALUES (…, ${serializedValue}::jsonb, …) … }
```
Behaviorally identical — currently it binds `${JSON.stringify(value)}`; now it binds the string
the runtime already produced. (text param → `::jsonb` cast, same as today.)

### 3. `plugins/framework/plugins/server-core/core/resources.ts`

Update the injected `persistSnapshot` closure (lines 239–243) to pass the `serializedValue`
string through to `liveStateSnapshotHooks.persistSnapshot`. No central-core change (it omits the
hook; `persisted` is always false there, so the new serialize/hash never runs).

### Notes / non-goals
- The residual `captureWatermark` read still fires on no-ops (it must precede the loader). It is
  a tiny read-only `SELECT pg_snapshot_xmin`; eliminating it would require capturing the
  watermark inside the loader's own snapshot — out of scope, noted as future work.
- One redundant persist per resource per process boot (in-memory hash starts empty; not seeded
  from the DB because the jsonb round-trip would re-canonicalize and not match a fresh loader
  serialization anyway). Negligible.
- Persisted resources are param-less (`pk = "{}"`) today, so `lastPersistedHash` is bounded; if a
  param'd persisted resource is ever added, evict its hash alongside the existing snapshot
  eviction.

## Verification

1. `./equin build` (from the worktree), confirm the server restarts clean.
2. **Unit (bun:test), co-located** `plugins/framework/plugins/resource-runtime/core/*.test.ts`
   if the runtime is unit-constructable via `createResourceRuntime` with stub hooks: assert that
   two drains producing an identical value call the injected `persistSnapshot` **once**, and a
   changed value calls it again. (If a focused unit harness is impractical, rely on the MCP check
   below.)
3. **Deterministic no-op churn** via the `debug/live-state-churn/emit` pane (or
   `window.__liveStateEmit`): drive N no-op pushes/sec for a persisted resource (e.g. `tasks`) on
   the worktree, then via `query_db` on the worktree compare
   `SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname='live_state_snapshot'` before/after:
   the delta should be ~0 (one boot persist), versus ~N/sec before the fix.
4. **Live profile** `get_runtime_profile` (worktree, kind `db`): the `live_state_snapshot` UPSERT
   `count` should be a small fraction of the `flushNotifies` count (it tracked it ~1:1 before).
5. Sanity: subscribers still receive live updates on real changes (open the app, mutate a task,
   confirm the list updates) — delivery is unaffected by the persist skip.

## Follow-ups (separate from this change)
- **One-time, manual, post-merge:** `VACUUM (FULL, ANALYZE) live_state_snapshot` on `singularity`
  to reclaim the existing 181 MB TOAST (cannot run via the read-only MCP tool or a migration;
  VACUUM FULL can't run in a transaction). Do it **after** this lands, else churn re-bloats it.
- **Class hardening (carried from the perfs session):** a check/lint flagging an unbounded
  `mode:"push"` loader over a growing table; and consider whether `attempts`/`tasks`/`pushes`
  (≈0.4 MB) warrant a value-hash column at the persistence boundary so the unchanged-skip is
  enforced there too.

## Critical files
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — `RegistryEntry` (+`lastPersistedHash`), `drainEntry` persist block (~1408–1419), `ResourceRuntimeOptions.persistSnapshot` type (~573).
- `plugins/database/plugins/live-state-snapshot/server/internal/persist.ts` — `persistSnapshot` signature/body (67–85).
- `plugins/framework/plugins/server-core/core/resources.ts` — injected `persistSnapshot` closure (239–243).
