# health-monitor

The continuous per-backend health sampler (event-loop lag, GC/heap pressure,
footprint → `health.jsonl`), surfaced as **Debug → Health**.

## Host-metric ownership

health-monitor's **host** sampler (`host-sampler.ts`, 10 s cadence → the
persisted `health-host` channel) is the **single source** for the vm_stat host
series — compressor decompressions/sec, compressor MB, swap, and free memory.
The sentinel worker does **not** re-run `vm_stat`; it tail-reads this file (with
a 30 s freshness guard) for those signals. So compressor/swap/freeMem are
single-sourced here.

**loadavg is the deliberate exception.** `os.loadavg()` is a free syscall, and
the sentinel worker keeps its **own** call on its latch-critical thread rather
than reading this 10 s-stale file — trip timing must not depend on a stale host
sample (the worker's isolation premise). So loadavg is intentionally sampled in
both places; only the expensive vm_stat read is shared. See `sentinel`'s
CLAUDE.md for the mirror.

## Monitoring self-cost (`monitorOps` / `monitorMs`)

Each tick also diffs the runtime profiler's cumulative monitoring self-meter
(`getSelfMeter()` — wall-clock of every outermost `runWithoutProfiling` scope;
see `infra/runtime-profiler`'s CLAUDE.md) into the sample's per-tick
`monitorOps` / `monitorMs` deltas. Everything suppressed is by definition the
observability subsystem's own work, invisible to the profiler by design — these
two fields are its only visibility, so a monitoring storm reads as a spike on
the Health pane's "Monitoring self-cost" chart. The fields are optional in
`HealthSampleSchema` so pre-cutover JSONL lines still parse (no history gap).

## Machine sleep (`wallJumpMs`)

Both samplers detect a wall-clock jump at the source (`wall-jump.ts`): a tick
firing more than `SLEEP_JUMP_FACTOR` (5×) its cadence after the previous one
spanned a suspend. The process sampler **resets the loop-lag histogram before
reading it** on such a tick — the histogram accumulated the sleep itself
(huge `eventLoopMaxMs`, calm p50: a fake incident on every consumer, and a
fake `stall` trace) — and stamps the sample with the gap as optional
`wallJumpMs`. The host sampler stamps too, and always divides its vm_stat
counter deltas by the **true elapsed window** rather than the nominal cadence,
so a late tick can never fabricate a rate spike. Consumers treat a stamped
sample as "no measurement this window"; the timeline renders the preceding
gap as a labeled dark "sleep" segment. A merely-late tick from a wedged loop
stays below the jump factor and keeps its stall evidence. (See
`research/2026-07-11-global-observability-freeze-blind-spots.md`, Stage 6.)

## Stall stacks → the trace store

On **main**, the sampler also claims the background-thread JSC sampling profiler
(`claimStackSampler("health-monitor")` from `infra/stack-sampler`, the
profiler's one owner per process, which holds every bun:jsc fact) and drains it
every tick. When a tick's `eventLoopMaxMs > 3 s` (a frozen backend), it
aggregates the drained stacks into a `topLeaves`/`topStacks` histogram and hands
the section to `debug/stall-monitor` via `recordEventLoopStall(...)`. The sampler
only **detects + aggregates**; `stall-monitor` **captures the trace and files the
alert report** — so the "what code froze the loop" evidence lands in the durable
trace store (**Debug → Slow Events**, rendered by the `trace/plugins/stall` event
class) *and* the stall reaches the bell + **Debug → Reports** as a deduped
`event-loop-stall` report linked to its trace. (It used to be dumped to a
dead-end `stall-profiles.jsonl` that nothing read.) The Health pane still shows
*that* a stall happened via the `eventLoopMaxMs` spike line; the trace + report
answer *why*. See `server/internal/stall-profiler.ts`.

**`topStacks` carries its own `frames`.** Each stack bucket ships, alongside its
name-only `stack` signature, the resolved `frameKey` identities of the same
frames (the primitive's `frameKey`, with paths made cwd-relative — the
`name @ path:line` / `name [category]` form `topLeaves[].key` uses),
taken from the first trace seen with that signature. **Invariant** (by
construction in `aggregateTraces`, asserted in its tests): `frames[i]` is the
frameKey of the frame whose bare name is `stack.split(" ← ")[i]` — same slice,
same order, same 40-frame cap. So `frames[0]` is always that stack's own leaf
key — the very key that trace contributed to the `topLeaves` tally (though not
necessarily one that survived into the top-15 slice).

They are **one representative sample's** keys, not a canonical position for the
path: `frame.line` is the sample's executing line, so traces sharing a name-only
signature can resolve differently (the Jul-16 evidence has both
`is @ …/entity.js:7` and `is @ …/entity.js:18` for the same `is`). Read `frames`
as *a* position on the call path, not *the* position — enough to attribute the
path to a subsystem, which is all the label needs.

This exists because `topLeaves` and `topStacks` are otherwise two *independent*
histograms: a consumer labelling the stall from `topLeaves` may name a different
stall than the one `topStacks[0]` fingerprints. That really happened — a
`spawn`-rooted freeze (7/15 samples) was reported titled with a 1-sample drizzle
frame. `stall-monitor` now derives its label from the dominant stack's own
frames; this sampler's job is to not throw the association away.

**Arming policy** (congestion-observability plan, Phase B): **main** arms at
boot — always-on for the UX-critical backend. **Worktree backends**
arm-on-elevated: unarmed (zero sampler cost) until one of their own ticks
observes `eventLoopP99Ms > 200` or `eventLoopMaxMs > 1000` (`STALL_ARM_*`
constants), then armed for the rest of the process — `bun:jsc` has no stop, so
arming is a one-way latch. The trade, recorded: the *first* stall of a
previously-healthy worktree backend is missed (arming happens on the elevated
tick after it); stalls under sustained congestion recur and carry evidence from
then on. An armed profiler costs a ~230 Hz separate-thread stack sampler —
measured overhead on a real worktree workload is still an open task.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Health monitor debug pane: per-backend event-loop lag, phys_footprint/heap, and GC pressure over time, plus host load/memory/swap. Continuous per-backend health sampler: event-loop lag, GC/heap pressure, and phys_footprint appended to per-worktree JSONL (read from disk even when a backend is wedged), plus main-only host metrics. Surfaced as the Debug → Health pane.
- Web:
  - Slots: `healthMonitorPane.Actions`
  - Slot contributors: `healthMonitorPane.Actions` ← `primitives.pane`
  - Contributes:
    - `Pane.Register` "debug-health-monitor"
    - `DebugApp.Sidebar` "Health"
  - Uses: 24 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `stats/commits` ×7
    - `primitives/pane` ×3
    - `primitives/css/spacing` ×2
    - `primitives/css/text` ×2
    - `apps/debug/shell.DebugApp`
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/fill.Fill`
    - `primitives/css/grid.Grid`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/rigid.Rigid`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/live-state.ResourceErrorInline`
    - `primitives/relative-time.RelativeTime`
  - Exports (values): `healthMonitorPane`
- Server:
  - Contributes: `resource.declare` "health-monitor.series"
  - Uses:
    - `debug/slow-ops.readSlowOpMarkers`
    - `debug/stall-monitor.recordEventLoopStall`
    - `infra/background/timer.defineTimer`
    - `infra/file-watcher.acquireDirWatch`
    - `infra/host/host-read-pool.heavyReadQueueDepth`
    - `infra/host/machine-sleep.publishSleepReading`
    - `infra/paths.listWorktreeDirsAsync`
    - `infra/paths.worktreeDataDir`
    - `infra/paths.worktreesDir`
    - `network/live.serveValue`
    - `primitives/log-channels.defineLogSink`
    - `primitives/log-channels/log-files.readChannelJsonAsync`
  - Exports (types):
    - `HealthSample`
    - `HealthSampleObserver`
    - `HostSample`
    - `HostSampleObserver`
    - `StackSampleObserver`
  - Exports (values):
    - `HealthSampleSchema`
    - `HostSampleSchema`
    - `onHealthSample`
    - `onHostSample`
    - `onStackSamples`
  - Register:
    - `defineTimer('health.process-sampler')`
    - `defineTimer('health.host-sampler')`
  - Resources: `health-monitor.series` (push, notified)
- Core:
  - Uses: `debug/slow-ops.SlowOpMarkerSchema`
  - Exports (types):
    - `HealthData`
    - `HealthSample`
    - `HealthSeries`
    - `HostSample`
  - Exports (values):
    - `HealthDataSchema`
    - `HealthSampleSchema`
    - `HealthSeriesSchema`
    - `HostSampleSchema`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `debug/latency-ledger`
    - `debug/timeline`
- Exemptions:
  - Exempts itself from:
    - `timer/no-unlisted-timer` — `server/internal/process-sampler.ts`, `server/internal/host-sampler.ts` (sanctioned)
    - `boundaries/no-platform-api` — `server/internal/health-series.ts`, `server/internal/host-sampler.ts`, `server/internal/process-sampler.ts` (debt)
- Shared:
  - Exports (values): `healthMonitorSeries`

<!-- AUTOGENERATED:END -->
