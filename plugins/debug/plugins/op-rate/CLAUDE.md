# op-rate

The **profiler-diff monitor**. Per-call latency (`slow_ops`) misses a
**fast-but-hammered** op; call count alone misses an op that is individually slow;
and neither sees **count×cost** — an op whose per-call time × call volume burns
serious wall-clock. This plugin closes both blind spots from **one** cheap
scheduled job that diffs the runtime profiler each tick, filing everything into
the existing reports engine (the same surface that captures crashes and
queue-health), modeled byte-for-byte on `debug/queue-health` (durable signal →
`ReportKind` → deduped report via a cheap per-worktree scheduled `defineJob`;
investigation task filed on demand). It
points at the **cause** (the hot / over-budget op) instead of only the **blast
radius** (the collateral slow spans).

## What it monitors

One cheap scheduled monitor job (`debug.op-rate-monitor`) samples
`getRuntimeProfile()` per tick and diffs each op's cumulative counters against the
previous tick along **two** axes — `count` (op-rate) and `totalMs` (op-time) —
firing reports only when a per-kind threshold/budget trips:

- **`op-rate`** (variant `warning`) — an op (`${kind}:${label}`) called more than
  its per-kind threshold within one monitor window. **One report per distinct hot
  op** (fingerprint `op-rate:<kind>:<label>`), so each over-called op gets its own
  report pointing straight at the cause.
- **`op-time`** (variant `warning`) — the aggregate-time (count×cost) twin. Two
  shapes discriminated by `label`:
  - **per-op** (`op-time:<kind>:<label>`) — one op consumed more than its per-kind
    **ms budget** (`kindMsBudget`) within the window. Carries both `msInWindow` and
    `callsInWindow` so the renderer states the rate×cost decomposition ("N calls ×
    ~M ms avg"). Each per-op trip also calls `captureTrace({ kind: "op-time", … })`
    (normal engine admission) to grab the coherent-instant flight window — what was
    in flight *while the op burned time* — and stamps the returned `traceId` into
    the report `data`, so the KindView / renderTask can deep-link the evidence
    (Debug → Slow Events). This is the second `captureTrace` call site, proving the
    generic trigger API beyond slow-ops.
  - **rollup** (`op-time:rollup:<kind>`) — the sum of a kind's per-op ms deltas
    exceeded `budgetMs × rollupFactor`, catching cost smeared across many labels
    each under its own per-op budget. `data.topLabels` carries the top-10
    contributors by ms delta. No single op to point at, so no trace.

The delta/rollup arithmetic is extracted into the pure, unit-tested
`server/internal/op-time-math.ts` (`windowDelta`, `computeRollup`); the job owns
only the module-level baseline maps and report emission.

### Windowing & counter-reset handling

- A module-level `Map<string, number>` (`${kind}:${label}` → last `count`), per
  process, holds the previous tick's baseline.
- Each tick: `delta = count - prev`. If `count < prev` (the profile was reset via
  `resetRuntimeProfile()`, or the label is new) the full current count is taken as
  the delta (reset-safe).
- **First observation of a label seeds the baseline and fires nothing** — avoids a
  false spike from the full since-boot count on the first tick.
- `delta` is "calls in this window"; the window is the cron interval. `WINDOW_MS`
  (5 min) is informational only — the trip decision is on raw `delta` vs the
  per-kind threshold, so cron skew never changes correctness.

### Top-N cap

A pathological burst across many ops is capped at the top **20** per-op trips per
tick (ranked by delta desc) to bound report creation. The cap is **combined** across
op-rate and op-time per-op trips — one ranking, one budget — so a storm on either
axis can never storm report creation. The sort key is each trip's own delta (calls
for op-rate, ms for op-time); the units differ, so the ranking exists only to
decide which trips to drop under the shared cap, not to compare severity across
op types. Over-cap trips are not silently dropped — the dropped count is logged to
the `op-rate` log channel (per repo policy: no silent truncation). Per-kind rollup
reports are separate (≤ one per kind, ≤ 7 total) and not subject to this cap.

## Thresholds & budgets (config_v2, mirroring slowOpConfig)

`enabled = true`, plus, for each span kind, a `…PerWindow` **call-rate** threshold
(op-rate) and a `…MsPerWindow` **aggregate-time** budget (op-time), read live each
tick via `getConfig` and editable in Settings → Config:

- Call-rate: `httpPerWindow = 500`, `loaderPerWindow = 500`, `subPerWindow = 500`,
  `pushPerWindow = 500`, `flushPerWindow = 1000`, `dbPerWindow = 5000`. `db` (every
  query) and `flush` (each internal notify cycle) are inherently high-count, so a
  single threshold would drown the signal — hence per-kind. `kindThreshold(kind,
  cfg)` maps each `SpanKind` to its field.
- Aggregate-time (ms/window): `httpMsPerWindow = 30000`, `loaderMsPerWindow =
  60000`, `subMsPerWindow = 15000`, `pushMsPerWindow = 30000`, `flushMsPerWindow =
  60000`, `dbMsPerWindow = 60000`, `jobMsPerWindow = 120000`, plus `rollupFactor =
  4`. Defaults sit ~1–2 orders of magnitude above typical healthy 5-min per-op
  deltas (single-digit seconds), so a breach is a genuine cost signal; `sub` is
  tighter (origin work should be cheap), `job` loosest (backfills/syncs run long).
  `kindMsBudget(kind, cfg)` maps each `SpanKind` to its field.

## Why a pull-diff job (not a recorder hook)

The recorder (`runtime-profiler/core/recorder.ts`) is load-bearing, zero-dep, and
isomorphic — it must not gain a back-edge to a monitor. It already accumulates
`count` cumulatively. The job and the recorder live in the **same worktree
process**, so the job imports `getRuntimeProfile()` directly and diffs successive
snapshots in module-level state. The recorder stays pure. (Same separation as
live-state-churn's accumulator + scheduled job.)

## Why per-worktree, singleton, cheap

- **`perWorktree: true`** — the runtime profiler is per-process in-memory state, so
  call counts accumulate per-backend and must be sampled per-backend.
- **`dedup: "singleton"`** — the monitor itself can never pile up.
- **`maxAttempts: 3`** — a transiently-broken monitor doesn't become a dead-job
  storm of its own.
- **One in-memory pull, no DB reads** — negligible cost; reports fire only on a
  tripped threshold (silent when healthy), and the engine's velocity limiter +
  dedup absorb bursts. The kind sets `notifCooldownMs ≈ 10 min` so a persistent
  hot op re-alerts the bell periodically without spamming — which is also the
  engine's re-alert floor, so this kind simply sits on it (a cooldown is only
  ever a raise; no kind can ask for silence).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Op-rate + op-time report renderers: one-line Debug → Reports summaries for the op-rate (call-count) and op-time (aggregate-time, with View-trace chip) kinds, plus the per-kind threshold/budget config registration. Profiler-diff monitor: a cheap per-worktree scheduled job that diffs the runtime profiler's per-op call counts (op-rate) AND cumulative wall-clock time (op-time count×cost) each tick, files deduped reports per hot/over-budget op plus a per-kind aggregate-time rollup, and captures a coherent-instant trace on each op-time per-op trip — all through the existing reports engine.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "op-rate"
    - `Reports.KindView` → `OpRateSummary`
    - `Reports.KindView` → `OpTimeSummary`
  - Uses:
    - `apps-core/tabs.appLink`
    - `config_v2.ConfigV2`
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `primitives/css/link-chip.LinkChip`
    - `reports.Reports`
    - `ui/icons.Icon`
- Server:
  - Contributes:
    - `ConfigV2.Register` "op-rate"
    - `report-kind` "op-rate"
    - `report-kind` "op-time"
  - Uses:
    - `config_v2.ConfigV2`
    - `config_v2.getConfig`
    - `debug/trace/engine.captureTrace`
    - `infra/jobs.defineJob`
    - `primitives/log-channels.Log`
    - `reports.ReportKind`
    - `reports/engine.recordReport`
  - Register: `defineJob('debug.op-rate-monitor')`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields/bool/config.boolField`
    - `fields/int/config.intField`
  - Exports (types):
    - `OpRatePayload`
    - `OpTimePayload`
  - Exports (values):
    - `opRateConfig`
    - `OpRatePayloadSchema`
    - `OpTimePayloadSchema`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/shape --spacing`

<!-- AUTOGENERATED:END -->
