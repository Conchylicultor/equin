# stuck-spans

Files a report **while an operation is still stuck**, not after it finishes.

A slow-op report (`debug/slow-ops`) is filed when a span *completes*. A span that
never completes files nothing. On 2026-09-11 a live-state flush on main, and the
push inside it, stayed open for 25+ minutes: every live update in the app queued
behind it, and nothing alerted
(`research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md`). This
plugin closes that gap. It is Part 4 of
`research/2026-09-11-global-query-deadline-and-stall-health.md`.

It **detects; it does not recover.** Part 1 of that plan (the database query
deadline) fails one kind of wait — a lost DB query — and so unsticks the flush.
This watchdog catches every other kind: a child process, a lock, a network call,
a promise a bug never settles. Those stay stuck until the backend restarts.

## How it works

`server/internal/watchdog.ts` runs a raw `setInterval` every 15 s, started in
`onReady` and stopped in `onShutdown`. Each tick reads the runtime profiler's
open entry spans (`captureFlightWindow`, the whole open set, no completed ring)
and hands them to the detector (`server/internal/detect.ts`):

1. A span is a **candidate** when its kind is watched and either
   - **own work** — its age less every wait in its subtree (the ended ones,
     `waitMs`, and the ones still in progress, `pendingWaitMs`) reaches its
     kind's threshold (`server/internal/policy.ts`); or
   - **queued** — a wait it is the innermost entry of has lasted its kind's
     threshold and is still in progress (`FlightSpan.waiting`).

   A gate charges a wait only when it ENDS, so before the profiler showed
   in-progress waits (`beginWait`, announced by `packages/semaphore`'s
   `onQueued`) a span queued 90 s looked like a span busy 90 s: on main
   (2026-11-04) `sub reports.list:rows` was filed 387 times and
   `sub host-fs.peek` 314, each run as stuck itself, while the read gate
   they waited on — and what held it — went unnamed.
2. **Only the deepest candidate of a chain is reported.** An entry waits on its
   children, so when a `push` is stuck the `flush` above it is stuck because of
   it. One report naming the push, with the flush in its ancestor chain, says
   everything. If the child later finishes and the parent is still stuck, the
   parent becomes the deepest candidate and gets its own report. A *young*
   child does not hide a stuck parent — only a stuck one does.
3. **Once per span run and cause.** The watchdog remembers which span ids it
   already reported, for which cause, and never reports one twice for the
   same cause (a sub queued, then admitted and stuck in its own load, is two
   findings). After every tick it forgets the ids
   that are no longer open, so the remembered set can never outgrow the open
   registry. Span ids are never reused, so forgetting cannot cause a re-report.

For a tick that found new stuck spans, it captures **one** trace (everything in
flight at that instant — every span found that tick is stuck at the same
instant, so N captures would be N copies of one picture) and files one
`span-stuck` report per **operation** (`kind` + `label`) stuck in its own
work — the runs of one operation found on one tick are one finding, `runs` of
them, described by the oldest — and one per **gate** whose waiters were found
queued (`groupByGate`): every waiter of a gate waits for the same holders, so
the report is about the gate, naming its holders and occupancy as its gauge
reads them that tick (`readGateGauges`), and the waiting operations counted.
All linked to that trace.

The detector takes its open-span source and its sink as arguments, so the tests
(`detect.test.ts`) drive it with a fake flight window and a fake clock.

## Thresholds

One typed table, exhaustive over the profiler's span kinds — adding a kind is a
type error until someone decides whether it is watched:

| Kind | Policy |
|---|---|
| `http` | 120 s — admission-gated and can queue behind git work on a loaded host; still interactive, so two minutes is where slow has become stuck |
| `sub`, `loader`, `push`, `flush`, `cascade` | 90 s — nothing on these paths should take near that long (a healthy flush is milliseconds to ~2 s); set past the app pool's 60 s query deadline so a lost DB query is cut off and reported as `db-query-deadline` first |
| `job` | **excluded** — the jobs worker already bounds a run with its hold class's deadline and files `job-deadline-exceeded` / `job-zombie` (`infra/jobs/deadline-audit`). A flat threshold here would contradict the per-class one |
| `bg` | **excluded** — `runTracked` roots include long-lived work by design (connect loops, watchers) |
| `db` | **excluded** — a leaf; never an open entry. A hung query shows as the age of the entry it runs inside |

Watched spans running *inside* an excluded root (a loader under a job, a flush
under a `bg` root) are still watched; the root is named in their chain.

The tick interval and the thresholds are module constants, not config: they are
properties of the detector, as in `debug/queue-health`.

## The report kind

`span-stuck`, variant `error`.

- **Fingerprint** `span-stuck:<kind>:<label>`, so repeated stalls of the same
  operation collapse onto one row whose count is the number of ticks that found
  it newly stuck; a gate finding is `span-stuck:gate:<layer>`, one row per
  gate whatever waits on it.
- **Gate message:** `81 operations have been queued on the read-admit gate for
  up to 1 min without being admitted; it is held by host-fs.peek {…} (1 min).
  Waiting: sub reports.list:rows ×80, sub host-fs.peek`.
- **Message:** `An operation has been running for 3 min and has not finished:
  flush flushNotifies → push conversations-gone:count` — open ancestors
  outermost first, then the stuck span. The age is the age *when detected*; a
  run is reported once and not re-measured, so it is a lower bound.
- **Payload:** `spanId`, `kind`, `label`, `ageMs`, `thresholdMs`, `runs`
  (how many runs of the operation the tick found, the others described by the
  oldest; absent = 1), `ancestors`
  (`{id, kind, label, ageMs}`, outermost first, cut short where a parent had
  closed), `traceId` (null when the trace engine did not admit a capture),
  and `gate` on a gate finding (`layer`, `waitKind`, `waitedMs`, `occupancy`
  or null, `holders` ≤ 8, `waiters` ≤ 10 — the span fields then describe the
  longest waiter and `runs` counts every waiter).
- **`duressExempt: true`.** A hang and a host duress episode are often the same
  event, and duress is when the reports funnel sheds. Exempting is safe on
  volume because each span run is reported once.
- The trace is captured with `critical: true` for the same reason: neither the
  per-minute trace cap nor duress shedding may drop the evidence for a hang.
  It fires only on a tick that found a span never reported before.
- The Debug → Reports row shows a one-line summary with a View-trace chip
  (`web/components/span-stuck-summary.tsx`).

## Why an interval and not a job

A monitor must not run through the machinery it watches. A scheduled job is
dispatched by the jobs worker, and would queue behind the very wedge it exists to
report — which is what silenced the queue monitor on 2026-08-17. The doctrine and
the structure copied here (module timer, start/stop pair, `runTracked` tick) are
in `plugins/debug/plugins/queue-health/server/internal/watchdog.ts`.

It still rides the event loop it runs on, so a frozen **loop** silences it. That
is one level lower, and belongs to the stall detector (`debug/stall-monitor`). A
stuck await leaves the loop free, which is exactly the case this catches.

## Scope: every backend watches itself

The profiler's open registry is per-process memory, and reports are filed under
the backend's own worktree. So every backend runs its own watchdog over its own
spans, and none can see — or double-report — another's. Supervised exec children
run no `onReady`, so no watchdog.

## Overlaps with other reports (all deliberate)

- **`slow-op`** — if a stuck span eventually finishes, slow-ops files it too.
  The two say different things: "it was still running" vs. "it finished slowly".
- **`db-query-deadline`** (`database/query-deadline`) — none, by design. The
  90 s thresholds sit past the app pool's 60 s query deadline on purpose, so a
  span stuck on a lost DB query is cut off and reported as `db-query-deadline`
  before this fires. The two never describe the same hang: a `span-stuck`
  report means something the deadline does not cover.
- **`job-deadline-exceeded` / `job-zombie`** — cover the job as a whole; this
  plugin excludes `job` spans but names a stuck child *inside* a job.
- **`event-loop-stall`** — a frozen loop. Disjoint: this watchdog cannot run
  while the loop is frozen.

## Known limits

- **Only gates that announce their waits are told apart.** A wait shows while
  in progress only when its gate calls `beginWait` — every
  `packages/semaphore` gate wired through `gateWaitHooks` (read-admit,
  background-acquire / -tx-acquire, heavy-read-local, browser-fetch-local,
  endpoint-concurrency). A wait on a host-wide flock pool
  (`heavy-read-acquire`, …), the pg pool's own `db-acquire`, or a join
  (`read-coalesce`, an `inflight` joiner) still reads as the waiter's own
  time until it ends. A join's run is itself an open span, reported as the
  deepest candidate when it is the stuck one.

- **A stuck flush also freezes its own alert in open tabs.** The report row is
  written, but the bell and the Reports list reach tabs through live-state,
  which is the thing that is stuck. The "live updates stalled" health row
  (Part 3 of the plan) is what reaches tabs in that case.
- **A flush that keeps re-draining past its threshold is reported** even though
  it is making progress: the open set alone cannot tell "stuck" from "busy for
  90 s straight". A healthy flush never gets near that long.
- **Report source.** The reports engine has no source entry for this monitor
  yet, so it files under `server-slow-op` (the profiler's span-signal source).
  One constant in `watchdog.ts`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Stuck-span report renderer: a one-line Debug → Reports summary for the span-stuck kind (how long it has been running, the chain of operations it is stuck under, and a View-trace chip). Stuck-span watchdog: a 15 s interval on each backend's own event loop — deliberately NOT a scheduled job — that reads the runtime profiler's open entries and files a span-stuck report while an http / sub / loader / push / flush / cascade span is still running past its threshold (90 s — past the app pool's 60 s query deadline; http 120 s), once per span run, naming the deepest stuck span of a chain with its open ancestors and attaching one coherent-instant trace per tick. Catches the hang a completion-time slow-op report never can. duressExempt; job and bg spans are excluded.
- Web:
  - Contributes: `Reports.KindView` → `SpanStuckSummary`
  - Uses:
    - `debug/trace/engine.TraceChip`
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `reports.Reports`
- Server:
  - Contributes: `report-kind` "span-stuck"
  - Uses:
    - `debug/trace/engine.captureTrace`
    - `infra/background/timer.defineTimer`
    - `reports.ReportKind`
    - `reports/engine.recordReport`
  - Register: `defineTimer('stuck-spans.watchdog')`
- Exemptions:
  - Exempts itself from:
    - `timer/no-unlisted-timer` — `server/internal/watchdog.ts` (sanctioned)
    - `sink-safety/no-adhoc-profiler-seam` — `.` (sanctioned)
- Core:
  - Exports (types):
    - `StuckAncestor`
    - `StuckGate`
    - `StuckSpanPayload`
  - Exports (values):
    - `GATE_HOLDERS_MAX`
    - `GATE_WAITERS_MAX`
    - `SPAN_STUCK_KIND`
    - `StuckSpanPayloadSchema`

<!-- AUTOGENERATED:END -->
