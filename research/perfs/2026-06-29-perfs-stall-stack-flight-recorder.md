# Plan: on-stall stack-trace flight recorder → name the 40 s event-loop block

**Date:** 2026-06-29
**Category:** perfs
**Status:** Plan — approved mechanism, awaiting implementation
**Predecessor:** [`2026-06-29-conversation-load-40s-eventloop-block-HANDOFF.md`](./2026-06-29-conversation-load-40s-eventloop-block-HANDOFF.md)

## Context

"Loading a conversation on main takes 40+ s." The prior investigation traced this **past**
DB-pool exhaustion, the git heavy-read gate, and the cold-boot fan-out herd (all measured to be
victims/triggers, not the cost) to its real layer: **the main (`singularity`) backend's single
event loop is monopolized by one synchronous CPU operation for 10–46 s at a stretch**, dozens of
times a day. Re-validated today on fresh `health.jsonl` data (Phase 0, not inherited): 34 stalls
>3 s, 14 >10 s, peaks 45.8 / 40.2 / 35 / 28 / 24 s — every one with `gcPreciseCount:0` and
`heavyReadDepth:0` (so: not GC, not the git gate, not memory). Most recent at the time of writing:
11.5 s, ~8 min before this plan. Stalls recur every ~5–25 min, worst shortly after a boot.

**The one open question:** *which* synchronous function blocks the loop? Suspects (unproven):
the live-state flush cascade (`flushNotifies`, observed 10.5 s once) and the `stats/cost/*`
aggregation endpoints (8 maxed 65–77 s simultaneously). The block is too long and recurs too often
to keep guessing — we need to **name the function from a sampled stack captured during a stall**,
then trace it to its origin and fix it at the right altitude.

**Why an on-demand profile won't work:** when the loop is blocked, a POST to "start profiling"
can't even be processed until the block ends. The capture must be **already running** and must
sample on a **separate thread**.

### De-risking already done (the mechanism is proven)

`bun:jsc` exposes `startSamplingProfiler()` + `samplingProfilerStackTraces()`. JSC's sampler runs
on a **separate thread**, so it keeps sampling the blocked main-thread stack during a synchronous
block. Empirically validated (Bun 1.3.13): started the profiler, ran a 1.9 s busy-loop, and the
drained traces correctly named `heavyBusyBlock ← outerCaller` with file/line, ~1000 Hz. Two more
behaviors confirmed:
- **Reading drains the buffer** — `samplingProfilerStackTraces()` returns samples since the last
  read and clears them. So draining once per health tick both bounds memory *and* aligns the
  captured samples to the same window as `eventLoopMaxMs`.
- **Sample rate is fixed (~230 Hz), NOT tunable via the arg.** ⚠️ Correction to an earlier
  de-risking claim: `startSamplingProfiler(optionalDirectory?: string)`'s only argument is an
  *output directory*, not a numeric sample interval — passing a number is silently ignored (which
  is why the observed rate never moved across `1000…80000`). Call it with **no arg**. The real rate
  is derived per-dump as `nSamples / windowSeconds`; the result's `.interval` field is a cosmetic
  constant (`0.001`) and must not be trusted. ~230 Hz over a 40 s block ≈ 9 k samples — far more
  than enough to name the dominant function.

The natural home is `debug/health-monitor`'s `process-sampler.ts`, which is explicitly *"the
diagnostic instrument FOR a wedged backend"*: it already runs a `setInterval` that survives a
blocked loop (the comment notes the histogram accumulates in C even while JS is blocked — the JSC
sampler thread has the same property), already computes `eventLoopMaxMs`, and already writes JSONL.

**Decision (user-approved):** build this as a **permanent flight-recorder**, not a throwaway —
"on every event-loop stall on main, auto-dump the dominant blocking stack." It names the culprit
of this block *and any future one*, which is the reusable primitive the project principle asks for.

## Design

An on-stall stack-trace recorder folded into the existing health sampler. Gated to **main only**
(stalls are a main-backend problem; the host-sampler in the same plugin is already main-only).

### Capture flow (in the existing 10 s `tick()`)

1. At sampler start (main only): `startSamplingProfiler(<arg tuned to ~100–200 Hz>)`.
2. Every tick, after computing `eventLoopMaxMs`: drain `samplingProfilerStackTraces()` **always**
   (bounds memory + aligns the window).
3. If `eventLoopMaxMs > STALL_THRESHOLD_MS` (3000, matching the "34 stalls >3 s" cohort):
   aggregate the drained traces and append one line to a persisted `stall-profiles` log channel.
   Otherwise discard the drained traces.
4. At sampler stop: stop the sampling profiler.

**Why this aligns correctly:** during a 40 s block, no `setInterval` tick fires (the timer is on
the blocked loop), so the JSC buffer accumulates the *entire* 40 s of samples; the first tick after
the block reads `histogram.max ≈ 40 s` **and** drains ~40 s of samples — both describe the same
stall. A 40 s block at ~150 Hz ≈ 6 k frames (~MBs) held transiently — fine. JSC's sampler is itself
a bounded ring, so even a runaway block can't grow memory without bound; we only need the *dominant*
stack, which persists throughout the block.

### Aggregation (the output that names the function)

For the drained traces, emit a small summary (frames[0] is the innermost/leaf — confirmed in the
empirical test):
- **`topLeaves`** — histogram of `frames[0]` keyed by `name @ sourceURL:line`, top 15 with count + %.
- **`topStacks`** — histogram of the full collapsed stack signature (joined frame names), top 10
  with count + % — distinguishes "slow because of one leaf" from "slow because of one call path".
- Metadata: `sampledAt`, `eventLoopMaxMs`, `nSamples`, `sampleRateHz`.

One JSON line per stall to `logs/stall-profiles.jsonl` (top 15/10 → a few KB; ~34/day ≈ ~100 KB/day),
trimmed with the same `rotateIfNeeded`/`MAX_FILE_BYTES` pattern already in `process-sampler.ts`.

**Optional (nice-to-have, not required to name the function):** for stalls > 10 s, also write the
*raw* traces to `logs/stall-profiles/<ts>.json` for offline flame-chart analysis, capped to the
newest N (e.g. 10) files. The aggregated JSONL alone is sufficient for the investigation; include
the raw dump only if cheap to add.

### Files

- **`plugins/debug/plugins/health-monitor/server/internal/stall-profiler.ts`** *(new)* — owns the
  `bun:jsc` calls (`startSamplingProfiler`/`samplingProfilerStackTraces`), the `aggregateTraces()`
  helper, `writeStallProfile()`, the `stall-profiles` `Log.channel(..., { persist: true })`, the
  `STALL_THRESHOLD_MS` / sample-rate constants, and file rotation. Keeps `process-sampler.ts` lean.
- **`plugins/debug/plugins/health-monitor/server/internal/process-sampler.ts`** *(modify)* — in
  `startProcessSampler`/`stopProcessSampler`, start/stop the stall profiler when `isMain()`; in
  `tick()`, drain-every-tick + dump-on-stall as above.
- No new endpoint, flag, schema, or registry edit. `isMain()` is already imported in the plugin's
  `server/index.ts` (`@plugins/infra/plugins/paths/server`, def `paths/core/internal/paths.ts:17`).

### Reuse / precedent (do not re-invent)

- `bun:jsc` direct named import — mirror `plugins/debug/plugins/heap-snapshot/server/internal/handle-heap-stats.ts:1`
  (`import { heapStats } from "bun:jsc"`).
- `Log.channel(name, { persist: true })` — already used at `process-sampler.ts:94` for `"health"`.
- `rotateIfNeeded` + `MAX_FILE_BYTES` — copy the pattern at `process-sampler.ts:44-58`.
- The flush cascade is **already span-measured** (`recordEntrySpan("flush", "flushNotifies", …)`,
  `resource-runtime/core/runtime.ts:484`), so the profiler *corroborates* a suspect rather than
  introducing the first measurement.

## Verification (end-to-end)

1. `./equin build` from the worktree → main restarts and (being main) starts the recorder.
2. **Overhead gate (must pass before declaring done):** compare `health.jsonl` `eventLoopP50Ms` /
   `eventLoopP99Ms` for ~30 min before vs after enabling. The sampler must add negligible steady-state
   lag; if P50 climbs materially, lower the sample rate (raise the start arg) and re-check.
3. **Capture:** watch `~/.singularity/worktrees/singularity/logs/stall-profiles.jsonl` for the next
   entry (natural stall in ~5–25 min). To provoke one deterministically instead of waiting, drive a
   flush burst via the **Debug → Live-State Emit** pane (`debug/live-state-churn/emit`) or run the
   `benchmark_boot` MCP on `singularity`.
4. **Three-converging-evidence (per the perfs skill):** the new entry's `sampledAt`/`eventLoopMaxMs`
   must line up with a `health.jsonl` `eventLoopMaxMs` spike at the same timestamp, and its
   `topLeaves`/`topStacks` must point at a concrete function — that is line 1 (profile) + line 2
   (system data). Line 3 is reading that function's code.

## After capture — do NOT stop at the hotspot (Phase 2 of the real investigation)

Naming the function is necessary but not sufficient. Once named, trace to origin with the
rate×cost + legitimacy gates before writing the cure:
- **If `flushNotifies`/`drainEntry`:** is the batch huge because of *legitimate* state change, or
  because the herd/no-op churn amplifies it? The cure altitude differs — chunk/yield the drain so it
  never monopolizes the loop (containment) **and/or** de-amplify the herd (origin: resubscribe
  stagger + sub admission cap — lever B′; coalesce auto-builds — lever C, from the handoff).
- **If `stats/cost/*`:** prove the aggregation is necessary and irreducible before caching (caching
  is containment, not a cure — perfs skill). Likely fixes: offload the synchronous JS/`git log` to a
  worker, or precompute incrementally, rather than blocking the request loop.
- **If something else:** the recorder named it — decide the altitude then.

The fix is intentionally **not** pre-committed here: this plan delivers the instrument that names the
culprit beyond doubt. The fix gets its own short follow-up once the function is named, sized, and
traced to its origin.

## Out of scope (explicitly)

- Serve-stale L2 snapshot for parametrized resources — demoted in the handoff (a blocked loop can't
  *send* a stale value either); do not build until the synchronous block is fixed.
- Surfacing stall profiles in the Debug → Health pane — a later UI follow-up; the on-disk JSONL is
  enough to name the function now.
