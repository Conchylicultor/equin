# Slow-op reports judge an op on its OWN time

Task: task-1793316419-rup28z (from the 2026-10-29 audit of main's slow-op reports).

## Context

Every slow-op is judged on wall time, so time the op spent **not working** is
reported as the op being slow:

| Case | Where | What is counted that isn't the op |
|---|---|---|
| server `sub` (and every non-`job` span) | `slow-ops/server/internal/resolve-threshold.ts:52` `slowSpanMs` | named gate waits (`read-admit` ≈ 85% of a `sub` on average; `config-v2.values` 7.7e9 of 9e9 ms) |
| client `update` | `live-state/web/notifications-client.ts` `reportUpdateLatency`; `resource-runtime/core/runtime.ts` `frameTiming` | the resource's own declared `throttleMs` hold (`queue-health.pulse` throttles 1000 ms = the 1000 ms bar → ~1002 ms × 33k samples; `automations.catalog`, part of `conversations.context-usage`) |
| client `update` / `element` | `notifications-client.ts` `isHiddenSince`; `use-resource.ts` `reportTupleSettled`; `slow-ops/web/internal/element-slow-op.ts` | a frozen main thread (`update tasks` 69 s inside a 273 s stall already filed by main-thread-stall), machine sleep; `element` doesn't even exclude a hidden tab |
| warm-up | `infra/warmup/server/internal/executor.ts:75-86` | the heavy-read slot wait (the `warmup:` span, the `bg` span and `onRun.durationMs` all start before `withSlot`) |
| server spans | profiler clock | machine sleep (max `sub` ≈ 20,059 s) |

**Goal:** a slow-op report names an op that was itself slow. Time that isn't the
op's is never dropped silently. It is either **not system time** (sleep, a
hidden or frozen page, a stall filed as its own report), which is subtracted,
or it is **someone else's time** (a gate's queue, a declared hold), which is
subtracted from this op and charged to the thing that owns it.

## The rule: one quantity and one place

`job` is the only kind judged on work time today (`slowSpanMs`). Make that the
rule for **every** item, server and client, in one function:

```
ownMs = durationMs − union(excluded intervals)      // ≥ 0 by construction
slow  ⇔ ownMs > thresholdMs
```

Each excluded layer has a **class** (closed data in `slow-ops/core`, a `Record`
over the union so a new class won't compile without a rule):

| class | layers | treatment |
|---|---|---|
| `gate-wait` | every profiler `chargeWait` layer (`read-admit`, `read-coalesce`, `db-acquire`, `heavy-read-*`, `background-tx-acquire`, …), `notifications-transport` (element cold-start) | subtracted. The gate files its own `wait` slow-op (below). |
| `declared-hold` | `throttle-hold` (update) | subtracted. The declaring resource asked for it, so nobody gets charged. (The sibling task task-1793316430-dqjpnh owns declared budgets in general and boot-budget, so this only covers the throttle.) |
| `not-running` | `sleep`, `page-hidden`, `page-frozen`, `main-thread-stall` | subtracted. A sample that overlaps `page-hidden` is still dropped outright (today's rule), because throttled timers distort every layer, not just the hidden span. |

The excluded layers ride in the item's `waits`, so the row and the detail
still show the full wall-time split. The report text (`describeWaits`) says
"own 120 ms of 9.0 s; 7.7 s read-admit (excluded)".

Storage: add `own_total_ms` / `own_max_ms` to `slow_ops` (migration via
`./equin build`). The pane ranks by own total. Wall `durationMs` stays, so
history stays comparable.

## Pieces

### 1. Server spans: judge every kind on work time

- `resolve-threshold.ts`: `slowSpanMs(span) = durationMs − waitMs` for every
  kind (the job doc block becomes the general rationale). `perfFloorMs` stays
  sound (work ≤ wall).
- `install-slow-span.ts`: the item gets `ownMs`. The trace still captures the
  wall duration.
- **The gate is the slow op (charged where the wait happens).** The runtime
  profiler gets `onSlowWait(handler, { thresholdMs })`, fired from
  `chargeWait(layer, ms)` (`runtime-profiler/core/recorder.ts:1351`), which is
  the one call site per real wait. Firing there avoids the duplicate you'd get
  from reading `span.waits`, since waits propagate to every ancestor. slow-ops
  subscribes and records `operationKind: "wait"`, `operation: <layer>`,
  `caller: currentEntryLabel()`, with a threshold of `loaderMs`. The result is
  ONE deduped report per congested gate (`slow-op:wait:read-admit`), with every
  waiter in `slow_op_callers` and a trace whose flight window shows gate
  occupancy. This replaces N reports blaming N innocent resources with one
  report that names the gate. It also helps the sibling task
  "one cause filed as many reports".

### 2. Client `update`: the throttle hold is its own phase

- `resource-runtime`: stamp when a throttled entry's window releases
  (`entry.debounceReleasedAt`, set where `debounceDue = true`, both the
  leading edge and the timer, `armFlush` ~4945). `frameTiming` adds
  `holdMs = max(0, releasedAt − pending.enqueuedAt)` for a debounced entry and 0
  otherwise. `deliverMs` stays first-notify → send, so the hold sits inside it.
- `resource-protocol`: add `holdMs` to `timing`, and bump `PROTOCOL`.
- `latency-signal`: the `update` phases become `server-notice · throttle-hold ·
  server-deliver · transport · client-apply`
  (`server-deliver = deliverMs − holdMs`). Phase classes are declared next to
  the tuple in `CLIENT_LATENCY_SIGNALS`, so a consumer reads them generically
  and never names `throttle-hold`.
- `latency-ledger` (the other consumer) reads phases generically. Check that
  its calm-p95 baseline doesn't shift unexpectedly, and update the CLAUDE.md
  table.

### 3. Client: paused-page time is subtracted by the consumer

Producers today must each remember to compute `hidden`, and `element` forgot.
The structural fix is that **producers stamp a window, and the consumer derives
everything about pauses from it**:

- `ClientLatencySample` and `SlowResourceInfo` carry
  `window: { startEpochMs, endEpochMs }`. `update` already has `changedAt` →
  `appliedAt`. `element` converts `startedAt` through `performance.timeOrigin`.
  `hidden` is removed from the sample (tsc finds every producer and consumer).
- New leaf `primitives/perfs/plugins/page-pauses` (web):
  `pausesDuring(start, end) → { hidden: boolean, frozenMs, stalledMs }` over
  bounded rings fed by `visibilitychange`, Page Lifecycle `freeze`/`resume`,
  and a `PerformanceObserver` on `long-animation-frame` (≥ 200 ms; `longtask`
  as the fallback; unsupported means 0, documented as "cannot tell"). It is
  mounted once at boot. main-thread-stall's `tab-watch` already observes LoAF
  and can move onto it later (not in scope).
- `slow-ops/web`: `latencySlowOp` / `elementSlowOp` keep the window. **The
  pause split is computed in the queue at flush time** (`slow-op-queue.ts`,
  250 ms after the emit) because a LoAF entry is delivered after the frame it
  describes. At flush, `hidden` drops the item. Otherwise `page-frozen` and
  `main-thread-stall` (intersected with the window) are added to `waits`, the
  item is re-judged on `ownMs`, and items under the bar are dropped. The `update
  tasks 69 s` case becomes ~0 own ms, and the stall is already its own
  `main-thread-stall` report.
- `element`'s transport bring-up (`notifications-transport`) becomes a
  `gate-wait`: subtracted from the resource, and filed once per page boot as
  `wait notifications-transport` when it crosses `elementMs` (emitted by the
  collector from `NotificationsClient.getFirstReadyAt()`). **This revises the
  CLAUDE.md "Cold-start slowness is UX truth — don't suppress it" section.**
  The slowness stays loud, but on the op that owns it (the transport/boot), not
  on whichever resource happened to mount. The section gets rewritten to say
  exactly that.

### 4. Sleep: subtracted on the server, for every item

There is one machine and one instance per user, so the server can read the
real sleep clock for client items too:

- `infra/host/machine-sleep/server`: keep a bounded ring of sleep intervals
  (`[wakeAtMs − slept, wakeAtMs]`) folded from each reading, and export
  `sleptDuring(startEpochMs, endEpochMs)`. It re-reads `readSleepClock()` on
  call, so a wake seconds ago counts. Several naps between two readings are
  placed as one interval ending at the last wake: conservative, documented.
- `recordSlowOpBatch` (the one funnel): every item carries `endedAtMs` (client
  items send their window; server spans use `Date.now()` at the hook). The
  overlap is added as `waits.sleep` (`not-running`), and the item is re-judged
  and dropped under the bar. Doing it in the funnel means server and client
  share one rule.
- **Step 0 (verify before building):** does the profiler clock
  (`performance.now()` in Bun on darwin) keep running through sleep? The
  ~20,059 s `sub` max suggests yes. Check it with `createSleepMeter` around a
  `pmset sleepnow`, or from health-monitor samples whose `sleptMs` > 0. If it
  pauses, server spans skip the subtraction (one flag beside `slowSpanMs`, with
  the measurement cited), and the 20,059 s spans become their own finding,
  filed as a task: a span that really ran 5.5 h.

### 5. Warm-up: the span starts when the slot is granted

`executor.ts`: `profilerStart`, `t0`/`startedAt` and `onRun("running")` move
inside the `withSlot` callback. `runTracked` stays outside, so `heavy-read-*`
waits still charge to it, and piece 1 subtracts them. The boot Gantt then shows
the run, and the boot-budget monitor's `durationMs` is the run. Covered by
`drain.test.ts`: a slot that grants after X ms gives a duration that excludes
X.

## Files (representative)

- `plugins/debug/plugins/slow-ops/{core/config.ts, server/internal/resolve-threshold.ts, install-slow-span.ts, record-slow-op.ts, fold-batch.ts, merge-sql.ts, tables.ts, wait-layers.ts, shared/endpoints.ts, web/internal/*.ts, web/components/slow-op-collector.tsx, CLAUDE.md}`
- `plugins/infra/plugins/runtime-profiler/core/recorder.ts` (`onSlowWait`)
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` (`holdMs`), `plugins/packages/plugins/resource-protocol` (`timing.holdMs`, PROTOCOL)
- `plugins/primitives/plugins/perfs/plugins/latency-signal/core/internal/signals.ts` (phase classes, `window`, drop `hidden`)
- `plugins/primitives/plugins/live-state/web/{notifications-client.ts, use-resource.ts, slow-resource-reporter.ts}`
- new `plugins/primitives/plugins/perfs/plugins/page-pauses/web`
- `plugins/infra/plugins/host/plugins/machine-sleep/server` (`sleptDuring`)
- `plugins/infra/plugins/warmup/server/internal/executor.ts`

## Verification

- Unit (`./equin test`):
  - `resolve-threshold`: a `sub` with 7.7 s `read-admit` of 9 s is not slow, and
    `onSlowWait` fires once per wait.
  - `runtime-throttle.test.ts`: a held pending's `timing.holdMs` ≈ the window
    remainder, and 0 at the leading edge.
  - `latency-slow-op` / `element-slow-op`: a window overlapping a hidden
    interval is dropped, and a stall is subtracted.
  - `page-pauses` ring.
  - `sleptDuring` overlap math.
  - `fold-batch` / `record-slow-op` own-time columns, SQL merge = pure merge.
  - Warm-up `drain.test.ts`.
- `./equin check` (PROTOCOL bump, plugin docs, migrations).
- Live, after `./equin build`:
  - Debug → Slow Events on my build shows no `update queue-health.pulse` row.
  - Freezing a tab with `plugins/reports/plugins/main-thread-stall/e2e/freeze.ts`
    produces a `main-thread-stall` report and no `update`/`element` row for the
    frozen window.
  - A burst of `sub`s past 6 concurrent produces one `wait read-admit` row
    with callers.
  - `query_db` on `slow_ops` shows `own_*` columns populated.
- After landing: re-run the audit query on main's `slow_ops` a day later. The
  rows the audit listed should be gone or reduced to their own time.

## Outcome (implemented 2026-10-30)

**Step 0 answer: Bun's `performance.now()` pauses while macOS sleeps.**

- Measured on main's `traces` table, where each row stamps both wall time and
  `atMs`. A backend booted 2026-10-29 16:48 stamped `atMs` ≈ 1,956 s at
  22:12. That is 17,445 s short of wall time, matching the sleep from 18:02
  (`pmset -g log`).
- So server spans need no sleep subtraction. The ~20,059 s `sub` spans really
  were open ~5.5 h awake. Filed as a sidequest: task-1793365699-xgweva.
- Sleep subtraction applies to client items only, which are timed on the wall
  clock. It happens in the client handler (`withoutSleep`) through
  machine-sleep's new `sleptDuring`.

**Changes from the plan:**

- **No own-time columns.**
  - Every item carries `ownMs`, and the funnel drops an item under its bar.
  - Excluded time stays in `waits`, and the list already derives a Wait
    column from that.
  - The report payload carries `ownMs` (jsonb, no migration) for its title and
    message.
  - This avoids a migration and a second ranking column for the same answer.
- **`chargeWait` takes a required `kind`** (`queue` | `join`).
  - Only a queue wait names a congested gate.
  - A join (`read-coalesce`, `*-coalesce`, `endpoint-dedupe`) is the time of
    the run it joined, and that run reports itself.
  - Being required, tsc made every call site choose.
- **`page-pauses` replaced three hidden trackers.**
  - The trackers were `network/live`'s `tab-hidden.ts` (also used by
    optimistic-mutation) and `notifications-client`'s `lastHiddenAt`.
  - `ClientLatencySample` no longer has `hidden`.
  - Consumers (slow-ops, latency-ledger) ask page-pauses over
    `[emit − totalMs, emit]`.
- **`HELD_PHASES` / `ownMsOf`** in latency-signal declare the held phases
  generically, so slow-ops never names `throttle-hold`.
- **Transport bring-up** is filed once per page by the collector as
  `wait notifications-transport`. Its duration is `firstReadyAt` (page start
  → socket open), carried as the new `SlowResourceInfo.transportReadyAtMs`.
