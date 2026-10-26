# Main stopped pushing for 7 min: a stranded flush request (investigation + plan)

## Context

On 2026-10-26, from about 17:23 to 17:30:41 (CET, i.e. UTC+1: 16:23–16:30 UTC), the main backend
(`singularity`) sent no live-state update frames to any tab. Subscribe replies kept working, the
WebSocket stayed open, event-loop p99 stayed at 1–2 ms and graphile jobs kept completing. It
recovered only when the backend restarted. Nothing alerted.

Goal: find the root cause and make this class of wedge impossible, or at least loud.

## What the evidence rules out

| Evidence | Source | Rules out |
|---|---|---|
| Sentinel trace `b2c0a949` (16:26:30 UTC, main's own process, ~9 min after its 17:17:26 boot): **`open: []`**, and every gate is at `active 0, queued 0` (`background-acquire`, `background-tx-acquire`, `db-pool`, `push-acquire`, …) | `traces.snapshot->events` | **A flush stuck on a loader** (the 2026-09-11 mechanism). `wrapFlush` runs the whole hold inside `recordEntrySpan("flush")`, which registers in `openEntries` until its `finally`. No open flush means no flush was holding the mutex. It also rules out a leaked lane-gate slot. |
| Same trace: 84 completed spans in the 75 s ring window, all `bg`/`job`. **Zero `flush`, `push`, `loader`.** In normal operation, the 16:21:59 trace shows 10 flushes and 244 pushes in 5 s. | same | Flushes still running but failing to deliver. Flushes stopped being **invoked** at all. |
| Job completions per minute and their durations were normal through the window. Jobs' DB queries go through the background query gate. | `~/.singularity/logs/gateway/singularity.log` | A wedged background DB lane |
| No `tasks` chain was created in the window, and no `withNotifyBatch` caller (create-chain, MCP rewire) was open: they run inside HTTP spans, and the open list was empty. | `tasks`, trace | `batchDepth` stuck above 0 |
| The pg `DeprecationWarning` occurs 63× in the log, each time under a different short-lived pid (child processes). | gateway log | It is unrelated (red herring). |
| No `server-unhandled` report anywhere near the window | `reports` | A flush pass that threw |

So no flush was running and no new flush was being scheduled, while notifies kept arriving. That
includes in-process ones like `sentinel.vitals`. Only one piece of state can do that.

## Root cause: `flushScheduled` stranded `true` (a race present since 2026-06-08)

`plugins/framework/plugins/resource-runtime/core/runtime.ts`:

```ts
function scheduleFlush() {              // ~4768
  if (flushScheduled) return;           // ← every later notify stops here
  flushScheduled = true;
  queueMicrotask(() => void flushNotifies());
}
async function flushNotifies() {        // ~5336
  if (flushRunning) { flushAgain = true; return; }
  flushRunning = true;
  try { await opts.wrapFlush(runFlushCycle); }   // recordEntrySpan: async, own await + finally
  finally { flushRunning = false; flushPassStartedAt = null; }
}
async function runFlushCycle() {
  do { flushAgain = false; flushScheduled = false; …levels… } while (flushAgain);  // last check HERE
}
```

The last check of `flushAgain` happens inside `runFlushCycle`. The mutex is released **several
microtask hops later**: `recordEntrySpan`'s `await` resumes, its `finally` runs, and then
`flushNotifies`' `await` resumes. A notify that lands in that gap goes through these steps:

1. `scheduleFlush` sees `flushScheduled === false` (the last pass reset it), sets it `true`, and
   queues a `flushNotifies` microtask.
2. That microtask runs before `flushNotifies`' continuation. `flushRunning` is still `true`, so it
   sets `flushAgain = true` and returns.
3. The outer `finally` sets `flushRunning = false`. No loop is left to look at `flushAgain`.
4. Final state: `flushScheduled = true`, nothing queued, nothing running. Every later
   `scheduleFlush()` returns at its first line, for every resource, until the process restarts.

Every symptom follows from this:

- Global: every key stops, DB-backed and in-process alike, because `armFlush` → `scheduleFlush` is
  the only path.
- Silent: no span stays open, so `flushOpenMs` stays 0 and the health row stays green. No slow-op is
  recorded, because there is no operation. The client watchdog sees a healthy, quiet socket.
- Subscribe and refresh still work, because sub-ack loads do not go through `scheduleFlush`.
- Only a restart clears it.

The gap needs a notify-producing microtask in the same microtask drain as the final pass's
`Promise.all` resolution. One example is a continuation that shares an `inflight` flight or a DB
result with the last drain. So it is rare, but main runs about 1000 flushes per 5 min, and each
occurrence is permanent.

**Confidence:** the race is proven by reading the code, and step 1 of the plan reproduces it
deterministically. Matching *this* incident to it is by elimination: it is the only mechanism
consistent with "no open flush, no flush completions, notifies arriving". The process state is gone,
so there is no direct capture.

## Outcome (2026-10-26, evening)

- **Step 1 landed.** `flushState` replaces the three booleans; `runtime-flush-state.test.ts`
  failed on the old code (the notify in the wrapper's unwind was never delivered) and passes on
  the new.
- **Confirmed live at head.** Main booted at 18:40:50 and stopped flushing at about 18:42:38. The
  `flushNotifies` count stayed frozen across samples, while jobs kept running and the health row
  read "live updates stuck". Main's 18:45:00 traces showed **zero open spans**, so neither a hung
  pass nor a held batch: `POST /api/tasks/chain`, which opens a batch, runs inside an HTTP span.
  This is exactly the stranded-request signature.
- **Step 2 mostly landed separately** in `9fef500510`, from another conversation. The ping carries
  `pushStallMs` (the older of the open pass's start and the oldest queued pending's `enqueuedAt`).
  The Connection row flags ≥ 30 s, and the client wedge watchdog files a `live-state-wedge`
  `push-stall` report. That commit blamed the freeze on a held `withNotifyBatch`; its detector
  covers that case and this one, and the docs now name both. Still open from step 2: a
  server-side report whose payload names the flush state, the batch depth and the open spans.

## Plan

### 1. Make the stranded state unrepresentable (rung 1). `resource-runtime/core/runtime.ts`

Replace the three booleans `flushScheduled`, `flushRunning` and `flushAgain` with **one** state
variable whose transitions are all synchronous:

```ts
type FlushState = "idle" | "queued" | "running" | "rerun";
```

- `scheduleFlush()`:
  - `idle` → `queued`, and queue the microtask.
  - `running` → `rerun`.
  - `queued` / `rerun` → no-op.
- Microtask: `queued` → `running`, then run the loop.
- The loop lives in `flushNotifies`, **outside** the wrapper. One `wrapFlush(runPass)` call per pass:

  ```ts
  for (;;) {
    flushPassStartedAt = performance.now();
    await wrapFlush(runPass);
    if (state === "rerun") { state = "running"; continue; }
    state = "idle"; break;   // same synchronous segment as the check — no gap
  }
  ```

- On a throw (in `finally`): `rerun` re-queues (`queued` + microtask), anything else goes to
  `idle`, and the error is rethrown so it stays a loud unhandled rejection.

Invariant, by construction: `queued` ⇒ a microtask is pending, and `running`/`rerun` ⇒ a live loop
will look at the state again. No value can mean "requested, but nobody will act".

Side effect: the `flush` span becomes per-pass instead of per-hold. That matches what `flushOpenMs`
already measures. The op-rate `flush flushNotifies` rate counts passes, and its threshold in
`plugins/debug/plugins/op-rate` gets re-checked.

Update the *Flush is level-parallel* paragraph in `resource-runtime/CLAUDE.md`: mutex + rerun is now
one state machine, and the loop and the release share one synchronous segment.

### 2. Make any remaining push wedge loud (rung 4). Measure the outcome, not one mechanism

`flushOpenMs` only catches the stuck-loader mechanism. This incident had `flushOpenMs = 0`. The
signal every wedge shares is **pending work that does not drain**, whatever the cause: a stuck
loader, a stuck `withNotifyBatch`, a future scheduling bug, a lost debounce timer.

- In the runtime, add `pushBacklogMs()` = the max over entries of `now − min(pending.enqueuedAt)`,
  minus that entry's `debounceMs` (a throttled hold is not a stall). `PendingNotify.enqueuedAt`
  already exists (~1045). Include `pendingAcks`. It is computed at most once per heartbeat tick
  (memoized), so it adds no new timer.
- Add it to the heartbeat ping as `pushBacklogMs`, next to `flushOpenMs`. Declare the field in
  `plugins/packages/plugins/resource-protocol/core/internal/frames.ts`. The client records it like
  `flushOpenMs` (`notifications-client.ts` `noteServerFlushOpenMs`, generalized). The health
  Connection row (`plugins/infra/plugins/health/web/internal/connection-health.ts`, today
  `FLUSH_STALL_MS`) goes critical on either value ≥ 30 s.
- Server-side report, so a stall reaches the bell even when nobody is looking at the dot:
  - A new optional runtime hook `onPushStall(info)`, fired edge-triggered: once when the backlog
    crosses the threshold, again on clear, re-alerting at most every 10 min.
  - `info` carries what makes the next one provable: flush state, `flushOpenMs`, `batchDepth`, the
    oldest pending keys with their ages, and how many entries are pending.
  - server-core (`plugins/framework/plugins/server-core/core/resources.ts`, next to `reportError`)
    binds it to a `defineReportSink` (`@plugins/primitives/plugins/report-sink/core`, the same seam
    as `queryDeadlineSink`).
  - A reports sub-plugin interprets it as kind `live-push-stalled`: `duressExempt: true` (the
    second half of this incident was inside a duress window, which sheds reports) and
    `variant: "error"`. It attaches `captureFlightWindow` (runtime-profiler) and `readGateGauges()`,
    so the report names whatever was open.
  - Central passes no hook, so it degrades to a no-op, as with the other hooks.
- Evaluation runs off the existing per-socket heartbeat tick (no new `setInterval`), deduped
  runtime-wide per tick. With no sockets there is nobody to push to, so nothing to report.

### 3. Tests (`./equin test plugins/framework/plugins/resource-runtime`)

- Regression, in `runtime.test.ts` §flushNotifies:
  - A `wrapFlush` that awaits `fn()` and then, still inside the wrapper, calls `notify()` on a
    second resource, then yields a microtask.
  - Assert the second resource's frame is delivered.
  - Run it against the current code first: it must fail and leave the runtime wedged for later
    notifies too. Then it must pass after step 1.
- Fuzz: random notifies interleaved with 0–5 microtask yields around pass boundaries. Every notify
  must eventually deliver, and the state must end at `idle`.
- Throw path: a pass that throws while `rerun` is set re-queues, and the next notify still delivers.
- Backlog, in `runtime-heartbeat.test.ts`:
  - A never-settling loader: `pushBacklogMs` grows and `onPushStall` fires once.
  - A held `withNotifyBatch`: same.
  - A throttled entry inside its window: no report.
- Client: `notifications-heartbeat.test.ts` and `connection-health.test.ts` extended for
  `pushBacklogMs`.

### Verification end-to-end

1. Write the regression test, see it fail on the current code, apply step 1, see it pass.
2. `./equin build`, then open `http://<worktree>.localhost:9000`. Drive a conversation and confirm
   pushes still flow (the `flush` / `push` aggregates appear in `get_runtime_profile`).
3. Temporarily stall a loader with a test-only resource in the worktree. Check that the Connection
   row goes critical within 30 s, and that a `live-push-stalled` report with the diagnostic payload
   lands in Debug → Reports.

## Out of scope (follow-ups)

- Isolating a single stuck drain so it stops blocking the rest of the flush (a per-entry deadline at
  the level barrier). That is the 09-11 mechanism, now made visible by step 2 but not yet fixed.
- `getConfig: descriptor "duress" is not registered` on every shutdown (latency-ledger flush and
  buffered reports). It drops reports at shutdown, a separate bug seen in the same logs.
