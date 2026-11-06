# /demo "blocks the main thread": it was the browser waiting for a CPU, not the page working

Task: task-1793972165-g117w0 (responsiveness audit, task-1793965642-94fdhj).

## The claim

Measured headless from an agent session on a loaded host: 41 long animation
frames (9.1 s) in /demo's first 27 s, worst 1.7 s (one React scheduler task),
plus 0.5–1.1 s `runQueued` frames; main filed "Main thread frozen 13.1 s —
demo (root) — unattributed" (report-1793833639-4dssiq).

## Splitting wall from work

A long frame is wall time. Wall = the time the thread worked + the time it
waited to be scheduled. A CPU profile cannot tell these apart: on macOS the V8
sampler charges a descheduled thread's time to whatever function is on its
stack. That is why the profiles named a different culprit on every run:
`layoutHost`, `postToWorker`, sonner, `useTabOrigin`, a pong handler and
`fetch` each took seconds of "self time".

A Chrome trace records both for every task: `dur` (wall) and `tdur` (thread
CPU). The new `e2e-harness/e2e/main-thread-trace.ts` prints them side by side.

| run (30 s from navigation, host load 40–90 on 18 cores) | tasks > 50 ms | their wall | their CPU | all tasks: wall / CPU | longest task (CPU) |
|---|---|---|---|---|---|
| /demo, Chromium darwinbg (as every agent e2e run) | 124 | 36.5 s | 1.6 s | 43.6 s / 4.7 s | 290 ms |
| /demo, Chromium foreground (`--foreground`) | 11–13 | 1.2–1.4 s | 0.7–1.1 s | 4.3–4.7 s / 3.2–4.0 s | 251–318 ms |
| /agents, Chromium foreground | 19 | 3.1 s | 2.2 s | 7.5 s / 5.7 s | 476 ms |

An agent's e2e script runs darwinbg (the `e2e` host pool is `holder: "inherit"`
and an agent session is darwinbg), so the Chromium it launches runs on the
efficiency cores, throttled. Under load its renderer waits seconds between
tasks and inside them. About 96 % of the "long frame" time was waiting.

In the foreground /demo costs **less** main-thread CPU than /agents. Its
heaviest task is the app's boot commit: React's `performWorkUntilDeadline`,
~180 ms of JS plus ~100 ms of style recalc (`UpdateLayoutTree`). /agents has
the same task, larger. The demo mount is no single big commit. The render
profiler shows it as ~20 commits over ~1 s (largest: 1,528 fibers mounted,
tree ≈ 5.9k fibers).

## The 13.1 s "freeze" with no long frame

The stall detector pings each tab from a SharedWorker at 1 Hz and calls it
frozen when no pong arrives for ≥ 5 s. A tab whose renderer is not being
scheduled answers nothing. But it is not running a task either, so LoAF
records no frame. That is exactly the report's shape: 13.1 s silent,
`framesDuring: 2`, `topFunction: null`, and two more stalls (7.3 s, 10.3 s)
from the same tab filed in the same instant. The payload carries no user
agent, so it cannot say whether the tab was the user's Chrome or an agent's
headless one. Either way, a freeze no long frame covers is a thread that did
not run, not a thread that worked.

## What changed

- `framework/tooling/e2e-harness/e2e/main-thread-trace.ts` — the
  wall-vs-CPU trace tool (any page: `--path`; `--foreground` lifts the run out
  of darwinbg first, as the user's browser runs).

## Not done here (filed / reported)

- Frame-time numbers from agent e2e runs measure starvation. Either the
  harness says so (CPU beside wall), or a perf run lifts its browser.
- The stall report should say when no frame covers the freeze, i.e. the
  thread was not scheduled (task-1793972180-utmus5's area).
