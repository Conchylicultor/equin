# Runtime profiler: wait propagation, exact wall-clock decomposition, and windowed maxes

## Context

Perf investigations keep drawing wrong conclusions from the profiler's own semantics
(documented as traps in `research/perfs/`):

1. **Gate/pool waits are charged only to the innermost entry span.** `chargeWait` writes to
   the innermost `AsyncLocalStorage` `EntryContext`; there is no parent chain. A composite
   span like `flush/flushNotifies` therefore shows huge wall-clock with **empty `waits`** —
   which directly caused the refuted "flush queued behind git loaders" conclusion
   (`research/perfs/issue-git-derived-loaders.md:98-102`, 2026-07-01 session 2).
2. **`maxMs` is a sticky since-boot peak** (reset only manually), so an old spike reads as a
   live problem (`.claude/skills/debug/SKILL.md:46` warns about this).
3. **`workMs` on composite spans is wall-clock, not CPU** — `workMs = avg − Σwaits`, and with
   empty waits a flush's `workMs == avg` reads as "the flush did 990s of work".

Target outcome: for any recorded span, the wait-vs-work decomposition **sums to its
wall-clock** and **names the gate/pool waited on at every level** of the span tree; maxes are
windowed or carry their age; the caveat warnings become deletable because the fields can no
longer be mis-read.

Key architectural constraint discovered in exploration: a flush drains many loaders
**concurrently**, so naively summing child waits into ancestors can exceed the ancestor's
wall-clock (20 loaders × 60s gate wait inside a 90s flush = "1200s wait"). Correct
decomposition requires **interval-union** accounting per ancestor. Because every charge
arrives at its interval's end time (gates call `onWait` at acquisition; children charge at
finish), the charge stream is end-ordered by construction, so a **streaming union** (O(1) per
charge) is *exact*, not approximate.

## Design

### A. Core recorder — `plugins/infra/plugins/runtime-profiler/core/recorder.ts`

Stays zero-dependency and isomorphic. `record()`'s hot path (every DB query) gains only
numeric fields; the new machinery runs per *entry* span (per request/loader), not per leaf.

**`EntryContext`** gains a live parent chain and union tracks (`Track = { unionMs: number;
prevEnd: number }`):

```ts
interface EntryContext {
  kind; label; tables?;                     // existing
  parent: EntryContext | undefined;         // live chain (was only a SpanRef snapshot)
  startMs: number;
  closed: boolean;                          // set in recordEntrySpan's finally
  layerUnions: Map<string, Track>;          // per-gate-layer union → materialized `waits`
  waitUnion: Track;                         // union of ALL gate-wait intervals → waitMs
  busyUnion: Track;                         // union of (gate-waits ∪ child executions) → selfMs
  childUnion: Track;                        // union of direct-child exec intervals → childMs
}
```

The old summed `waits: Map<string, number>` is **replaced by `layerUnions`**: materialized
per-layer values are unions (each ≤ wall). A summed `flush.waits["loader-acquire"] = 1200s`
on a 90s span would be the same misread we're eliminating. Wire shape stays
`Record<string, number>`.

**Streaming union** (the load-bearing math — export as `__contribute` for direct tests):

```ts
function contribute(track: Track, start: number, end: number, floor: number): void {
  start = Math.max(start, floor);            // clip to the context's lifetime
  const lo = Math.max(start, track.prevEnd); // skip already-covered time
  if (end > lo) { track.unionMs += end - lo; track.prevEnd = end; }
  // end <= lo: fully covered / out-of-order → contributes 0 (conservative, never overcounts)
}
```

Guarantees: `waitMs ≤ wall`, `selfMs ≥ 0`, decomposition always sums. Zero-ms charges
(git-memo hit/miss markers) still create the layer key with 0.

**`chargeWait(layer, ms)`** — reconstructs the interval `[now−ms, now]` and walks **all open
ancestors** (innermost included):

```ts
if (SINGULARITY_PROFILING === "0" || suppressionRuntime.suppressed()) return;  // NEW guards
const cur = contextRuntime.current();
if (!cur) { record("db", `[${layer}]`, ms, null); return; }   // unchanged fallback
const end = now(), start = end - ms;
for (let a = cur; a; a = a.parent) {
  if (a.closed) continue;                                     // never mutate a finished span
  contribute(layerUnionFor(a, layer), start, end, a.startMs); // creates key even for 0ms
  contribute(a.waitUnion, start, end, a.startMs);
  contribute(a.busyUnion, start, end, a.startMs);
}
```

The suppression guard is new: since waits now mutate all ancestors, an observability write
inside `runWithoutProfiling` must not pollute ancestor waits.

**`recordEntrySpan`** — captures `parent: cur` (live chain) alongside the existing `SpanRef`;
in `finally`, charges its own execution interval `[t0, t1]` into the **nearest open
ancestor's** `childUnion` + `busyUnion` (nearest-only: each parent's own interval propagates
upward when *it* finishes, so charging every ancestor would double-count), sets
`closed = true`, then records:

```ts
waitMs  = ctx.waitUnion.unionMs;
childMs = ctx.childUnion.unionMs;
selfMs  = Math.max(0, wall - ctx.busyUnion.unionMs);
waits   = materialize(ctx.layerUnions);   // Record<layer, unionMs>, undefined if empty
record(kind, label, wall, parentRef, waits, waitMs, childMs, selfMs);
```

- Leaf-ish entry (loader, no nested entries): `childMs = 0`, `selfMs = wall − waitMs` — the
  old `workMs` meaning, unchanged.
- Composite (flush): `waits` populated by subtree gate waits (the fix for trap 1),
  `childMs ≈ wall`, `selfMs ≈` its own orchestration — trap 3 dissolves structurally.

**`record()`** gains `waitMs/childMs/selfMs` params (leaf `recordSpan` passes
`0/0/durationMs`) summed into the aggregate: `waitTotalMs`, `childTotalMs`, `selfTotalMs`.

**Windowed max**: per aggregate keep `recentBuckets: { at: number; max: number }[]` with
`BUCKET_MS = 30_000`, `WINDOW_BUCKETS = 10` (~5 min); update/append on record, drop expired
(O(10)). Track `maxAtMs` when `maxMs` is beaten. `getRuntimeProfile()` materializes
`recentMaxMs` (max over live buckets) and `maxAgeMs = now − maxAtMs`, and sorts aggregates by
`recentMaxMs` desc (live relevance) instead of `maxMs`.

**`waitSplit(agg)`** → `{ avgMs, waitMs, childMs, selfMs, waits }` (all per-call averages
from the summed totals). **`workMs` is removed everywhere.**

**`SlowSpan`** gains `waitMs`, `childMs`, `selfMs`.

**Clock seam**: `let now = () => performance.now(); export function installClock(fn)` —
mirrors the existing `installSpanContextRuntime` injection pattern; needed for deterministic
union/bucket tests. Default behavior identical.

### B. Close the instrumentation gaps (unattributed wall-clock sources)

1. **pg connect wait** — `plugins/database/server/internal/client.ts:136-138`: after the
   existing `recordSpan("db", "[acquire]", dt)` (kept for rate visibility), also
   `chargeWait("db-acquire", dt)` so the caller's decomposition sums.
2. **`createInflight` joiners** — `plugins/packages/plugins/inflight/core/internal/inflight.ts`:
   add optional `onWait?: (waitMs: number) => void` third param on `run` (mirrors the
   semaphore's shape; primitive stays profiler-agnostic). Joiners time their await of the
   shared flight; the starter never calls `onWait`. Wire at:
   - endpoints GET dedupe → `chargeWait("endpoint-dedupe", ms)` (see C),
   - resource-runtime read coalescing (`resource-runtime/core/runtime.ts`, the
     `inflight.run` in the read path): new `ResourceRuntimeOptions.onCoalesceWait?(ms)`
     mirroring `onReadGateWait`, wired in
     `plugins/framework/plugins/server-core/core/resources.ts` →
     `chargeWait("read-coalesce", ms)`,
   - git-read-cache (`git-state-memo.ts`) → `chargeWait(`git-coalesce:${name}`, ms)`.
3. **Endpoint per-route concurrency gate** — `plugins/infra/plugins/endpoints/core/implement.ts`
   (**user-approved behavior change**): move `recordEntrySpan("http", route, …)` to enclose
   the dedupe + concurrency gates (body/query decode stays outside):

   ```ts
   return recordEntrySpan("http", _endpoint.route, async () => {
     const runHandler = () => handler({ params, body, query, req });
     const gated = gate
       ? () => gate.run(runHandler, (ms) => chargeWait("endpoint-concurrency", ms))
       : runHandler;
     return dedupe
       ? dedupe.run(dedupeKey(req), gated, (ms) => chargeWait("endpoint-dedupe", ms))
       : gated();
   });
   ```

   The http span's wall now matches client-observed latency with the queueing named in its
   waits. Consequence: deduped GETs record one http span **per request** (joiners:
   `waits.endpoint-dedupe ≈ wall`, `selfMs ≈ 0`) instead of one shared span — op-rate http
   count deltas rise on deduped routes (accepted). Child db/loader spans still attribute
   only to the starter (ALS context of the executing flight).

### C. Wire schema + consumers

| File | Change |
|---|---|
| `plugins/debug/plugins/profiling/plugins/runtime/shared/endpoints.ts` | `aggregateSchema`: + `waitTotalMs`, `childTotalMs`, `selfTotalMs`, `recentMaxMs`, `maxAgeMs` (required — same-repo deploy). `slowSpanSchema`: + `waitMs`, `childMs`, `selfMs`. |
| `.../runtime/server/internal/handle-runtime-profiling.ts` | No logic change (new fields flow through; `windowMs` unchanged). |
| `.../runtime/web/components/runtime-section.tsx` | Delete the inline waitSplit reimplementation; derive per-call `waitMs/childMs/selfMs` from the new totals (or import `waitSplit` — core is isomorphic). Columns: "Work" → "Self", + "Child", + "Recent max"; "Max" rendered with age ("990s · 42m ago"). Sort by `recentMaxMs`. Retitle "peaks since boot" → "recent max · <window> window". |
| `.../runtime/server/internal/mcp-tools.ts` | Output: replace `workMs` with `waitMs/childMs/selfMs`; add `recentMaxMs`/`maxAgeMs`; same on `slowest` rows. **Rewrite the tool description** (see docs). Tolerate missing new fields from a stale target backend (this tool proxies HTTP to arbitrary worktrees) — default them rather than crash. |
| `plugins/debug/plugins/profiling/plugins/boot-bench/shared/endpoints.ts` + `server/internal/handle-run.ts` | `profileEntrySchema`/`toProfileEntries`: `workMs` → `selfMs` + `childMs` (from new `waitSplit`). `peakGateWait` unchanged (`waits["heavy-read-acquire"/"heavy-read-local"]` keys survive; values become per-record unions). |
| op-rate (`monitor-job.ts`) | **No change** — reads only `agg.count`; count monotonicity-within-window preserved. |
| slow-ops (`install-slow-span.ts`, `record-slow-op.ts`) | **No change, no migration** — `SlowSpan.waits` stays `Record<string, number>` (values now per-span unions; additive jsonb merge still valid). New SlowSpan fields simply not persisted. Client-signal fabricated waits (`notifications-transport`) unaffected. |
| server-core `loaderStats` → live-state-health / read-set panes | **No change** (still `{count, ratePerMin, maxMs}`). Optional follow-up: expose `recentMaxMs` there. |

### D. Tests — `plugins/infra/plugins/runtime-profiler/core/recorder.test.ts` (bun:test, co-located)

Setup: install a real `AsyncLocalStorage`-backed `SpanContextRuntime` (test-only import of
`node:async_hooks`; core stays pure) + `installClock(() => fakeNow)`; `resetRuntimeProfile()`
per test. Cases:

1. Nested `flush → push → loader`: one `chargeWait("loader-acquire", 50)` appears in all
   three aggregates' `waits` and `waitTotalMs`.
2. Concurrent children with overlapping wait intervals: parent `waitMs` = union
   (< sum, ≤ wall).
3. Coherence: leaf `waitMs + selfMs == wall`; flush `waitMs + selfMs ≤ wall`,
   `childMs ≈ wall`, `selfMs ≥ 0`.
4. Closed-ancestor safety: detached child finishing after parent close doesn't mutate the
   parent's recorded values.
5. Rolling max: spike, advance clock past window → `recentMaxMs` decays, `maxMs`/`maxAgeMs`
   retain the aged peak.
6. No-context `chargeWait` → standalone `db [layer]` span (unchanged fallback).
7. Zero-ms marker creates the layer key with 0 and leaves `waitMs` at 0.
8. `__contribute` unit tests: clip-before-start, fully-covered interval, out-of-order end.

### E. Docs (the deletability payoff)

- `plugins/infra/plugins/runtime-profiler/CLAUDE.md` — rewrite "Wait-vs-work": waits
  propagate to every open ancestor via streaming interval-union (wait ≤ wall at each level);
  document `waitMs/childMs/selfMs`, `recentMaxMs`/`maxAgeMs`, `installClock`, and the full
  layer list (`loader-acquire`, `db-acquire`, `heavy-read-acquire`, `heavy-read-local`,
  `read-admit`, `read-coalesce`, `endpoint-concurrency`, `endpoint-dedupe`,
  `git-coalesce:*`, `git-memo-*`).
- `.claude/skills/debug/SKILL.md:46` — delete the sticky-peak warning; point at
  `recentMaxMs` for "now" and note `maxMs` carries its age. Keep the durable `slow_ops`
  guidance.
- `research/perfs/issue-git-derived-loaders.md` — historical log: append a "Fixed by" note
  under the Measurement-caveat paragraph (don't rewrite history).
- `.../runtime/server/internal/mcp-tools.ts` description — rewrite: every entry (including
  `flush`) reports union `waitMs` at every level, `childMs`, `selfMs`; list the new layers;
  explain `recentMaxMs` vs aged `maxMs`.
- `.../runtime/CLAUDE.md`, boot-bench `CLAUDE.md` — field lists (`workMs` → `selfMs`/`childMs`).

## Files to modify (summary)

- `plugins/infra/plugins/runtime-profiler/core/recorder.ts` (+ new `core/recorder.test.ts`)
- `plugins/database/server/internal/client.ts`
- `plugins/packages/plugins/inflight/core/internal/inflight.ts`
- `plugins/infra/plugins/endpoints/core/implement.ts`
- `plugins/framework/plugins/resource-runtime/core/runtime.ts`
- `plugins/framework/plugins/server-core/core/resources.ts`
- `plugins/infra/plugins/git-read-cache/server/internal/git-state-memo.ts`
- `plugins/debug/plugins/profiling/plugins/runtime/{shared/endpoints.ts, server/internal/handle-runtime-profiling.ts, server/internal/mcp-tools.ts, web/components/runtime-section.tsx}`
- `plugins/debug/plugins/profiling/plugins/boot-bench/{shared/endpoints.ts, server/internal/handle-run.ts}`
- Docs: `plugins/infra/plugins/runtime-profiler/CLAUDE.md`, `.claude/skills/debug/SKILL.md`,
  `research/perfs/issue-git-derived-loaders.md`, runtime/boot-bench `CLAUDE.md`s

## Verification

1. `bun test plugins/infra/plugins/runtime-profiler/core/recorder.test.ts`.
2. `./equin build` (restarts backend → ALS runtime reinstalled), then
   `./equin check` (type-check catches wire/zod drift).
3. **Deterministic gate contention**: `benchmark_boot` MCP tool with `loadConcurrency > 0` —
   saturates the heavy-read flock gate and DB loader gate. Assert in the output:
   loaders report non-zero `waits["heavy-read-acquire"]`/`loader-acquire`/`db-acquire`,
   `selfMs ≥ 0`, `waitMs ≤ avgMs`.
4. **The headline fix**: `get_runtime_profile` during/after the burst — the `flush`
   aggregate now shows populated `waits` (loader-acquire/db-acquire), `childMs ≈ avgMs`,
   small `selfMs`. The old "flush workMs == avg with empty waits" is impossible.
5. **Endpoint gates**: concurrent requests to a route declaring `concurrency`/`dedupe` →
   http aggregate shows `endpoint-concurrency`/`endpoint-dedupe` waits.
6. **Windowed max**: after a spike + ~6 idle minutes, `recentMaxMs` decays while `maxMs` +
   `maxAgeMs` keep the aged peak; Debug → Profiling → Runtime pane shows the retitled table.
7. Run `/verify` on the diff end-to-end.

## Risks

- **Deduped-GET http counts rise** (per-request spans) — accepted; op-rate is
  reset-tolerant and thresholds are config-editable.
- **Conservative undercount** only in theoretical non-end-ordered arrivals (charges arrive
  at interval end by construction, so unions are exact in practice); never overcounts,
  `selfMs` never negative.
- **Stale-backend MCP proxying**: `get_runtime_profile` may hit a worktree running old code
  without the new fields — the tool defaults them instead of crashing.
- `getRuntimeProfile` sort order changes (recentMaxMs desc) — only the runtime UI/MCP
  consume ordering.
