# Slow-event flight recorder — coherent-window snapshots for blocking-chain attribution

## Context

When an op is slow (loader, HTTP endpoint, job, live-state flush, WS delivery), today's
monitoring keeps only per-op aggregates: `slow_ops` rows (avg/max/count/waits) and the
runtime profiler's per-label aggregates + slowest-50 rings. Aggregates destroy the two
things queueing-pathology attribution needs:

- **Temporal correlation** — which ops were concurrently in flight in the same window.
- **Wait causality** — who held the DB-pool / heavy-read slots, who queued behind whom.

Every root cause in `research/perfs/` (pool-exhaustion flush cascade, reconnect fan-out
herd, notifications TOAST bloat, `buildPluginTree` loop block, launch-conversation IO
contention) burned multiple sessions manually re-assembling one instant in time from
`get_runtime_profile` dumps, `slow_ops`, ad-hoc SQL, `health.jsonl` — and twice required
building a new one-off instrument. The stall flight-recorder
(`debug/health-monitor/server/internal/stall-profiler.ts` → `stall-profiles.jsonl`)
proved the shape — always-on cheap capture, persist only on threshold trip, bounded
overhead — but only for synchronous event-loop blocks.

**Goal:** any op crossing its slow threshold produces exactly ONE persisted
coherent-window snapshot (concurrent spans with parent links, gate occupancy and queue
depths) from which the blocking chain can be named in a single read. Always-on,
negligible steady-state overhead (serialization paid only on slow events), rate-limited
per kind so a slow-event storm cannot saturate the recorder.

## Design summary

Four pieces, mirroring existing precedents byte-for-byte where they exist:

1. **Recorder core additions** (`runtime-profiler/core/recorder.ts`, stays zero-dep +
   isomorphic): an enumerable **open-entry registry** (`Set<EntryContext>` — nothing can
   currently list in-flight spans across requests), a **preallocated ring of
   recently-completed spans** (the blocker often finishes before its victim's span ends),
   a **gate-gauge registry** (`registerGateGauge(layer, read)` — layer names identical to
   the `chargeWait` vocabulary so occupancy joins to span `waits`), and one synchronous
   `captureFlightWindow()` that materializes all three.
2. **Gate occupancy** — `stats()` on `packages/semaphore`; gauges registered by the gate
   *owners* (database client, host-read-pool, server-core for the read-admit gate), never
   named by the consumer (collection-consumer rule).
3. **Consumer plugin `plugins/debug/plugins/flight-recorder/`** (mirrors `slow-ops`):
   subscribes via `onSlowSpan` reusing the slow-op thresholds, per-op cooldown + global
   cap **checked before capture**, synchronous capture at the trip instant, async enrich
   (contention snapshot) + persist to `logs/flight-recorder.jsonl` via
   `Log.channel(..., { persist: true })` with the stall-profiler's `rotateIfNeeded`.
4. **Verification** — a synthetic slow-op check for the exactly-one guarantee, and a
   before/after overhead gate (benchmark_boot + `health.jsonl` event-loop p50/p99).

Snapshots are **decoupled** from the slow-op report/task (no new ReportKind, no extra
task noise); they join by `(wallTime, kind, label)` — same timestamp-join idiom as
`stall-profiles.jsonl` / `health.jsonl` / slow-op markers.

## How a snapshot names the blocking chain in one read

`trip.waits` names the layer the victim queued on (e.g. `heavy-read-acquire: 3500`) →
`gates["heavy-read-acquire"]` shows saturation (`active 4/4, queued 11`) → the `open` +
`completed` spans whose `waits` include the same layer are the co-queuers; the span among
them with dominant `selfMs`/`childMs` overlapping the window is the holder. All in one
JSONL line.

---

## Phase 1 — recorder core: open-entry registry + completed ring + capture

**Modify `plugins/infra/plugins/runtime-profiler/core/recorder.ts`** (zero-dep — a Set,
an array, and a Map need no imports; web no-op behavior unchanged and all new hot-path
code is O(1) balanced work).

### Open-entry registry

```ts
// Side-table of currently-open ENTRY contexts. EntryContexts are otherwise
// reachable only via the ambient async chain of one request, so this is what
// lets a snapshot enumerate every concurrently in-flight op.
const openEntries = new Set<EntryContext>();
```

- In `recordEntrySpan` (recorder.ts:654): `openEntries.add(ctx)` right before the
  `try { return await contextRuntime.run(ctx, fn) }`.
- In the `finally`, right after `ctx.closed = true` (line 692) and before `record(...)`:
  `openEntries.delete(ctx)`. The tripping span is thus never in its own `open` list (it
  is the snapshot's `trip`), and add/delete are exactly paired — no leak path.
- Leaf `db` spans are NOT registered (no context object exists); they are covered by the
  completed ring.

### Recently-completed ring

Preallocated, allocation-free circular buffer of mutable slots (steady state = a
comparison + ~10 field writes; label strings are shared references, not copies):

```ts
const FLIGHT_RING_CAPACITY = 4096;
const FLIGHT_RING_MIN_MS = 5; // sub-5ms spans can't matter to a >=500ms window
interface FlightRingSlot {
  used: boolean; kind: SpanKind; label: string;
  t0: number; t1: number;
  parentKind: SpanKind | null; parentLabel: string | null;
  waitMs: number; childMs: number; selfMs: number;
}
const flightRing: FlightRingSlot[] = /* preallocated */;
let flightRingHead = 0;
```

`pushCompleted(...)` writes a slot and advances the head; called at the END of `record()`
(after the `slowest` ring block, recorder.ts:519) with `atMs` as `t1` — so it naturally
sits behind the existing `SINGULARITY_PROFILING === "0"` and suppression early-returns
(observability's own suppressed writes never enter the ring). Do NOT shadow the local
`ring` variable already used for `slowest` in `record()` — name everything `flightRing*`.

### Gate-gauge registry

```ts
export interface GateGauge { active: number; queued: number; max: number }
const gateGauges = new Map<string, () => GateGauge>();
export function registerGateGauge(layer: string, read: () => GateGauge): void {
  if (gateGauges.has(layer)) throw new Error(`registerGateGauge: duplicate layer ${layer}`);
  gateGauges.set(layer, read);
}
export function readGateGauges(): Record<string, GateGauge> { /* invoke each */ }
```

Lives here (not a new plugin) because layer names are already this module's vocabulary
(`chargeWait` layers) and both main registrants already import this barrel. The recorder
never names a gate; owners self-register.

### Capture

```ts
export interface FlightSpan {
  kind: SpanKind; label: string;
  t0: number; t1: number | null;      // null => still open at capture
  ageMs: number;                       // (t1 ?? captureAt) - t0
  parents: SpanRef[];                  // innermost→outermost, capped depth
  waitMs: number; childMs: number; selfMs: number;
  waits?: WaitBreakdown;               // per-layer; OPEN spans only (live layerUnions)
}
export interface FlightWindow { atMs: number; open: FlightSpan[]; completed: FlightSpan[] }
export function captureFlightWindow(opts: {
  windowStartMs: number; maxOpen?: number; maxCompleted?: number; maxParentDepth?: number;
}): FlightWindow
```

- `open`: walk `openEntries`; per ctx snapshot `t0=startMs`, `ageMs`, parent chain
  (labels only, depth cap 8), `waitMs = waitUnion.unionMs`, `childMs`,
  `selfMs = max(0, age - busyUnion.unionMs)`, and per-layer `waits` from `layerUnions`.
  Reading `unionMs` mid-flight is sound: it is monotonic accumulated coverage.
- `completed`: scan `flightRing` newest→oldest, keep slots with `t1 >= windowStartMs`
  (window overlap), stop at `maxCompleted` (default 400). Immediate parent only.
- Caps: `maxOpen` 200, `maxCompleted` 400. Allocation happens only here — i.e. only on a
  (rate-limited) trip.

**Barrel:** export `captureFlightWindow`, `registerGateGauge`, `readGateGauges`,
`FlightSpan`, `FlightWindow`, `GateGauge` from
`plugins/infra/plugins/runtime-profiler/core/index.ts`. Update the plugin's `CLAUDE.md`
prose (flight-recorder section).

## Phase 2 — gate occupancy gauges

### `packages/semaphore` — `stats()`

`plugins/packages/plugins/semaphore/core/internal/semaphore.ts`: add to the `Semaphore`
interface and returned object:

```ts
stats(): { active: number; queued: number; max: number };
// impl: () => ({ active, queued: waiters.length, max })
```

Zero hot-path cost (reads two existing counters). Update `semaphore/CLAUDE.md`.

### Registrations (layer name == `chargeWait` layer name)

- **`plugins/database/server/internal/client.ts`** (already imports the recorder barrel):
  - `"loader-acquire"` → `loaderDbGate.stats()`
  - `"db-pool"` → `{ active: pool.totalCount - pool.idleCount, queued: pool.waitingCount, max: POOL_MAX }`
    (pg.Pool counters are free property reads; `db-pool` is a new gauge-only name — the
    corresponding wait layer is `db-acquire`, note it in the doc).
- **`plugins/infra/plugins/host-read-pool/server/internal/pool.ts`**:
  - `"heavy-read-local"` → `perWorktreeGate.stats()`
  - `"heavy-read-acquire"` → `{ active: heldByThisProcess, queued: pool.depth(), max: heavyReadSize() }`
    where `heldByThisProcess` is a local counter incremented after the host slot is
    acquired / decremented in a `finally` inside `withHeavyReadSlot`. **Limitation
    (documented in the snapshot doc + CLAUDE.md):** host-*wide* occupancy across other
    worktree processes is not cheaply readable from flock files; v1 reports this
    process's held count + this process's parked depth.
- **read-admit** (the `readLoadGate = createSemaphore(READ_LOAD_CONCURRENCY)` inside
  `createResourceRuntime`, `plugins/framework/plugins/resource-runtime/core/runtime.ts`
  ~769): resource-runtime must stay profiler-free (its profiler hooks are injected). Add
  a `readGateStats(): { active, queued, max }` method to the object returned by
  `createResourceRuntime` (thin delegate to `readLoadGate.stats()`), and in
  `plugins/framework/plugins/server-core/core/resources.ts` (which already wires
  `onReadGateWait: (ms) => chargeWait("read-admit", ms)` at line 203) register:
  `registerGateGauge("read-admit", () => runtime.readGateStats())`.

Skipped in v1: per-route endpoint gates (`endpoint-concurrency`/`endpoint-dedupe` are
per-route instances — a follow-up if route-level saturation ever needs a gauge), and
graphile job slots (SQL-polled; join to queue-health by timestamp instead of querying
the DB mid-incident).

## Phase 3 — consumer plugin `plugins/debug/plugins/flight-recorder/`

Mirror `slow-ops`' file shape (`core/config.ts` + `server/index.ts` +
`server/internal/*`). No web plugin in v1.

### `core/config.ts`

```ts
export const flightRecorderConfig = defineConfig({
  name: "flight-recorder",
  fields: {
    enabled:    boolField({ default: true }),
    cooldownMs: intField({ default: 10_000 }),  // per-(kind:label) snapshot cooldown
    maxPerMin:  intField({ default: 30 }),      // global snapshot cap
    windowMs:   intField({ default: 10_000 }),  // min lookback (window = max(trip duration, this))
  },
});
```

Slow thresholds are NOT duplicated — reuse the `slow-op` config (below).

### Reuse the slow-threshold resolver

`plugins/debug/plugins/slow-ops/server/internal/install-slow-span.ts` already holds
`thresholdFor(span, thresholds)` (per-kind config + per-route/per-job overrides). Rename
to `resolveSlowThreshold`, export it (plus its `Thresholds` type) from the
`slow-ops/server` barrel, and have `install-slow-span.ts` and flight-recorder both use
it. (Debug→debug barrel import; keeps "what is slow" single-sourced.)

### `server/internal/rate-limit.ts`

```ts
const lastByOp = new Map<string, number>();  // "kind:label" -> last snapshot atMs
let minuteStart = 0, minuteCount = 0;
export function admitSnapshot(key: string, atMs: number, cooldownMs: number, maxPerMin: number): boolean
```

Per-op cooldown + global per-minute token bucket (in-process, mirrors reports'
velocity-limiter idiom). Bound `lastByOp` (e.g. clear when > 2048 entries — labels are
bounded in practice but don't rely on it).

### `server/internal/trip.ts`

```ts
export function tripAndPersist(span: SlowSpan, cfg): void {
  if (!admitSnapshot(`${span.kind}:${span.label}`, span.atMs, cfg.cooldownMs, cfg.maxPerMin)) return;
  // 1) SYNCHRONOUS coherent-instant capture — no await between these reads.
  const windowStartMs = span.atMs - Math.max(span.durationMs, cfg.windowMs);
  const flight = captureFlightWindow({ windowStartMs });
  const gates = readGateGauges();
  // 2) Async enrich + persist, fire-and-forget, self-suppressed.
  void runWithoutProfiling(async () => {
    const contention = await getContentionSnapshot();  // memoized <=1s
    persistSnapshot(buildSnapshot(span, windowStartMs, flight, gates, contention));
  });
}
```

Rate-limit check runs BEFORE capture, so a storm costs a Map lookup per slow span.
The handler path never throws into the profiler hot path and never awaits in it
(same contract as `install-slow-span.ts`).

### `server/internal/persist.ts`

`Log.channel("flight-recorder", { persist: true })` →
`~/.singularity/worktrees/<wt>/logs/flight-recorder.jsonl`; copy
`rotateIfNeeded()` from `stall-profiler.ts:95-107` with `MAX_FILE_BYTES = 4_000_000`
(trim to newest half; bounded without a job).

### `server/internal/install-hook.ts`

Mirror `installSlowSpanHook`: dispose-and-reinstall `onSlowSpan` with
`floor = min(loaderMs, httpMs, dbMs, jobMs)`; in the handler, gate on
`resolveSlowThreshold(span, thresholds)`, then `tripAndPersist(span, cfg)`. Skip
installation entirely when `cfg.enabled` is false.

### `server/index.ts`

`ServerPluginDefinition` with `ConfigV2.Register({ descriptor: flightRecorderConfig })`;
in `onReady`, `watchConfig` BOTH `slowOpConfig` and `flightRecorderConfig`, reinstalling
the hook with the latest pair (slow-ops' reinstall-on-change pattern). Also register the
verification endpoint (Phase 5): `POST /api/debug/flight-recorder/test-slow-op` →
`recordEntrySpan("loader", "flight-recorder-test", () => sleep(ms from body))`.

### Snapshot JSON schema (one line per snapshot)

```jsonc
{
  "v": 1,
  "atMs": 41234567.8,            // profiler clock (installClock seam)
  "wallTime": "2026-07-02T…Z",   // Date.now() — joins health.jsonl / stall-profiles.jsonl / slow-op markers
  "worktree": "…",
  "trip": {                       // the op that crossed its threshold (from SlowSpan)
    "kind": "loader", "label": "edited-files",
    "durationMs": 4032, "thresholdMs": 2000,
    "parent": { "kind": "flush", "label": "flushNotifies" },
    "waitMs": 3500, "childMs": 0, "selfMs": 532,
    "waits": { "heavy-read-acquire": 3500 }
  },
  "windowStartMs": 41230535.8,
  "open": [ /* FlightSpan[] — concurrently in-flight entries at the trip instant */ ],
  "completed": [ /* FlightSpan[] — ring spans overlapping the window */ ],
  "gates": {                      // occupancy at the same instant, keyed by chargeWait layer
    "heavy-read-acquire": { "active": 4, "queued": 11, "max": 4 },
    "heavy-read-local":   { "active": 8, "queued": 3,  "max": 8 },
    "loader-acquire":     { "active": 10, "queued": 6, "max": 10 },
    "db-pool":            { "active": 16, "queued": 9, "max": 16 },
    "read-admit":         { "active": 6, "queued": 2,  "max": 6 }
  },
  "contention": { /* ContentionSnapshot: loadAvg1/5/15, cpuCount, pgActiveBackends, pgTopDatabases */ }
}
```

Size caps: maxOpen 200 / maxCompleted 400 / parent depth 8 / labels already capped by
the recorder (`MAX_LABEL_LEN`). Worst case tens of KB per line; 4 MB file ≈ hundreds of
snapshots.

## Phase 4 — overhead gate (before/after)

Steady-state additions are: one `Set.add`+`Set.delete` per *entry* span (entry spans are
low-rate: http/loader/sub/push/flush/job — never per-DB-query), one duration comparison
per recorded span, ~10 field writes (zero alloc) per qualifying completed span, and a
Map lookup per slow span. Verify empirically:

1. `benchmark_boot` MCP tool (boot-bench), N runs on this worktree before the diff vs
   after — boot time within run-to-run noise.
2. Fixed workload (e.g. the boot-bench burst or the live-state-churn emitter at a set
   rate), compare `health.jsonl` `eventLoopP50/P99` before vs after — unchanged within
   variance.
3. Kill-switch check: `SINGULARITY_PROFILING=0` short-circuits `record()`/`chargeWait()`
   before the new code — confirm ring/gauges stay empty (openEntries add/delete still
   runs; it is O(1) and paired — acceptable, matches recordEntrySpan's existing
   always-on context work).

## Phase 5 — exactly-one-snapshot functional test

Using the test endpoint (loader threshold default 2000ms):

1. `POST /api/debug/flight-recorder/test-slow-op {ms: 2500}` → exactly ONE new line in
   `flight-recorder.jsonl`; `trip.label === "flight-recorder-test"`; non-empty `gates`
   with all five layers; `open`/`completed` arrays present.
2. Fire it 5× within `cooldownMs` → still exactly one line (per-op cooldown).
3. Fire two slow ops with different labels concurrently (test endpoint + a real slow
   loader, or two labels via a `label` param) → two lines; each `open` list contains the
   other op.
4. Optional realism: `debug/live-state-churn` emit pane to drive flush load and eyeball
   a real snapshot's coherence.

Also run `bun test plugins/infra/plugins/runtime-profiler/core/recorder.test.ts` and add
cases: open-entry registry add/remove pairing (incl. throwing fn), ring window-overlap
filtering, capture caps, gauge registry duplicate-layer throw.

## File manifest

**Modify**
- `plugins/infra/plugins/runtime-profiler/core/recorder.ts` — openEntries, flightRing,
  gate-gauge registry, `captureFlightWindow`
- `plugins/infra/plugins/runtime-profiler/core/index.ts` + `CLAUDE.md`
- `plugins/infra/plugins/runtime-profiler/core/recorder.test.ts` — new cases
- `plugins/packages/plugins/semaphore/core/internal/semaphore.ts` (+ `CLAUDE.md`) — `stats()`
- `plugins/database/server/internal/client.ts` — register `loader-acquire`, `db-pool`
- `plugins/infra/plugins/host-read-pool/server/internal/pool.ts` (+ `CLAUDE.md`) —
  held-count wrapper, register `heavy-read-*`
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — expose `readGateStats()`
- `plugins/framework/plugins/server-core/core/resources.ts` — register `read-admit`
- `plugins/debug/plugins/slow-ops/server/internal/install-slow-span.ts` +
  `server/index.ts` — export `resolveSlowThreshold` + `Thresholds`

**Create**
- `plugins/debug/plugins/flight-recorder/core/{index.ts,config.ts}`
- `plugins/debug/plugins/flight-recorder/server/index.ts`
- `plugins/debug/plugins/flight-recorder/server/internal/{install-hook.ts,trip.ts,rate-limit.ts,persist.ts,build-snapshot.ts,handle-test-slow-op.ts}`
- `plugins/debug/plugins/flight-recorder/CLAUDE.md` — incl. "how to read a snapshot"
  (the blocking-chain walk) and the timestamp-join to stall-profiles/health/queue-health

Then `./equin build` (registry regen) and the Phase 4/5 verification.

## Non-goals (v1)

- **Web viewer pane** (Debug → Flight Recorder rendering the blocking chain) — follow-up;
  reads the JSONL like health-monitor reads `health.jsonl`.
- **Gate holder-identity capture** (which label holds each slot) — reconstructed from
  open spans' `waits`; direct capture would couple the semaphore primitive to the profiler.
- **Host-wide heavy-read occupancy** across other worktree processes (flock-file probe is
  not cheap); per-process held + queue depth only.
- **Inline job-queue SQL** in the snapshot (no DB load mid-incident) — join to
  queue-health reports by timestamp.
- **File-watcher instrumentation, WS backpressure gauges, payload byte accounting** —
  WS delivery is already visible via `deliver:<key>` push spans in the window.
- **A new ReportKind / task per snapshot** — the slow-op report already files the task;
  snapshots join by timestamp + (kind, label).
- **Cross-restart durability** of ring/registries — in-memory, matches profiler precedent.
