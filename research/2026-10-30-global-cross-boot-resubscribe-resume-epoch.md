# A backend restart re-runs every open tab's loaders: resume the epoch across a hot swap

**Date:** 2026-10-30 · **Category:** global (resource-runtime, live-state client, live-state-snapshot, config_v2)
**Task:** task-1793316435-l5wuoq · **Parent audit:** task-1793313534-w54p8d
**Status:** parts 2 and 3 landed. Part 1 (the handoff) is phase 2, waiting for the
user's decision on its failure mode, which is stale data served as `up-to-date`.

**Measured on the worktree build** (3 tabs: agents, settings, debug; then a backend restart):
- The tabs replayed 455 subs (329 + 59 + 67). Read-admit peaked at 6 active / 288 queued.
- **`config-v2.values`:** 103 replayed subs, **0 loader runs**. Every one was answered
  `up-to-date` by the ETag, with self time ≈ 0. Each still waited in the read gate for the
  ETag probe: 500 ms on average, 1.7 s at most.
- **xmin captures:** 9 for the 157 subs completed in the post-boot trace. Main's 22:31
  trace had 85 for about 190.
- **What is left:** the `*:rows` point reads ran 247 loaders (~10 ms of work each, ~1.4 s
  of wall time each, almost all of it queueing in the read gate). The phase 2 handoff
  targets exactly these.

## Context

Main restarts 18–74×/day (once per push). Each restart closes every tab's socket. Each tab
then replays its whole sub set as one `sub-batch`. On main's live-state log a tab holds
**34–414 subs** (`replaySubs … subCount=`). The new backend answers every entry through
`serveSub` → `gatedRead`, the 6-slot read-admission gate (`READ_LOAD_CONCURRENCY`,
`resource-runtime/core/runtime.ts:2330`). Evidence: 984 of the 1021 `sub` slow-op traces fired
within 60 s of boot, and ~85% of their time was spent queued.

### What one post-boot trace actually shows (22:31:11, uptime 8.4 s)

Completed spans in the trace, summed by label:

| span | n | self Σ | self avg | read-admit wait avg |
|---|---|---|---|---|
| `SELECT pg_snapshot_xmin(…)` (watermark capture, one per flight) | 85 | **1516 ms** | 18 ms | — |
| `config-v2.values` sub | 65 | 567 ms | 9 ms | **2694 ms** |
| `conversation-progress:rows` / `-preprompts:rows` / `task-short-titles:rows` / `conversations.by-id:rows` subs | ~95 | ~530 ms | 4–8 ms | ~2350 ms |
| DB loaders behind them (point reads, windows) | — | 17–33 ms each | | |

- **Work vs wait.** Each read is cheap: a 5–30 ms loader plus an 18 ms xmin round trip. The
  time is all wait. Hundreds of cheap reads per tab, times several tabs, go through 6 slots on
  an event loop that also runs boot warm-ups (`warmup:plugin-tree.trees`, open for 4.2 s;
  `sonata.midi-folders.reconcile`). Read-admit max 6 / queued 141–202; background-acquire 7/7,
  queued 237.
- **Rate.** `config-v2.values` alone is 157k of the `sub` slow-op count (one tuple per config
  path, `boot-and-keep`). The `:rows` point reads come next.
- The 0.5–1.8 s recursive CTEs and the `live_state_snapshot` INSERTs 3–9 s after boot are a
  **different driver**: boot catch-up (`onReady`). It replays a **median of 9,127 changelog
  rows per boot** (p90 28,784; max 373,855; n = 933 boots in `live-state-snapshot.jsonl`).
  They compete with the herd but do not cause it. See *Follow-up*.

### Why nothing short-circuits the replay (the two open questions)

1. **The version short-circuit is per process.** `handleSub` / `handleSubBatch` answer
   `up-to-date` only when `m.epoch === bootEpoch`. `bootEpoch` is `crypto.randomUUID()` per
   runtime instance (`runtime.ts:2390`), so after a restart every echoed `{epoch, version}` is
   from another epoch and takes the full path. The design says so: "post-restart replays take
   the full path and re-baseline".
2. **No sub reads the L2 snapshot.** `live_state_snapshot` has exactly two consumers:
   - boot-snapshot's first paint, on a page load over HTTP;
   - `seedPersistedSnapshot`, the persisted aliases' in-memory diff base.

   `serveSub` never reads it. L2 also covers only ~10 persisted unbounded aliases (`tasks`,
   `attempts`, `conversations-active`, …), not windows, point reads or externals. Even an alias
   whose kept snapshot is current after catch-up runs its loader again on every sub.
3. `revalidate` ETags cover only the resources that opt in, mostly git ones.
4. **Gateway hot-swap.** Confirmed: the swap is gated on the `onReadyBlocking` barrier only
   (`server-core/CLAUDE.md`). So `onReady` catch-up and the warm-ups start about 1 s before the
   herd arrives and run alongside it (trace: warm-ups at t = 4.19 s, first subs at 5.17 s). The
   config registry is ready before the swap (`initRegistry` runs in `onReadyBlocking`), so the
   `config-v2.values` loaders do not hold a slot while they wait for it.
   **Hypothesis discarded, gate 1:** the arithmetic does not close.

### Gates (perfs-investigation)

- **Sufficiency:** about 200–1300 queued reads × ~30 ms per slot-hold ÷ 6 slots, plus event-loop
  contention, gives the observed 2–3 s waits, with peaks up to several seconds.
- **Legitimacy:** a restart that only swapped code does not change the data. Re-reading an
  unchanged tuple is illegitimate unless one of two things happened:
  - its data changed in the restart gap;
  - its **definition** changed (main restarts *because* code changed).
- **Counterfactual:** a wider gate, a client stagger or faster loaders would all be
  containment. The same work would still happen, only cheaper. The origin is that **the
  freshness proof dies with the process**.
- **Requirement boundary:** a value whose definition or data changed must reload. That is the
  real requirement, and it bounds the fix.

## Recommended approach

### 1. Origin: resume the epoch across a hot swap (`resource-runtime` + `live-state-snapshot`)

The old backend hands its freshness ledger to its successor. The successor re-proves the
restart gap from the changelog. Then the existing same-epoch short-circuit answers the replay,
and the client is unchanged.

**Handoff record (written by the old backend at shutdown, read lazily by the new one).**
- `{ epoch, cutXid, tuples: [(key, pk, version, definition)] }` for every tracked tuple.
  - It is bounded by the subscription set (thousands, not the collection).
  - A tuple with an undrained pending is left out, so it takes the full path.
- **Cut protocol**, in `onShutdown`, before the sockets close:
  1. Capture `cutXid` (xmin).
  2. Send a self-NOTIFY barrier on the feed channel and wait for it. Postgres delivers
     notifications in commit order, so every txn with xid < `cutXid` has then been routed.
  3. Wait for the flush to go idle.
  4. Write the record.

  Over-replay is always safe: it only marks more tuples dirty. So `cutXid` may be low, never
  high.
- **Storage:** one row in a `live_state_handoff` table owned by `live-state-snapshot`, which
  already owns the changelog, its horizon and the persist hooks. Add it to the fork-data
  exclusion. A crash writes no record, and every entry then takes the full path, as today.

**Successor (new runtime option `resumeEpoch`, host-injected like `persistSnapshot`).**
- The first `sub-batch` / `sub` carrying a foreign epoch triggers a single-flight load of the
  record for that epoch, memoized for the boot.
- Order matters. First the inherited tuples become **shadow-tracked**: the router targets them,
  and a routed change marks the tuple dirty. Only then are changelog rows with
  `xid >= cutXid` replayed through the same router: dry routing, which marks tuples dirty and
  creates no pendings. Shadow-tracking first closes the gap between the replay read and live
  routing. Reuse `routeTableChange`'s per-tuple targeting, with `readLayout` for row layouts,
  as catch-up does.
- A tuple **inherits** only when all of these hold:
  - it is not dirty;
  - `cutXid` is above the prune horizon (`isPrunedPast`);
  - its `definition` equals the running entry's;
  - the entry is DB-backed (routed or reach), not `external`, `bytes`, or `revalidate`.

  For such a tuple, a replay entry that echoes `(epoch, version)` gets `up-to-date` at the
  inherited version. `registerSubOnSocket` must treat the inherited version as continuing the
  span: the "never the span opener" rule exists because nobody tracked the gap, and the old
  backend plus the changelog replay now did. Every other tuple takes `serveSub` with a version
  above the inherited one.
- Shadow tuples never claimed by a replay expire after a bounded window.
- **No diff base after `up-to-date`.** A keyed tuple answered `up-to-date` has no server
  snapshot. Its first change drains FULL with no base and ships a FULL frame with `order`.
  That is already correct today. Persisted aliases keep their kept snapshot.

**Definition identity: which entries qualify.** Main restarts only on code change, so "same
definition" must be per resource, never the whole build graph.
- **Phase 1:** entries with a `definitionOf` (compiled routed collections: windows, point
  reads, aliases). The route-plan SQL fingerprint already fully determines their output. These
  are most of the post-boot count after config (`*:rows`, `tasks`, `attempts`, …).
- **Phase 2 (follow-up):** a build-time per-resource code identity. Hash the server
  import-closure of the module that declares the loader (`tooling/import-closure`). This
  extends inheritance to hand-written DB loaders.

### 2. `config-v2.values`: a cheap revalidation that keeps the same-boot short-circuit (`config_v2`, `resource-runtime`)

This is about half the replay entries. Its truth is files plus code, so the changelog cannot
prove it.
- Declare `revalidate` = hash of (descriptor fingerprint: schema and defaults) + the content
  hashes the file watcher already holds. No resolve, no IO.
- Runtime: allow the same-epoch version short-circuit for a `revalidate` entry whose freshness
  is `notified`. Its notify stream is its complete change signal within a span. This keeps
  same-boot reconnects free. Today `revalidate` opts an entry out of the short-circuit, and
  config would regress without this change.

### 3. Containment that lands regardless (`resource-runtime`)

- **No watermark capture for an entry that reads no DB.** The flight factory captures xmin
  for every entry (`runtime.ts` `load`). For an external entry with no `reach` plan, which
  is `config-v2.values`, that is a pointless DB round trip inside a read slot (85 × 18 ms in
  one trace). Decide from the definition: external with no reach plan ⇒ no capture.
- **Coalesce concurrent captures.** Flights starting in the same macrotask share one xmin
  read. An earlier capture is a valid lower floor (Rule B: captured before every sharer's
  first read).

## Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts`: `handleSub` / `handleSubBatch`
  (inheritance check), `registerSubOnSocket` (span continuation), `gatedRead` (capture
  rules), the routing dry-run, and a new `ResourceRuntimeOptions.resumeEpoch` hook plus a
  `handoffState()` export.
- `plugins/framework/plugins/server-core/core/resources.ts`: bind the new hooks; central binds
  none (degrades to today).
- `plugins/database/plugins/live-state-snapshot/server/`: the handoff table and its DDL, the
  cut at `onShutdown` (beside `dropPendingPersists`), the changelog read since `cutXid`
  (reuse `catch-up.ts`'s readers and `isPrunedPast`).
- `plugins/database/plugins/change-feed/server/`: the barrier NOTIFY on the listener.
- `plugins/config_v2/server/internal/resource.ts`: `revalidate` on `configValuesServed`.
- The client (`live-state/web/notifications-client.ts`) needs **no** change: it already echoes
  the backed `{epoch, version}`.

## Verification

- **Runtime harness** (`core/runtime-*.test.ts`, new `runtime-resume-epoch.test.ts`):
  - an inherited clean tuple gets `up-to-date` with zero loader runs;
  - a dirty tuple (a changelog row routed to it) loads;
  - a definition mismatch loads;
  - a change landing between handoff load and claim marks the tuple dirty;
  - an unclaimed shadow expires;
  - a keyed `up-to-date` tuple's first change ships a FULL frame that `makeClientView`
    converges on.
- **DB-backed** (`live-state-snapshot/server/internal/*.test.ts`):
  - the cut barrier (a commit before `cutXid` whose NOTIFY is in flight is routed before the
    record is written);
  - a changelog replay since `cutXid`;
  - a pruned-past horizon ⇒ nothing is inherited.
- **Client hazards:** `./equin test plugins/primitives/plugins/live-state plugins/primitives/plugins/networking`
  (H2 re-baseline unchanged).
- **End-to-end:** on the worktree build, open 3 tabs (one heavy: conversation + tasks), then
  run `./equin build` again to restart.
  - Compare the read-admit max queue in `get_runtime_profile` and the `sub` slow ops within
    60 s of boot, before and after.
  - Read `_debug` for the new `resumedSubs` / `resumeRefusals{reason}` counters.
  - Target: read-admit queue < 20 after a restart, and `config-v2.values` / `*:rows` absent
    from post-boot `sub` slow ops.
- `./equin check`.

## Follow-up (filed separately)

- **Boot catch-up replays ~9k changelog rows per boot (median), up to an hour of history.**
  Floor persists only lower `position`, and compaction runs hourly. These are the 0.5–1.8 s
  CTEs and the snapshot INSERTs 3–9 s after boot. This is a rate question of its own:
  why is the floor so old?
- **`onReady` warm-ups run inside the herd window.** `plugin-tree` takes ~4 s of CPU. They
  could yield to the read path, or the hot-swap could gate on more than the barrier.
