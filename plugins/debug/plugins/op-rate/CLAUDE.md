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
previous tick along **two** axes — `count` (op-rate) and **own time**
`selfTotalMs` (op-time) — plus each gate's metered waits (`gates`), firing
reports only when an op's calls leave its own usual range (op-rate) or a
per-kind budget trips (op-time).

**op-time judges work, never waits.** An op's own time is its wall minus its
gate waits, declared holds (a delivery's `throttle-hold`) and child executions
(each child is judged under its own kind). Summing wall time charged every wait
as slow work: `push deliver:queue-health.pulse — 37.8s/window` was 507 of every
515 ms its own declared throttle, and the `sub *:rows` alarms were read-admit /
read-coalesce queueing with ~1 ms of own work. The waits are not dropped: each
gate's queue/io waits are metered once per wait by the recorder and judged here
against `waitMsPerWindow` as `op-time` with `kind: "wait"`, `label: <layer>`
(fingerprint `op-time:wait:<layer>`), carrying the gate's holders at the trip —
congestion reported once, against what held it. A per-op report carries
`wallMsInWindow` beside its own `msInWindow` for context.

- **`op-rate`** (variant `warning`) — an op (`${kind}:${label}`) called far more
  than it usually is in that kind of window (see *op-rate judges each op against
  its own history*). **One report per distinct hot op** (fingerprint
  `op-rate:<kind>:<label>`), so each over-called op gets its own report pointing
  straight at the cause.
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
`server/internal/op-time-math.ts` (`windowDelta`, `computeRollup`, `gateTrips`); the job owns
only the module-level baseline maps and report emission.

### op-rate judges each op against its own history

A call count says nothing on its own: `push conversations.partial-message` at
~760 calls / 5 min is a watched agent streaming its reply (one push per 50 ms
throttle, ~2.5/s), every window it streams; `flush flushNotifies` at ~1,270 is
ordinary load. One static bar per span kind (500 / 1,000 / 5,000) fired on those
every day, and could not see a loop that is small in absolute terms but far above
what its op normally does. So an op's window is judged against **that op's usual
count in that kind of window** (`server/internal/op-rate-baseline.ts`, pure and
unit-tested):

- **Two regimes.** `boot` — a backend's first window (process start → first
  tick), and the next one too when that tick came within `BOOT_SETTLE_MS` (3 min)
  of the start (the reconnect burst lands after the backend is ready, so a
  process started just before a tick has it in its second window): every tab
  replays its subscriptions, catch-up runs. `steady` — every later window. Main restarts dozens of times a day, so one history mixing them
  would make every boot burst the bar steady windows are judged against.
- **History** — per op, regime and UTC day, how many windows landed in each
  call-count bucket (`op_rate_window_counts`; buckets exact to 16, then a
  quarter-octave apart); per regime and UTC hour, how many windows were judged
  (`op_rate_windows`): a window an op was not called in is the difference; per
  op and UTC hour, its calls (`op_rate_hour_calls`). Each backend writes its own
  (per-worktree DB; excluded from fork, backup and the change feed; swept after
  9 days).
- **Usual** = a high quantile of the op's windows over the **7 days before
  today** (today excluded: a loop that started today is never its own baseline):
  the 99th percentile of steady windows (an op is at most this busy in all but
  ~20 of the week's ~2,000 windows — a recurring burst is usual, a new loop is
  not), the 90th of boot windows. Read as the bucket's upper bound, so it errs
  high (toward not firing).
- **Trips** past `max(minCallsPerWindow, baselineFactor × usual)` (defaults 60
  and 3). Calls are per standard 5-min window: a window the queue stretched is
  scaled down, a short (boot) one is not scaled up.
- **The hour horizon.** A window bar leaves room on a bursty op (main's
  `sub config-v2.values`: median ~100 calls a window, its busiest 1 % ~1,500) for
  a loop that doubles its traffic for hours. Its hours are far smoother, so each
  tick also judges the op's calls in the **clock hour so far** (this window
  included) against the 95th percentile of its past hours (hours with ≥ 10 judged
  windows; ≥ 24 of them needed), past `max(12 × minCallsPerWindow, baselineFactor
  × usual hour)`. The hour so far only grows, so judging it against whole hours
  never fires early; the history is in the DB, so main's restarts (several an
  hour) do not reset it. When both trip, the op's one report is the trip
  furthest past its bar.
- **Warm-up.** Under a day of steady history (288 windows), steady windows are
  judged on the per-kind `…PerWindow` thresholds (the old bars); under 10 past
  boot windows, boot windows are not judged (logged to the `op-rate` channel) —
  what op-rate did before it had a history. A fresh worktree is in warm-up: it
  does not inherit main's history, whose traffic it never carries.
- A report carries `baseline: { over: "boot" | "steady" | "hour", usualCalls }`
  when judged on the history, nothing when judged on the warm-up bar.

### Windowing & counter-reset handling

- The profile counts cumulatively since its **epoch** (`getRuntimeProfile()
  .sinceMs`: process start, or a `resetRuntimeProfile()`). `planTick` reads which
  window a tick closes from the epoch and this process's previous tick: the same
  epoch → a steady window since that tick; the process's first tick → the boot
  window, every count from 0 (a boot burst is judged, never swallowed as a
  seed); a reset since the last tick (boot-bench's synthetic burst) or a first
  tick more than two windows after the start (the queue held the job) → not
  judged, only seeded.
- Within one epoch a count never decreases: a lower one throws.
- **A tick commits only once it succeeded.** The new readings become the state
  the next tick diffs against, and the window joins the history, only after
  every report is filed: a tick that throws and is retried re-diffs the same
  window and records it once.
- **An op new to the history** (no called window in it — a changed SQL text is
  a new `db` label) is judged on the warm-up bar, never as a jump from 0; its
  hour is not judged. The hour horizon judges only ops called in this window,
  so an hour trip stops with its op.
- op-time keeps its own seed rule (`windowDelta`): the first observation of a
  label's time seeds its baseline and fires nothing.

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

- Call-rate: `minCallsPerWindow = 60` and `baselineFactor = 3` (see above). The
  per-kind warm-up bars: `httpPerWindow = 500`, `loaderPerWindow = 500`,
  `subPerWindow = 500`, `pushPerWindow = 500`, `flushPerWindow = 1000`,
  `dbPerWindow = 5000`; `kindThreshold(kind, cfg)` maps each `SpanKind` to its
  field.
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
- **One in-memory pull, two small DB round trips** — the window's calls are added
  to the history (one upsert), and only ops past the lowest bar that could fire
  read theirs; reports fire only on a tripped threshold (silent when healthy), and the engine's velocity limiter +
  dedup absorb bursts. The kind sets `notifCooldownMs ≈ 10 min` so a persistent
  hot op re-alerts the bell periodically without spamming — which is also the
  engine's re-alert floor, so this kind simply sits on it (a cooldown is only
  ever a raise; no kind can ask for silence).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Op-rate + op-time report renderers: one-line Debug → Reports summaries for the op-rate (call-count) and op-time (aggregate-time, with View-trace chip) kinds, plus the per-kind threshold/budget config registration. Profiler-diff monitor: a cheap per-worktree scheduled job that diffs the runtime profiler's per-op call counts (op-rate) AND cumulative wall-clock time (op-time count×cost) each tick, files deduped reports per hot/over-budget op plus a per-kind aggregate-time rollup, and captures a coherent-instant trace on each op-time per-op trip — all through the existing reports engine.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "op-rate"
    - `Reports.KindView` → `OpRateSummary`
    - `Reports.KindView` → `OpTimeSummary`
  - Uses:
    - `config_v2.ConfigV2`
    - `debug/trace/engine.TraceChip`
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `reports.Reports`
- Server:
  - Contributes:
    - `ConfigV2.Register` "op-rate"
    - `report-kind` "op-rate"
    - `report-kind` "op-time"
    - `change-feed-exclusion` "op_rate_hour_calls"
    - `change-feed-exclusion` "op_rate_window_counts"
    - `change-feed-exclusion` "op_rate_windows"
    - `fork-data-exclusion` "op_rate_hour_calls"
    - `fork-data-exclusion` "op_rate_window_counts"
    - `fork-data-exclusion` "op_rate_windows"
    - `backup-data-exclusion` "op_rate_hour_calls"
    - `backup-data-exclusion` "op_rate_window_counts"
    - `backup-data-exclusion` "op_rate_windows"
  - Uses:
    - `config_v2.ConfigV2`
    - `config_v2.getConfig`
    - `database.db`
    - `database.writeAtomically`
    - `database/admin.ExcludeFromBackup`
    - `database/admin.ExcludeFromFork`
    - `database/sql-column.parsedText`
    - `debug/trace/engine.captureTrace`
    - `infra/jobs.defineJob`
    - `infra/retention.defineRetention`
    - `network/live/change-feed.ExcludeFromChangeFeed`
    - `primitives/log-channels.Log`
    - `reports.ReportKind`
    - `reports/engine.recordReport`
  - DB schema: `plugins/debug/plugins/op-rate/server/internal/tables.ts`
  - Register:
    - `defineJob('debug.op-rate-monitor')`
    - `defineJob('retention.op_rate_window_counts')`
    - `defineJob('retention.op_rate_windows')`
    - `defineJob('retention.op_rate_hour_calls')`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields/bool/config.boolField`
    - `fields/int/config.intField`
  - Exports (types):
    - `OpRatePayload`
    - `OpRateRegime`
    - `OpRateSpan`
    - `OpTimePayload`
  - Exports (values):
    - `OP_RATE_REGIMES`
    - `OP_RATE_SPANS`
    - `opRateConfig`
    - `OpRatePayloadSchema`
    - `OpTimePayloadSchema`
- Cross-plugin:
  - Uses tokens: `ui/tokens/color-palette --muted-foreground`

<!-- AUTOGENERATED:END -->
