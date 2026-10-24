# Live-State — persisted read-set + no full server-side recompute on boot

## Context

The L2 work (`research/2026-06-22-global-live-state-l2-persisted-materialization.md`)
made the **client** cold load instant: `GET /api/resources/boot-snapshot` reads
persisted `live_state_snapshot` values in one query instead of rerunning ~21
boot-critical loaders. But the **server** still rebuilds everything on every boot.
There are two distinct full-recompute sources at boot today, and the loaders
actually run **twice**:

1. **`warmBootResources()`** (`plugins/infra/plugins/boot-snapshot/server/internal/boot-keys.ts:38`)
   — runs every boot-critical loader behind the readiness barrier (buffer-cache
   warm + read-set population), discarding the results.
2. **`fullSweep()`** (`plugins/database/plugins/change-feed/server/internal/listener.ts:75,89`)
   — on the listener's first connect it routes a FULL change for *every* covered
   table → `applyDbChange` → and because persisted entries recompute FULL even with
   zero subscribers (`runtime.ts:1284`/`1308`), this re-runs and re-persists all ~21
   loaders. `fullSweep` is *also* the only thing that creates the **initial**
   snapshot rows (the read path — sub-ack, boot-snapshot endpoint fallback — never
   persists; only `drainEntry` does).

Neither can be removed naively: the boot catch-up driver
(`plugins/database/plugins/live-state-snapshot/server/internal/catch-up.ts`) routes
changelog rows through `routeChange → applyDbChange`, which maps tables→resources
via the **in-memory** read-set index (`tableToResources()` inverting
`getReadSetIndex()`). That index is empty at cold boot until a loader runs — the
retained warm/fullSweep is what populates it. Remove them naively and
`applyDbChange` early-returns on every replayed row (`runtime.ts:1855`) and catch-up
silently no-ops.

**Outcome wanted:** persist the per-resource read-set durably alongside each
snapshot, seed the in-memory index from it at boot, then make **bounded catch-up**
the sole boot driver — so a steady-state deploy is *snapshot-read + bounded
catch-up* with **zero** boot-critical loader runs. The only loaders that run at
boot are for resources whose tables actually changed during downtime, plus any
resource that has no usable persisted read-set yet (first boot / newly added).

## End state (boot sequence, after this change)

- `onReadyBlocking` (live-state-snapshot): create/upgrade the snapshot table,
  install persist hooks, **read `(resource_key, tables_read)` and seed the
  read-set index** — before the readiness barrier flips.
- Listener first connect: LISTEN established, **no `fullSweep`** (catch-up is the
  bounded boot driver). `fullSweep` is retained only for genuine *reconnects*.
- `onReady` (live-state-snapshot, runs after the listener's LISTEN is up via the
  existing static import edge): **force a FULL recompute** of each boot-critical
  resource that has *no usable read-set* (new resource or one-time migration), then
  **`runCatchUp()`** (bounded replay for the rest).
- `warmBootResources()` removed entirely.

Net on a steady-state deploy: `needsInit` is empty and the changelog since the
floor is small → near-zero loader runs.

## Design

### 1. Persist the read-set on `live_state_snapshot`

Add a `tables_read text[]` column, written atomically with `value`/`position` in
the same upsert (always consistent with the value it describes).

- `tables-ddl.ts` (`live-state-snapshot/server/internal/`): add the column to the
  `CREATE TABLE IF NOT EXISTS`, **and** an idempotent
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS tables_read text[] NOT NULL DEFAULT '{}'::text[]`
  so existing snapshot tables upgrade in place (derived state, not a drizzle
  migration — same pattern as the table itself). Existing rows get `'{}'` →
  treated as "no usable read-set" → force-FULL once on the next boot (see §3),
  which re-persists the real read-set.
- `persist.ts` `persistSnapshot(key, paramsKey, value, watermark, tablesRead)`:
  add the `tablesRead` param and write the column.
- `readPersistedSnapshots` is unchanged (still reads `value`). Add a sibling
  `readPersistedReadSets(): Promise<Map<string, string[]>>` (one query:
  `SELECT resource_key, tables_read FROM live_state_snapshot WHERE params_key = '{}'`)
  for the boot seed.

Where the read-set comes from at persist time: `drainEntry` already runs the
loader (`value = await getResourceValue(...)`) via `wrapLoad → recordEntrySpan`,
whose `finally` flushes the captured tables into `readSetIndex[key]` *before* the
persist block. So the runtime reads `opts.readSet?.(entry.key) ?? []` and passes it
through. Thread the new arg through:
- `runtime.ts`: `ResourceRuntimeOptions.persistSnapshot` signature (`:560`) + the
  call site (`:1353`): `const tablesRead = opts.readSet?.(entry.key) ?? []`.
- `server-core/core/resources.ts`: `LiveStateSnapshotHooks.persistSnapshot` type
  (`:123`) + the injected wiring (`:219`).

### 2. Seed the read-set index at boot

Add to runtime-profiler (it owns `readSetIndex`, so it owns the write counterpart
of `getReadSetIndex`):
- `plugins/infra/plugins/runtime-profiler/core/recorder.ts`:
  `export function seedReadSetIndex(seed: Record<string, readonly string[]>): void`
  — unions each `seed[key]` into `readSetIndex` (append-only, like live capture).
- Export it from `runtime-profiler/core/index.ts`.

In `live-state-snapshot/server/index.ts` `onReadyBlocking`, after
`ensureSnapshotTable` and before installing hooks is fine — seed from
`readPersistedReadSets()` (skip empty arrays). This runs before any `onReady`
consumer, so `tableToResources()` is non-empty for the first `applyDbChange`.

Boundary note: `database/live-state-snapshot → infra/runtime-profiler` is the same
direction as the existing `database/server/internal/client.ts → runtime-profiler`
edge (no cycle; runtime-profiler is a leaf).

The persisted relations are exactly what `getReadSetIndex()[key]` returned (raw
captured relation names — views like `conversations_v` *or* base tables), which is
exactly what `tableToResources().get(change.table)` matches against (`routeChange`
fans `applyDbChange` over the base table *and* each dependent view). Consistent by
construction.

### 3. Boot init for resources with no usable read-set

A resource is in `needsInit` when its persisted `tables_read` is empty/absent
(brand-new boot-critical resource, or the one-time migration of pre-existing
snapshot rows). Such a resource cannot be bounded by catch-up (no read-set to route
by, and possibly no snapshot floor), so force a FULL recompute — which persists the
value *and* populates its read-set for next boot.

- Add a by-key recompute to the runtime: `recomputeResource(key)` →
  `const entry = registry.get(key); if (entry) scheduleNotify(entry, {}, null, { source: "feed" })`.
  Expose via `server-core/core` (it already re-presents the runtime surface).
- In `live-state-snapshot` `onReady`, before `runCatchUp()`:
  `const usable = await readPersistedReadSets();`
  `const needsInit = bootCriticalKeys.filter(k => !(usable.get(k)?.length));`
  `for (const k of needsInit) recomputeResource(k);`
  (`bootCriticalKeys` read generically from `Resource.Declare`, as today.)

On a steady-state deploy `needsInit` is empty → no forced recomputes.

### 4. Replace the boot `fullSweep`

In `change-feed/server/internal/listener.ts`, skip `fullSweep` on the **first**
successful connect; keep it for reconnects (defense-in-depth for currently-
subscribed resources after a mid-session socket drop — rare, and the persisted set
is small):

```ts
let firstConnect = true;
// …after LISTEN established:
if (firstConnect) firstConnect = false; // boot: catch-up is the bounded driver
else fullSweep();                       // reconnect: broad recovery
```

Flip the flag only on success (a failed first attempt retries as "first"). Boot
correctness is covered by §3 (init) + catch-up (bounded replay) — and no subscriber
is stranded because at boot there are no subscribers until after hot-swap, and a
fresh subscribe runs its own load (sub-ack).

### Ordering invariant (gap-free boot)

`runCatchUp()` must run **after** the listener's LISTEN is established, so any
commit landing after catch-up's `SELECT` produces a NOTIFY on the live path
(double-handling is harmless — catch-up is an idempotent recompute+diff). This
holds structurally today: `live-state-snapshot` statically imports `change-feed`
(`routeChange`, table constants) → dependsOn edge → its `onReady` fires after
`change-feed`'s `onReady` (which calls `startListener()`). Document this dependency
explicitly in the catch-up/listener comments so a future refactor can't silently
reorder it.

### 5. Drop the warm path

- `boot-keys.ts`: remove `warmBootResources`, `withTimeout`, `WARM_BUDGET_MS`.
  Keep `bootCriticalKeys` (still used by `handle-boot-snapshot.ts`).
- `boot-snapshot/server/index.ts`: remove the `onReadyBlocking` hook entirely (warm
  was its only work) and the `warmBootResources` import. Update the plugin
  description (drop "buffer-cache warm-up behind the readiness barrier") and the
  CLAUDE.md prose.

The buffer-cache benefit is now marginal (the hot boot path reads the snapshot
table, not the loaders; param-less boot-critical resources are served from the
snapshot; route-parametrized resources self-heal via sub-ack which warms their own
tables on first use). Removing it is the clean end state; if a measured regression
on first parametrized sub-ack appears, a *targeted* cheap prewarm (plain `SELECT`
on the hot tables, no loaders) can be reintroduced later — not part of this change.

## Files to modify

| File | Change |
|---|---|
| `plugins/database/plugins/live-state-snapshot/server/internal/tables-ddl.ts` | Add `tables_read text[]` to CREATE; add idempotent `ADD COLUMN IF NOT EXISTS` |
| `…/live-state-snapshot/server/internal/persist.ts` | `persistSnapshot` writes `tables_read`; add `readPersistedReadSets()` |
| `…/live-state-snapshot/server/index.ts` | Seed index in `onReadyBlocking`; force-FULL `needsInit` keys in `onReady` before catch-up; comment the LISTEN→catch-up ordering invariant |
| `…/live-state-snapshot/server/internal/catch-up.ts` | Comment: relies on seeded index + post-LISTEN ordering (no logic change) |
| `plugins/infra/plugins/runtime-profiler/core/recorder.ts` | Add `seedReadSetIndex(seed)` |
| `plugins/infra/plugins/runtime-profiler/core/index.ts` | Export `seedReadSetIndex` |
| `plugins/framework/plugins/resource-runtime/core/runtime.ts` | `persistSnapshot` sig + call site pass `tablesRead`; add `recomputeResource(key)` |
| `plugins/framework/plugins/server-core/core/resources.ts` | Thread `tablesRead` through the hook type + wiring |
| `plugins/framework/plugins/server-core/core/index.ts` | Re-present `recomputeResource` |
| `plugins/database/plugins/change-feed/server/internal/listener.ts` | Skip `fullSweep` on first connect; keep on reconnect |
| `plugins/infra/plugins/boot-snapshot/server/internal/boot-keys.ts` | Remove `warmBootResources`/`withTimeout`/`WARM_BUDGET_MS`; keep `bootCriticalKeys` |
| `plugins/infra/plugins/boot-snapshot/server/index.ts` | Remove `onReadyBlocking` + warm import; update description |
| `…/boot-snapshot/CLAUDE.md`, `…/live-state-snapshot/CLAUDE.md` | Update prose (no warm; seed + init + bounded catch-up) |

## Edge cases / correctness

- **One-time migration:** existing snapshot rows have `tables_read = '{}'` → all
  boot-critical keys are `needsInit` on the first boot after this change → one full
  force-FULL recompute (the same cost as today's `fullSweep`), which persists real
  read-sets. Every subsequent boot is bounded. Self-healing, no manual step.
- **Stale read-set after a loader change:** if a deploy changes which tables a
  loader reads, the persisted `tables_read` is one boot behind. Catch-up may
  mis-route for that single boot window; the first post-boot recompute (catch-up
  hit, a real change, or sub-ack-triggered persist) rewrites the read-set. Bounded
  and self-correcting. (Worth a note in the plugin comment.)
- **Read-path never persists:** unchanged — initial persistence is now the §3
  force-FULL (was `fullSweep`). `loadResourceByKey` (sub-ack, endpoint fallback)
  stays read-only.
- **Missing-history backstop** (`catch-up.ts` `fullRecomputeChangedTables`):
  unchanged; still routes through the now-seeded index, so it works at cold boot
  too (previously also depended on warm having run).
- **`tableToResources()` memo** keys on `${registry.size}:${totalReadSetSize}`;
  seeding grows `totalReadSetSize`, invalidating the memo before the first
  `applyDbChange`. ✓

## Verification

1. `./equin build` (regenerates nothing schema-wise — derived DDL; restart
   applies the `ALTER`). Confirm boot is clean.
2. **Migration boot:** first build after the change → expect a one-time
   force-FULL of all boot-critical keys (logs from `recomputeResource`/persist).
   `query_db` (MCP): `SELECT resource_key, tables_read FROM live_state_snapshot` —
   every boot-critical row now has a non-empty `tables_read`.
3. **Steady-state deploy:** trigger a second `./equin build` with no data
   change. Expect: **zero** boot-critical loader runs at boot. Verify via the
   Debug → Gantt boot-profiling pane / runtime-profiler (`get_runtime_profile`
   MCP) that no `loader` spans fire for persisted keys on boot, and catch-up logs
   "no changelog rows since floor — already current".
4. **Bounded catch-up:** with the server down, mutate a boot-critical resource's
   table out-of-process (`query_db` is read-only — use the app or a sidecar write),
   restart, and confirm only *that* resource recomputes (catch-up log shows N rows
   replayed; profiler shows exactly the affected loader(s) ran), while the rest are
   served from snapshot.
5. **Client cold load still instant:** load `http://<worktree>.localhost:9000`
   (scripted Playwright per `e2e/screenshot.mjs`) — boot-critical UI paints with
   data, no flash, no WS round-trip burst.
6. **Reconnect defense-in-depth:** confirm `fullSweep` still fires on a *reconnect*
   (e.g. bounce the LISTEN socket) but not on the first boot connect (listener
   logs).
7. `./equin check` (boundaries, type-check, plugins-doc-in-sync).
