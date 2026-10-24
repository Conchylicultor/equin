# Decouple live-state notification delivery from loader execution (parallel flush)

## Context

Under load, the UI lags server state by seconds to minutes. Concrete case: conversation
`conv-1781867057-9hv4` was correctly `status=done, active=false, close_requested=true` in
the DB after `exit_clean` + a push, yet the open tab's "drop & close" button and the
toolbar git-commit/push indicator never reacted until a manual refresh.

**Root cause — head-of-line blocking in `flushNotifies`.** The resource runtime's
`flushNotifies` (`plugins/framework/plugins/resource-runtime/core/runtime.ts:626`) walks
`topoOrder` in a single **serial** `for…await` loop: for each entry it `await`s the loader
(`getResourceValue`) *before* sending any WS frame and *before* cascading. Independent
triggers that land in the same microtask window coalesce into one global flush, so when a
slow git loader is in that flush — `commits-graph` / `edited-files`, ~66–68s behind the
host-wide `heavy-read` semaphore — **every unrelated entry queued later** (conversation
close `conversationsResource`, `pushes`, bell notifications) waits for it. Runtime profiler
confirms: `[loader-acquire]` avg 3.4s / max 45s, 60,681 pool `[acquire]` events.

**The structural fix:** UI delivery must not be coupled to (or head-of-line-blocked by)
loader computation of *unrelated* resources. Run independent topological nodes concurrently
so one slow loader cannot starve unrelated updates. This addresses the "app feels broken /
didn't update until refresh" class regardless of any individual loader's speed.

**Scope (confirmed):** parallel flush only. Self-contained, single file, no client or wire-
protocol changes. Stale-while-revalidate is explicitly **out of scope** (it doesn't help the
motivating `invalidate`-mode resources, can't speed up cascades that need fresh upstream
values, and would add protocol version/ordering complexity — deferred).

## Design

Parallelize the flush **by topological level (longest-path depth)**:

- depth 0 = entries with no upstreams; `depth(e) = e.upstreams.empty ? 0 : 1 + max(depth(up))`.
- Every `dependsOn` edge **strictly increases** depth, so there are **no edges within a
  level** → entries in the same level are independent and safe to run concurrently.
- Process levels **sequentially** (a barrier between levels) but run all entries in a level
  via `Promise.all`. The barrier preserves the current invariant that a cascade merged into
  a downstream's `pendingNotifies` is picked up later in the same flush — the downstream is
  always at a strictly greater depth = a later level, so all cascade writes from level *d*
  have settled before level *d+1* drains.

### Why this is correct (single-threaded JS — interleaving only at `await`)

- **Per-entry drain head must be synchronous.** Each entry's task starts with the existing
  snapshot+clear of `pendingNotifies` and the debounce-timer piggyback `clearTimeout`
  (`runtime.ts:634-643`) as a synchronous block *before its first `await`*. Distinct entries
  have distinct `pendingNotifies` Maps → no torn reads.
- **Version monotonicity holds.** Keep the inner per-pk loop **sequential** inside each
  entry's task (only *entries* run concurrently, never pks within an entry). `versions` /
  `snapshots` are per-entry Maps → no cross-entry race.
- **Same-level fan-in is safe.** When `pushes` and `refHead` (both depth-0) both cascade
  into `commits-graph.delta` (depth-1), both call `mergePending` on the same downstream Map.
  `mergePending` (`runtime.ts:339-356`) is fully synchronous (no `await`), so the two calls
  execute atomically one-after-the-other; the FULL-absorbing union composes regardless of
  order. `edge.affectedMap` is awaited *before* `mergePending`, so the merge itself never
  interleaves. The downstream reads its merged pending only at the next level (after the
  barrier).
- **The valuable win:** a `refHead` move that cascades to many per-attempt
  `commits-graph.{delta,graph}` pks (all depth-1, independent git subprocesses) now runs
  concurrently via `Promise.all` instead of serially. Real concurrency is still bounded by
  the existing `heavy-read` and `loaderDbGate` semaphores — we are not removing back-pressure,
  only removing the false serialization of *unrelated* fast resources behind slow ones.

### Reentrancy guard (required)

Today `flushScheduled = false` is set at the top of `flushNotifies`, so a notify arriving
mid-flush queues a *new* microtask `flushNotifies` that can interleave with the in-progress
one at any `await`. Parallelism widens this window. Add a single-active-flush mutex with a
coalesced rerun:

```ts
let flushRunning = false;
let flushAgain = false;

async function flushNotifies(): Promise<void> {
  if (flushRunning) { flushAgain = true; return; }   // a flush is live → ask it to re-drain
  flushRunning = true;
  try {
    do {
      flushAgain = false;
      flushScheduled = false;        // reset each pass so a mid-flush scheduleFlush re-arms cleanly
      rebuildDag();
      for (const level of topoLevels) {
        await Promise.all(level.map((entry) => drainEntry(entry)));
      }
    } while (flushAgain);
  } finally {
    flushRunning = false;
  }
}
```

- `drainEntry(entry)` is the current per-entry body (the `if (entry.pendingNotifies.size === 0)
  continue` check + synchronous snapshot/clear/timer-cancel head + the per-pk loop that
  computes value, sends frames, and cascades) lifted into an `async` function.
- `withNotifyBatch` and the debounce timers are **unchanged**: they still only call
  `scheduleFlush()`, which either starts a fresh flush (none running) or sets `flushAgain`
  (one running). Mid-flush externally-arriving notifies are never stranded — the `do/while`
  re-runs the level drain and any entry with non-empty pending is reprocessed.

### Why not a per-entry "await only real upstreams" executor

The level barrier introduces one false dependency: a depth-1 entry waits for *all* depth-0
entries in the same flush, including unrelated ones (e.g. `commits-graph` waiting on a
co-flushed `edited-files`). This is **negligible**: (a) the two slow loaders have disjoint
triggers (FS-watcher vs push/ref-move) so they almost never share a microtask-coalesced
flush; (b) even co-flushed, both take the host-wide `heavy-read` semaphore (size
`floor(cpus/4)`, often 1–2) and **already serialize on that gate** regardless of flush
structure. A true per-entry executor adds per-edge promise bookkeeping and harder reentrancy
reasoning for a benefit the semaphore eats. Not worth it.

## Changes

All in **`plugins/framework/plugins/resource-runtime/core/runtime.ts`**:

1. **`RegistryEntry`** (`:173`): add `depth?: number`.
2. **Module state** (`:275-279`): add `let topoLevels: RegistryEntry[][] = [];`, `let
   flushRunning = false;`, `let flushAgain = false;`. Keep `topoOrder` (the `_debug`
   endpoint still maps over it).
3. **`rebuildDag`** (`:448`): accumulate longest-path depth in the existing post-order
   `visit` (upstreams finalized before the entry):
   ```ts
   let depth = 0;
   for (const upKey of entry.upstreamKeys) {
     const up = registry.get(upKey);
     if (!up) { console.warn(/* unchanged dangling warning */); continue; }
     visit(up, stack);
     depth = Math.max(depth, (up.depth ?? 0) + 1);
   }
   entry.depth = depth;
   ```
   After the visit loop, build explicit levels (do **not** assume `topoOrder` is depth-
   sorted — post-order isn't across independent subtrees):
   ```ts
   const maxDepth = order.reduce((m, e) => Math.max(m, e.depth ?? 0), 0);
   const levels: RegistryEntry[][] = Array.from({ length: maxDepth + 1 }, () => []);
   for (const e of order) levels[e.depth ?? 0]!.push(e);
   topoLevels = levels;
   topoOrder = order;
   ```
   The `?? 0` fallbacks keep dangling-upstream (warn + skip) and cycle (`visiting` back-edge
   returns without recursing) cases crash-free and warn-only, matching today's behavior.
4. **`flushNotifies`** (`:626`): wrap with the reentrancy guard above; extract the per-entry
   body into `async function drainEntry(entry)`; iterate `topoLevels` with `await
   Promise.all(level.map(drainEntry))`. The per-pk loop inside `drainEntry` stays sequential.

No changes to `scheduleNotify`, `scheduleFlush`, `withNotifyBatch`, `mergePending`,
`sendJson`, the keyed-diff helpers, the client, or the wire protocol.

## Verification

1. **Build:** `./equin build` (regenerates nothing schema-side; just type-checks +
   restarts).
2. **Type/lint:** `./equin check type-check`.
3. **Unit test (new, co-located bun:test next to source):**
   `plugins/framework/plugins/resource-runtime/core/runtime.test.ts` (or extend an existing
   one). Build a runtime with `createResourceRuntime`, register:
   - a **slow root** loader (resolves after a controllable deferred),
   - an **independent fast root** with a fake subscriber socket,
   - a **downstream** depending on a fast root (to exercise the level barrier + cascade).
   Notify all in one batch; assert the fast resource's frame is `sendJson`'d **before** the
   slow loader resolves (decoupling), the downstream frame arrives **after** its upstream,
   version numbers are monotonic per (key,pk), and a notify arriving mid-flush is re-drained
   (reentrancy guard). Run: `bun test plugins/framework/plugins/resource-runtime/core`.
4. **End-to-end (the reported scenario):** open a conversation tab, trigger a push so a
   `commits-graph`/`edited-files` recompute is in flight, then change a conversation's status
   (or `exit_clean`). The "drop & close" button and push indicator should update within the
   normal live-state latency instead of waiting out the slow git loader. Use
   `e2e/screenshot.mjs` against `http://<worktree>.localhost:9000/a/<id>` to capture
   before/after, or watch the live tab.
5. **Profiler sanity:** after the change, `mcp__singularity__get_runtime_profile` should show
   loader spans still bounded by the `heavy-read` / `loader-acquire` gates (unchanged back-
   pressure), but unrelated `push`-origin sends no longer accumulating wall-clock behind the
   slow loader spans.

## Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — **the only file changed.**
- `plugins/framework/plugins/resource-runtime/CLAUDE.md` — update the prose to note the
  flush is level-parallel with a single-active-flush guard.
- Reference (unchanged, validate invariants against):
  `plugins/conversations/plugins/conversation-view/plugins/commits-graph/server/internal/resources.ts`
  (depth-1 `pushes`+`refHead` → commits-graph cascade),
  `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/edited-files-resource.ts`
  (depth-0 invalidate root), `plugins/infra/plugins/host-read-pool/server/internal/pool.ts`
  (heavy-read semaphore that bounds real concurrency).
