# sentinel

The **cluster congestion sentinel** (plans:
`research/2026-07-10-global-congestion-observability.md` Phase B;
`research/2026-07-11-global-observability-freeze-blind-spots.md` Stages 3+5;
`research/2026-07-11-global-fleet-memory-admission-duress-valve.md` Piece 2).
A main-only, always-on sampler that gives the observability stack what no
per-backend monitor can: the *cluster-wide* vitals at every instant, recorded
continuously so congestion onset is captured **prospectively**, not
reconstructed from the first victim's threshold trip.

## Architecture: everything critical lives on a worker thread (Stage 5)

During the 2026-07-11 03:29 freeze the duress latch **cleared mid-thrash**:
sampling and lease renewal rode main's own event loop, and a blocked loop
cannot renew a 60 s lease. So the sampler, the onset detector, AND the whole
latch lifecycle run on a dedicated Bun `Worker` (`server/internal/worker/`),
whose thread keeps ticking while main is wedged. **The worker is the single
latch owner** — no `setDuress/refreshDuress/clearDuress` call exists on main.

- `worker/entry.ts` — the worker: `setInterval(cadenceMs)` tick, the pure
  detector, latch set/refresh/clear, duress-episode lines, max-episode-hold.
  Lean closure, enforced by `sentinel:worker-closure-lean` (`check/`): a worker
  has no plugin runtime, so its static closure may reach no `config_v2/server`,
  `jobs/server`, `database/server` or `server-core` module (thresholds arrive
  as frames). Import schemas and helpers from `core` barrels, never a `server`
  barrel that happens to re-export them.
- `worker/pg.ts` — ONE dedicated raw `pg` client on the embedded cluster's
  direct Unix socket (no drizzle pool, no PgBouncer): sharing main's pool
  would re-couple the sentinel to the contention it measures. The read goes
  through `queryOne` + `PgStatsRowSchema`, so a column whose Postgres type
  stops matching what the sampler assumes fails loudly rather than silently
  reading as `NaN`. On error: null pg fields, one in-tick reconnect attempt,
  a log frame.
- `worker/sample.ts` — the impure gatherers (gateway fleet fetch, `ps` scan,
  health.jsonl p99 rollup, health-host.jsonl compressor tail). Per-signal
  degradation: every sub-read fails into null fields + a log line, never the
  tick.
- `worker-host.ts` (main) — spawns/supervises the worker: spawn with
  `argv: namespaceArgv()` (see "Worker identity" below), respawn with capped
  backoff (a respawned worker **adopts a fresh existing latch** at init and
  keeps refreshing), a rapid-failure give-up (5 immediate deaths → status
  `down`, no respawn loop), a supervision status on every transition (see "When
  the watcher dies" below), live threshold push (`sampler.ts` watches config
  and calls `pushSentinelThresholds`), graceful stop (worker clears the latch,
  acks, then terminate). Config-free, so a test drives it with any worker.
- `sampler.ts` / `onset.ts` (main) — **best-effort re-emitters only**: sample
  frames → `cluster` trace ring + `onSentinelSample` listeners; trip frames →
  `captureTrace({kind:"cluster-onset", critical: true})`; log frames → the
  `sentinel` channel. Nothing main-side is on the latch's critical path.

If main's whole process dies the worker dies with it and the lease lapses
within 60 s — the fleet self-recovers (unchanged fail-safe). The worker's
`setInterval` is the sentinel's documented exception to the no-polling rule
(the diagnostic instrument FOR cluster duress cannot ride the job queue that
the congestion it measures saturates).

**Compiled releases** (verified on Bun 1.3.13): `bun build --compile` does NOT
trace/embed `new Worker(new URL(...))`, so the worker is **vendored** instead —
`release.ts` bundles `worker/entry.ts` to a standalone `<out>/sentinel/worker.js`
(its lean closure inlines), `launch.ts` points `SINGULARITY_SENTINEL_WORKER_JS`
at it, and `worker-host.ts` spawns from that path when the env is set (else the
dev source URL). This mirrors the vendored parcel-watcher native addon. The
start-gate also admits releases: a release's single backend runs under the
composition name (so `isMain()` is false), so `sentinel/server/index.ts` starts
on `isHostSingleton()` (`isMain() || isRelease()`) — a release runs exactly one
backend, so it stays the host singleton. See `research/sentinel-worker-in-compiled-release.md`.

## Worker identity: declared from argv, before any import

A worker thread shares no module state with the backend that spawned it, so it
starts with no runtime namespace — and modules in its import graph resolve paths
from `runtimeNamespace()` as they load. So the namespace cannot arrive over the
`init` message (that lands after the whole graph ran): from 2026-09-15 to
2026-09-16 it did, and the worker threw at load on every spawn.

`worker-host.ts` spawns `new Worker(url, { argv: namespaceArgv() })`, and
`worker/entry.ts`'s literal first import is `./declare-namespace`, which reads
`process.argv` through `readNamespaceArgv` (`infra/runtime-identity`) and
declares it — the same shape as a backend's `server-core/bin/declare-namespace.ts`.
Bun exposes the Worker `argv` option as the thread's `process.argv` before the
first module evaluates (verified on Bun 1.4.2), and the vendored release bundle
keeps import order, so dev and release spawn identically. The `init` frame
carries no namespace; the worker reads `runtimeNamespace()` (also its pg
database name).

## When the watcher dies

`worker-host.ts` reports every supervision transition through `onStatus`:
`starting` → `running` (on `ready`) → `respawning {deaths, lastError}` →
`down {deaths, lastError}` (on give-up), and `stopped` on shutdown; `sampler.ts`
records `disabled` when `sentinel.enabled` is off. `lastError` is the latest
worker `error` event's message (also logged to the `sentinel` channel).

`sampler.ts` routes each one through `createStatusSink` (`status-sink.ts`):

- **`down` files a `sentinel-down` report** (`sentinel-down-kind.ts`: variant
  `error`, `duressExempt`, one fixed fingerprint) — bell, Debug → Reports and the
  Timeline. Filed before the file write, so a failing write cannot swallow it.
- **Every status is written to the host's own status file**
  `locks/sentinel/status.<pid>.json` (declared in `data-dirs/`, beside the
  duress latch) as `{status, pid, claimedAt}`, write-then-rename. Readers report
  the newest `claimedAt`. One file per host, never a shared one: a hot restart's
  old backend writes `stopped` in the same instant the new one writes
  `starting`, and over one shared file any "only while I own it" check is a
  read-then-rename that interleaving defeats (2026-10-08: the row read "not
  running" while the new watcher ran). A host's first write deletes the files
  of hosts whose pid is gone.
- **Every backend** (not just main) serves those files as the `sentinel.status`
  value — `liveValue` `sentinelStatus` in `core/status.ts`, served by
  `serveValue(…, { source: "external" })` as `sentinelStatusServed`
  (`status-resource.ts`), and re-read on each change via the
  `infra/file-watcher` primitive, whose events call
  `sentinelStatusServed.notify()`. The read adds `ownerAlive` (is the recorded
  pid alive), so a main that died without writing `stopped` reads as not
  running. No placeholder: until the first read lands the row is `unknown`.

The web half is the health report's **Machine watcher** row: `critical` when
`down` or the owner process is gone, `attention` (pulsing) while starting,
restarting or stopping, `attention` when disabled, `ok` while running, `unknown`
with a reason when no status was ever recorded or the file is unreadable.
Tests: `worker-host.test.ts` (a worker that throws at load → 5 deaths → `down`
→ one report + the status file; the real worker reaches `ready`).

## What the watcher measures, on the row

Plan: `research/2026-09-17-global-machine-watcher-row-stats.md` (approved mock
proto-1789664064-nr56).

- **The worker writes `locks/sentinel/vitals.json` every tick** (after the
  latch work, write-then-rename; a failed write is a `log` frame, never a failed
  tick): each signal that can trip duress as `{value, limit}` — the readings
  through the detector's own exported `signalsAt`, the limits from the
  thresholds the worker holds — plus `elevated` (the closed `SignalKey` enum),
  `tripped`, `pid`, `wall`, `cadenceMs` and `{freeMemMb, inFlightBuilds,
  runningBackends}`. The worker writes it, not main, so a wedged main cannot
  make the row lie; a dead worker makes the file stop changing. Schema, reader
  and writer live in the `status-file` leaf.
- **Every backend serves it as `sentinel.vitals`** (the `sentinelVitals`
  `liveValue`, served external and pushed as `sentinelVitalsServed`): `none` |
  `unreadable` | `recorded {vitals, current}`, where `current` means the status
  newest status file names that pid as the live, running watcher. The one status watcher also
  watches the duress latch dir and routes each event by file name: `status.<pid>.json`
  → both resources, `vitals.json` → vitals only (so the status is not re-pushed
  every 5 s), `duress.latch` → status only.
- **`sentinel.status` carries the latch**: its value is `{watch, duress}`, with
  `duress: {since}` read by `readFreshDuress()` (unmemoized — a watcher woken by
  a latch change must not answer from `isUnderDuress()`'s memo). Running +
  duress turns the row a steady `attention` (not `critical`: red is kept for a
  broken watcher; under duress the watcher is working and already holding
  builds back): "Under duress since 6:02 PM · builds held back". The summary
  never subscribes to the 5 s vitals.
- **Web**: the row's `glance` (load per core · GB free · builds, plus a banner
  naming what tripped it or saying the numbers are old) and `component` (one
  line per signal with a bar and "X of LIMIT", amber from ⅔ of the limit, red at
  it; then "N worktrees running · Updated 3s ago") read `sentinel.vitals`, so
  only an open report receives it. A reading older than 3 ticks, or not
  `current`, greys out. The view model is pure: `web/internal/vitals-view.ts`.
- Tests: `status-file/server/internal/vitals-file.test.ts`,
  `server/internal/status-resource.test.ts` (current + routing),
  `web/__tests__/vitals-view.test.ts`, the duress branch in
  `machine-watcher-health.test.ts`, and the vitals assertions in
  `worker/latch-lapse.test.ts`.

## Each tick gathers

- **Host**: loadavg / cpu count, plus a `health-host.jsonl` tail line (30 s
  freshness guard; a `wallJumpMs`-stamped line reads null) for
  `decompressionsPerSec` / `compressorMb` / `freeMemMb` — the compressor
  memory signal (no second `vm_stat` spawn; the 10 s host sampler owns that).
- **Pg cluster**: ONE batched query on the dedicated client — active-backend
  `wait_event_type` counts, ungranted `pg_locks`, per-tick deltas of
  `sum(blk_read_time)` / `sum(xact_commit)`, and the cluster backend counts
  (contention's `datname IS NOT NULL` semantics).
- **Fleet**: `GET /gateway/worktrees` (gateway-served — wakes nothing) for
  running-backend count + active conns; one `ps -axo command=` spawn counting
  in-flight `singularity build/check/push` processes.
- **Backends**: every 3rd tick, a health.jsonl tail scan (fresh-mtime files
  only) → `backendP99` rollup per live backend.

Every sample is mirrored to main as a frame: `clusterClass.emit(...)` into the
**`cluster` trace ring** (`ring: { max: 720 }` ≈ 1 h) — the engine persists
the slice overlapping ANY trace's window, so every trace captured on main
carries a cluster-vitals lane for free — and the `onSentinelSample` listener
registry. postMessage buffers while main is wedged; samples carry their own
`wall`, so late delivery is harmless.

## Host-metric ownership (loadavg not shared)

The compressor/swap/freeMem signals are **single-sourced** from health-monitor's
persisted `health-host` file (`worker/sample.ts` tail-reads it under a 30 s
freshness guard — no second `vm_stat` spawn). **loadavg is not.** The worker
re-runs its own `os.loadavg()` syscall each tick rather than reading that
10 s-cadence file: a free syscall must not become a stale file read on the
latch-critical thread, since trip timing depends on it (the worker's isolation
premise). So loadavg is deliberately sampled in both the worker and
health-monitor's host sampler; only the expensive vm_stat read is deduped. See
`health-monitor`'s CLAUDE.md ("Host-metric ownership") for the owning half.

## The onset detector + duress latch (B4)

`server/internal/detector.ts` is the pure state machine (dual-threshold,
dual-dwell hysteresis; one trip event per episode; a null reading — blk-read
delta, pg-down locks, stale compressor line — is neither elevated nor
calm-blocking). Signals: load ratio, pg locks, blk-read delta, slow backends,
and `decompressionsPerSec ≥ onDecompressionsPerSec` (default 50 k/s — the
07-11 freezes ran 240k–442k/s; same latch, same hysteresis machinery, no new
mechanism). The worker feeds it per tick: on **trip**, `setDuress(reason)` +
a trip frame (main mirrors it into `captureTrace`); **every tripped tick**,
`refreshDuress()`; on **clear**, `clearDuress()` + a clear frame. Phase C's
shedding gates on that latch. **Max-episode-hold** (config, default 30 min)
force-clears and re-evaluates from a fresh detector so a mis-calibrated
threshold cannot latch the fleet indefinitely (the re-trip re-grants shed
first-N — a small persistence burst, accepted).

## Duress episodes channel (Stage 3)

The worker — the latch's sole writer — appends one line per transition to the
persisted **`duress-episodes`** log channel on main's log dir (boot-events
pattern: no DB table, survives re-forks, readable while wedged):
`{ atMs, kind: "trip"|"clear", reason, episodeSetAt }` (zod schema in
`core/episode.ts`). Every line carries `episodeSetAt`, so a clear line alone
fully determines its interval. `readDuressEpisodes(windowMs)` (server barrel)
is the timeline's read contract — bounded tail, safeParse-drop, `atMs`-window
filter. Latch adoption writes no trip line (the previous worker already did);
a lapse-clear has no line (accepted gap).

The deterministic 03:34 reproduction lives in `worker/latch-lapse.test.ts`: a
real Worker trips on injected `__sample` frames, the parent blocks itself with
`Atomics.wait` (no event loop — a wedged main), and the latch mtime must
advance during the block.

## Duress-episode report (WS3)

The report/bell half of the duress signal (the trip instant is already covered by
the `cluster-onset` critical trace + the timeline band). The worker's clear frame
is enriched with `{reason, elevated, episodeSetAt, wall, forced}`; `onset.ts`'s
`handleClearFrame` files **one `duress-episode` report per episode, on clear** via
`recordReport`. Fingerprint is the sorted **cause-signature** (`elevated`), NOT the
episode, so a storm collapses to counted rows. The kind is
**`duressExempt: true`** — it IS the durable record of the condition that drives
shedding, so it must never be shed (a re-trip racing the async record, or buffer
overflow at peak, would lose it — the same bar as `duress-shed`'s own summary
kind).

## Fleet flight windows (B5)

`server/internal/fleet-flights.ts` — an enrich-only event class that reacts to
`cluster-onset` triggers ONLY (undefined-skip on everything else). It fetches
`GET /gateway/worktrees`, filters `state === "running"` (**mandatory** —
proxying to a dormant backend cold-starts it, and spawning the fleet
mid-incident would amplify the incident), skips main itself (its flight window
is already the trace's `spans` section), and fans out to each backend's
`GET /api/debug/profiling/flight-window` under a 4-slot semaphore with a 3 s
per-backend abort — a wedged backend yields an `{ok:false}` cell, never a
stalled enrich. Cell payloads are validated loosely on purpose: fan-outs must
tolerate backends on older/newer profiler code.

## Config

`sentinelConfig` (`core/config.ts`, Settings → Config): `enabled` + `cadenceMs`
(restart to apply — the worker's interval is created at init), the B4 detector
thresholds (`on*`/`off*`, incl. `onDecompressionsPerSec` — live: main watches
the config and pushes threshold frames to the worker), and `maxEpisodeHoldMs`.
Defaults are educated guesses; calibrate against the replayed 2026-07-10
09:03–09:21Z burst and the 2026-07-11 freezes on the Timeline tab.

## Clock discipline

Ring `tMs` is profiler-clock (joins the containing snapshot's Gantt); each
sample carries its own `wall` (Date.now) as the cross-backend anchor.

## Web

Config registration, the `duress-episode` / `sentinel-down` report summaries,
and the Machine watcher health row with its stats (above). The `cluster` section currently renders through the
pane's `GenericEventLane` fallback; a dedicated `Trace.Lane`
(load-ratio/pg/builds sparklines) is a follow-up.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Sentinel web presence: registers the sentinel config (sampler cadence + onset thresholds) for Settings → Config, the one-line duress-episode and sentinel-down report summaries for Debug → Reports, and the health report's Machine watcher row (critical while main's watcher is down or its process is gone, attention while it restarts or the machine is under duress, read from the sentinel.status push resource), with its stats — load per core, free memory and builds at a glance, and each signal that can trip duress against its limit when expanded — read from the sentinel.vitals push resource. Cluster congestion sentinel: a main-only always-on sampler + onset detector + duress-latch lifecycle on a dedicated worker thread (host load, Postgres-side wait/lock/IO pressure, fleet state, per-backend health rollup, compressor pressure), feeding the 'cluster' trace ring so every trace gains a cluster-vitals lane, congestion onset is observable, and the latch lease survives a wedged main loop. Persists duress episodes as trip/clear lines on the duress-episodes channel (readDuressEpisodes). Reports the watcher's own supervision status: a host-global status file written on every transition, served on every backend as the sentinel.status push resource (with the duress latch), and a sentinel-down report when main gives up respawning it. Its worker writes the latest reading to a host-global vitals file every tick, served on every backend as the sentinel.vitals push resource.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "sentinel"
    - `Reports.KindView` → `DuressEpisodeSummary`
    - `Reports.KindView` → `SentinelDownSummary`
    - `HealthReport.Row` "Machine watcher" → `MachineWatcherDetail`
  - Uses:
    - `config_v2.ConfigV2`
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/clip.Clip`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/fill.Fill`
    - `primitives/css/inline.Inline`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/spacing.insetClass`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/live-state.ResourceErrorInline`
    - `primitives/loading.Loading`
    - `primitives/relative-time.useNow`
    - `reports.Reports`
    - `shell/health-report.HealthReport`
- Server:
  - Contributes:
    - `trace-event-class` "cluster"
    - `trace-event-class` "fleet-flights"
    - `report-kind` "duress-episode"
    - `report-kind` "sentinel-down"
    - `resource.declare` "sentinel.status"
    - `resource.declare` "sentinel.vitals"
    - `ConfigV2.Register` "sentinel"
  - Uses: 37 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/host/duress/latch` ×8
    - `debug/sentinel/status-file` ×7
    - `infra/spawn/daemon` ×5
    - `config_v2` ×3
    - `database/embedded` ×3
    - `primitives/log-channels` ×3
    - `debug/trace/engine` ×2
    - `infra/file-watcher` ×2
    - `reports` ×2
    - `infra/paths.isHostSingleton`
    - `network/live.serveValue`
  - Exports (values): `readDuressEpisodes`
  - Register:
    - `defineFileWatcher('sentinel.status')`
    - `defineDaemon('sentinel.worker')`
  - Resources:
    - `sentinel.status` (push, notified)
    - `sentinel.vitals` (push, notified)
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `debug/sentinel/status-file.SentinelDownStatusSchema`
    - `debug/sentinel/status-file.SentinelVitalsRecordSchema`
    - `debug/sentinel/status-file.SentinelWatchSchema`
    - `fields/bool/config.boolField`
    - `fields/float/config.floatField`
    - `fields/int/config.intField`
    - `network/live.liveValue`
  - Exports (types):
    - `ClusterSample`
    - `ClusterSection`
    - `DuressEpisodeEvent`
    - `DuressEpisodeReportPayload`
    - `SentinelDownPayload`
    - `SentinelStatusValue`
    - `SentinelVitals`
  - Exports (values):
    - `ClusterSampleSchema`
    - `ClusterSectionSchema`
    - `DURESS_EPISODES_CHANNEL`
    - `DuressEpisodeEventSchema`
    - `DuressEpisodeReportPayloadSchema`
    - `SENTINEL_DOWN_KIND`
    - `sentinelConfig`
    - `SentinelDownPayloadSchema`
    - `sentinelStatus`
    - `SentinelStatusValueSchema`
    - `sentinelVitals`
    - `SentinelVitalsSchema`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --space-md`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-semibold`
  - Imported by: `debug/timeline`
- Exemptions:
  - Exempts itself from: `detached-work-safety/no-raw-set-interval` — `server/internal/worker/entry.ts` (sanctioned)
- Sub-plugins:
  - **`status-file`** — The machine watcher's (cluster sentinel's) host-global status files (one per watcher host, the newest claim reported): their schemas, the writer main's watcher host uses, the per-tick vitals file…

<!-- AUTOGENERATED:END -->
