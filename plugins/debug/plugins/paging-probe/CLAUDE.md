# paging-probe

The **twin-probe discriminator** for the "main backend is the host's paging
victim" investigation
(`research/perfs/2026-07-16-main-paging-victim-investigation-PLAN.md` §A1).

During host memory pressure (compressor thrash: 240k–442k decompressions/s in
the live 07-10 / 07-11 freezes) main's event loop degrades to 0.3–5 s quanta and
the app freezes for minutes — while every *other* app on the machine stays
responsive. The suspected mechanism (a large cold heap macOS preferentially
compresses, then fault-storms on touch/GC over a single event loop) has been
corroborated live twice but never confirmed by a controlled discriminator. This
plugin builds that discriminator: three independent child processes with
**controlled heap shapes** sample their own event-loop lag on the same host at
the same time, so the *divergence* between them separates scheduling floor from
cold-page-fault victimhood.

## The three variants

One `server/internal/probe/entry.ts` entry, variant selected by argv, each spawned as its **own
child process** (a Worker would share main's address space and phys_footprint
ledger — it could never be an independent victim):

| Variant     | Heap                                  | Per-tick behavior                                          | Discriminates                                            |
| ----------- | ------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `lean`      | ~5 MB (nothing allocated)             | lag loop only                                              | scheduling floor — if `lean` is slow too, it's CPU not paging |
| `fat-idle`  | ~`fatSizeMb` mixed-entropy, touched resident once then left cold | lag loop only                            | mere residency vs. touch                                 |
| `fat-touch` | ~`fatSizeMb` mixed-entropy            | touches a random ~`touchSliceMb` slice (timed) each tick; timed `Bun.gc(true)` once/min | fault-storm on touch; **GC-over-cold-heap** (the suspected main mechanism) |

**Mixed entropy, not random pages.** Each 1 MB chunk is a single 4 KB
cryptographically-random block repeated to fill the chunk. Fully-random pages are
incompressible — macOS would *swap* them rather than *compress* them, which
weakens the very compressor-victim signal under test. A repeated random block is
non-trivial (not zero pages the kernel dedups) yet compresses ~4:1-ish, so it
lands in the compressor like a real cold heap.

## `lateByMs` — the headline signal

Each tick records `lateByMs = max(0, actual − expected)`, where `expected` is
**drift-free**: `firstTickAt + tickIndex * TICK_MS`, anchored to the first tick's
absolute time so a single slow tick cannot smear the schedule forward. A tick 3 s
late means the probe process itself was frozen 3 s — a fair twin to main's
event-loop stall. `eventLoopMaxMs` (the `monitorEventLoopDelay` histogram, which
accumulates in C even while JS is blocked) corroborates it. `fat-touch.touchMs`
and `gcMs` time the two suspected fault-storm triggers directly.

## Output & data join

Each probe appends one JSON line per tick to
`~/.singularity/worktrees/singularity/logs/paging-probe-<variant>.jsonl` (main's
log dir) via `appendFileSync` — no DB, no plugin runtime. The sample shape is
`ProbeSampleSchema` (`core/schema.ts`). There is no bespoke UI: analysis is a
**timestamp-window join** on `sampledAt` against the existing files — no new join
infra:

- `health.jsonl` — main's own `eventLoopMaxMs`, `physFootprintMb`, `residentMb`.
- `health-host.jsonl` — `decompressionsPerSec`, `compressorMb`, `freeMemMb` (the host pressure axis).
- `duress-episodes` — the sentinel's trip/clear intervals.

Confirmation (plan §A4): axis (a) is CONFIRMED if the `fat-*` probes' `lateByMs` /
`eventLoopMaxMs` spike in lockstep with `decompressionsPerSec` while `lean` stays
flat; GC-over-cold-heap is CONFIRMED if `gcMs` spikes to seconds under pressure.

## Config (`core/config.ts`, Settings → Config)

`enabled` (**default OFF** — the kill switch; the fat variants allocate real cold
heap), `fatSizeMb` (400), `touchSliceMb` (25), `gcEachMinute` (true), `boostQos`
(false — an optional boosted second axis). All take effect on the next main
restart: the supervisor reads them once at `onReady` and passes them as argv, so
there is no live re-tuning (a mid-run change would invalidate the measurement).

## Gating & supervision

`server/index.ts` starts the probes in `onReady` only when
`isMain() && !isRelease() && config.enabled`. Unlike the sentinel, it does **not**
run on compiled releases — a release is a shipped composition, not a diagnostics
host. `server/internal/probe-host.ts` supervises one child per variant, mirroring
`sentinel/server/internal/worker-host.ts`: capped exponential respawn backoff and
a rapid-failure give-up (5 deaths within 2 s of spawn → one loud line, no respawn
loop). The children are **default-QoS, not darwinbg-demoted** — the symptom under
test is that normal apps stay responsive, so the fair twin must be a normal app.

## Lean closure + copied FFI (load-bearing)

`server/internal/probe/entry.ts` imports **only** runtime builtins (`node:fs`, `node:perf_hooks`,
`node:crypto`, `bun:ffi`) plus its own zero-import `core/probe-logic.ts`. It must
never import `@plugins/*` or the plugin runtime — doing so would pull the whole
plugin graph into the probe's own heap and destroy the very footprint measurement
it exists to take. For the same reason the two native snippets it needs are
**copied, not imported**:

- `proc_pid_rusage` (reads `ri_phys_footprint` @72 and `ri_resident_size` @64) — a
  copy of `framework/plugins/server-core/bin/phys-footprint.ts`.
- `pthread_set_qos_class_self_np` (`--boost-qos`) — a copy of
  `packages/plugins/spawn-priority/server/internal/spawn-priority.ts`
  `boostInteractiveQos`. The parent cannot set a child's QoS, so the child boosts
  its own thread.

`core/probe-logic.ts` is the zero-dependency pure core (argv parsing, drift-free
tick arithmetic, the touch-slice picker) so those are unit-pinnable; `core/schema.ts`
also derives its `z.enum` from that file's `PROBE_VARIANTS` and pins the wire
schema bidirectionally against its `ProbeSample` type, so the probe's construction
type and the read schema cannot drift.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Paging-probe web presence: registers the twin-probe config (enable, fat heap size, touch slice, GC cadence, QoS boost) for Settings -> Config. Twin-probe paging-victim discriminator: three main-only child processes with controlled heap shapes (lean / fat-idle / fat-touch) measure event-loop lag under host memory pressure, so divergence between them separates scheduling from cold-page-fault mechanisms. Config-gated, OFF by default; writes paging-probe-<variant>.jsonl.
- Web:
  - Contributes: `ConfigV2.WebRegister` "paging-probe"
  - Uses: `config_v2.ConfigV2`
- Server:
  - Contributes: `ConfigV2.Register` "paging-probe"
  - Uses:
    - `config_v2.ConfigV2`
    - `config_v2.getConfig`
    - `infra/paths.isRelease`
    - `infra/paths.worktreeDataDir`
    - `infra/spawn/daemon.DaemonInstance`
    - `infra/spawn/daemon.defineDaemon`
    - `primitives/log-channels.defineLogSink`
  - Register: `defineDaemon('paging-probe.probe')`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields/bool/config.boolField`
    - `fields/int/config.intField`
  - Exports (types):
    - `ProbeSample`
    - `ProbeVariant`
  - Exports (values):
    - `pagingProbeConfig`
    - `PROBE_VARIANTS`
    - `ProbeSampleSchema`
- Exemptions:
  - Exempts itself from:
    - `detached-work-safety/no-raw-set-interval` — `server/internal/probe/entry.ts` (sanctioned)
    - `sink-safety/no-adhoc-file-sink` — `server/internal/probe/entry.ts` (sanctioned)
    - `boundaries/no-platform-api` — `server/internal/probe-host.ts`, `server/internal/probe/entry.ts` (debt)

<!-- AUTOGENERATED:END -->
