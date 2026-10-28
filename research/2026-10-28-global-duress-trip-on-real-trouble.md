# Duress trips on real trouble, and the gate keeps a waiter's place

Track: "Track: build and push speed" (page block-e5afc5b1-15f2-4614-a49a-c7b4e6fe1851).
Task: task-1793222247-isnfyh. Prior design: [2026-10-21-cli-duress-admission-one-at-a-time-v2.md](./2026-10-21-cli-duress-admission-one-at-a-time-v2.md).

## Context

On 2026-10-28 most of an agent build's wall time was spent at the duress gate, not building. Agent builds run one at a time while the duress latch is up. Every trip that day came from `loadRatio` (load1 ÷ 18 cores ≥ 1.5), on a host that was not in trouble.

### Baseline (measured from `~/.equin/op-log.jsonl`, background-lane builds, by request day)

| Day | Builds | Build wall | Duress-gate wait | Share | Gate wait per build p50 / p90 / max |
| --- | --- | --- | --- | --- | --- |
| 10-24 | 204 | 3,917 min | 2,321 min | **59 %** | 1.0 / 38 / 116 min |
| 10-25 | 167 | 1,310 | 338 | 26 % | 0 / 7.2 / 41 |
| 10-26 | 68 | 710 | 225 | 32 % | 0 / 7.2 / 48 |
| 10-27 | 43 | 362 | 91 | 25 % | 0 / 3.2 / 25 |
| 10-28 | 126 | 3,369 | 1,959 | **58 %** | 4.7 / 47 / 118 |

(`./equin run plugins/debug/plugins/profiling/plugins/op-log/scripts/build-wait.ts 7`, Step 3. 10-28 differs a little from the page's 60 %/50 min because builds are bucketed by request day and still-running ones are excluded. Builds killed while held at the gate: 4 on 10-24, 6 on 10-28.)

### What the latch measures, and what it misses

- **The trips are almost all load.** In the last 14 days, `loadRatio` alone tripped 2,630 min of duress episodes. Every other signal combined tripped 0–84 min a day. On 10-27 and 10-28 nothing else tripped at all. Since 07-12: 1,774 load-only trips, 1,085 compressor-thrash, 11 slow-backends, 4 pg-locks.
- **The host was fine during those episodes.** Main's event-loop p99 on 10-28, 08–17Z:

  | | Median | p90 | p99 |
  | --- | --- | --- | --- |
  | Under duress (all load-only) | 4.1 ms | 9.2 ms | 12.5 ms |
  | Calm | 2.0 ms | 7.2 ms | 88 ms |

  A live spot check right now shows load1 37 (ratio 2.0, so tripped), the CPU 49–57 % idle, decompressions 13k/s against a 50k trip limit, and swap 0. The macOS load average counts runnable threads, throttled darwinbg ones included. It is not CPU saturation.
- **CPU is already admitted elsewhere.** The host-grant CPU pool bounds how much build work runs at once. A load trip only adds a second, cruder CPU gate on top of it. The real failures the valve exists for are memory thrash (the July freezes, 240k–442k decompressions/s) and pg pressure. A slow main is the symptom a person feels. Each of these already has its own signal.

### A second bug: a waiter loses its place every time the latch flaps

On 10-28 there were 73 episodes, with a median length of 4.4 min. The calm gap between two episodes had a median of 1.4 min (p10 16 s). In `exclusiveUnlessCleared` (`admission-valve.ts`) a waiter leaves the ticket line as soon as the latch clears (`finally ticket.leave()`). If an exclusive build is still running, it then waits for the shared lock. By the time that build finishes, duress has usually tripped again, so the waiter re-queues and joins the line again **at the back**, behind builds that arrived after it. That is why the max gate wait is 116–118 min (2 h ceiling kills) while the median is 4.7 min. The longest holds show one wait-cycle ending `cleared`, which is the shared-lock wait across a flap. The v2 design promised arrival order. That only holds within one episode.

## Approach

### Step 1 — `loadRatio` is context, not a trip signal (rung 1: it cannot trip)

Take `loadRatio` out of the closed set of signals that can trip duress, and move it into the vitals' `context` block. That block is already documented as "machine context that cannot trip duress by itself". With load out of the set, a load trip has no way to happen. A threshold would only make it less likely.

- `plugins/debug/plugins/sentinel/plugins/status-file/core/internal/vitals.ts`: drop `"loadRatio"` from `SignalKeySchema` and from `signals`. Add `loadRatio: z.number().nullable()` to `context`. A vitals file written by an older watcher must still parse (it is rewritten every tick, so a `.default`/`.catch` on the new field is enough).
- `plugins/debug/plugins/sentinel/server/internal/detector.ts`: drop `onLoadRatio` from `DetectorThresholds` and from the `against` list. `SignalReadings.loadRatio` stays, because the trip trace and vitals still show it.
- `plugins/debug/plugins/sentinel/core/config.ts`: delete the `onLoadRatio` field. Also `sampler.ts`, which threads the threshold through. Check how config_v2 treats a stored value for a removed field, and follow the precedent if one exists.
- `worker/entry.ts` writes `loadRatio` under `context`. The web side moves the load row from the signal rows to the context rows: `machine-watcher-health.ts` and `vitals-view.ts`. tsc lists every site that maps `SignalKey`.
- Unchanged: the timeline's `pressure.ts` load ramp, which is display only. The op-log, report-kind and episode-reader vocabularies keep `loadRatio` as a past reason for recorded episodes.
- Docs: sentinel `CLAUDE.md` (the signal list), duress `CLAUDE.md` ("pg pressure, load, memory"), and the module comment in `admission-valve.ts`.

Not adding a replacement CPU signal. CPU saturation is the host-grant pool's job, and its effect on people is already measured by `slowBackends` (backend event-loop p99). If a CPU-idle signal is ever wanted, it should be sampled first and replayed against episodes, not guessed. That is a follow-up, not part of this change.

### Step 2 — the gate keeps a waiter's place across a flap

(As built: a held build keeps its ticket for the whole hold, including calm gaps spent waiting for the shared lock. A rejoin at an old place could not unseat a ticket already granted the head while the waiter was out, and on a flapping latch that happens on every flap. `ticket-line` gains `arrive()` and `join({ place })`, used for the requeue.)

In `admitThroughGate`, a build that starts holding takes **one ticket for the whole hold** and leaves the line only once it is admitted, shared or exclusive. The ticket is no longer taken per episode inside `exclusiveUnlessCleared`.

- Under duress: be at the head of the line, then take the exclusive lock, or stop waiting when the latch clears. Keep the ticket either way.
- Calm, waiting for the shared lock behind an exclusive build: keep the ticket. A calm `tryLock("shared")` that succeeds with no hold never touches the line, so the fast path is unchanged.
- After the grant, a `mustRequeue` re-entry passes the held ticket back in rather than queueing again (via a small `GateHold` → ticket hand-off in `app-artifacts.ts`'s loop). Alternatively the loop owns the ticket for its whole `for`; choose whichever keeps `admitThroughGate` the only place that touches the line.
- Deadlock check: a ticket never blocks shared admission. Only exclusive admission waits at the head. A calm build holding a ticket while it waits for the shared lock delays an exclusive candidate behind it by at most one exclusive run. That is FIFO, which is the intent.
- Tests (`admission-valve.test.ts`, fake `GateLocks`): with A queued before B, the latch clears and trips again while an exclusive build runs, and A is still admitted before B. No double `joinLine` across a requeue. Existing cases stay green.

### Step 3 — the measurement, committed

Commit the build-wait measurement as a repeatable script, so the "before" and "after" numbers come from one ruler: `./equin run …/scripts/build-wait.ts [--days …]`. It goes in the op-log plugin's `scripts/` folder, after checking `docs/plugins-details.md` for an existing op-log aggregation to extend. It reports, per day and for background builds: count, wall, gate wait and its share, the per-build gate-wait p50/p90/max, host-grant wait, and the count of builds killed at the ceiling.

## Expected effect

Counterfactual from the episode log: the episodes that would remain without `loadRatio` cover 0 min on 10-27 and 10-28, 38 min on 10-24, and 0–84 min a day over the last 14 days (against 74–429 min today). The gate-wait share should fall from about 58 % to the low single digits on a day like 10-28. The CPU host-grant wait (171 min on 10-28) will probably grow a little, because builds now queue there instead. That is the right place for them to queue. With Step 2, a residual real episode can no longer starve one build for 2 h.

## Verification

1. `./equin test plugins/framework/plugins/cli/plugins/op-runtime plugins/debug/plugins/sentinel`: the detector never trips on load alone, vitals parse an old file, and the gate's FIFO holds across a flap.
2. `./equin check` (type-check catches every `SignalKey` mapping) and `./equin build`. On my deploy the machine-watcher health row shows load under context.
3. Before/after: the Step 3 script over 10-24…10-28 is the "before" (the table above). After the user pushes, run it over the next busy weekday for the "after", plus main's event-loop p99 during the remaining episodes. Record both on the track page.
4. Watch for regressions: `slowBackends` and `decompressionsPerSec` trips, and main's loop p99 at high load, over the same day.
