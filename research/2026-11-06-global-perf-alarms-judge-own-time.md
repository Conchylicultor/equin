# Perf alarms judge own work; waits are judged against the gate

Task: task-1793967439-26duti (responsiveness audit, supervisor task-1793965642-94fdhj).

## Problem

`debug/op-rate`'s op-time monitor summed WALL time (`Aggregate.totalMs`), so a
declared hold or a gate queue counted as the op's cost. slow-ops already judged
own time (a3e1e4b1e9); op-time did not. Main's profile over 61 min
(2026-11-06, `GET /api/debug/profiling/runtime`), per 5-min window:

| kind | wall / window | own / window | own % |
|---|---|---|---|
| sub | 88.3 s | 4.9 s | 5.6 |
| push | 57.4 s | 14.5 s | 25.3 |
| flush | 9.7 s | 2.9 s | 29.7 |
| http | 3.0 s | 1.0 s | 32.0 |
| loader | 22.1 s | 16.5 s | 74.8 |
| bg | 35.0 s | 27.4 s | 78.4 |

- `sub rollup` (rollup budget 60 s) tripped on wall every window: 987
  occurrences, the single largest op-time fingerprint. Own: 4.9 s — never.
- `deliver:queue-health.pulse`: 200 s wall, 197 s of it `throttle-hold`;
  `deliver:conversations.partial-message`: 180 s wall, 170 s hold.
- `sub config-v2.values` 249 s wall / 0 s own (all `read-admit`);
  `reports.list:rows` 101 / 1; `edited-files` 28 / 0.
- Wait spans booked as work: `db [background-acquire]` 18 s "own" (the
  context-less wait fallback) and `db [acquire]` 22 s "own" (the pool-connect
  wait, also charged as `db-acquire`).
- `loader edited-files` 25 s "own" with no wait named: awaiting the watched
  memo's in-flight first pass was not a wait layer.
- 1330 of 2962 flushes were parented to `sub start:conversations.partial-message`
  (the flush microtask inherited the notifier's async context).
- `span-stuck`: one row of 387 occurrences was many runs of
  `sub reports.list:rows` stuck behind one blocked gate, a report per run.

## What changed

- **op-time judges own time** (`selfTotalMs`). The report carries
  `wallMsInWindow` for context.
- **Gate meters** (runtime-profiler `getRuntimeProfile().gates`): every
  `queue`/`io` wait metered once per wait where `chargeWait` sees it, with the
  gate's current holders. op-time judges each gate against a new
  `waitMsPerWindow` (60 s) as `op-time:wait:<layer>`. The waits are not
  dropped: they are reported against the gate that held them.
- **Waits are never work**: the context-less `db [layer]` fallback and the
  `db [acquire]` leaf are recorded all-wait (own 0). A context-less queue wait
  goes to `onSlowWait` / the gate window like any other. A context-less `join`
  records nothing (it is the joined run's time).
- **`memo-opening:<name>`** join wait in `packages/watched-memo` (landed on main in parallel, with the read slot yielded while waiting; this branch took main's version).
- **Flush in the root context** (server-core `wrapFlush` via the new
  `runInRootContext` profiler hook): a flush is its own lane, never a child of
  the notifier, and is outside suppression too (a flush pushes real frames).
- **stuck-spans**: one report per operation per tick, with `runs`.

## Before / after

Measured on this worktree's build: `db [acquire]` 1819 calls, 96 ms wall → 0 ms
own; `db [background-acquire]` 17 → 0; 71 / 71 flushes have no parent; `gates`
lists 6 layers.

Against main's 3-day op-time history, every fingerprint whose own share is
small no longer trips. Main's 61-min profile has the sub rollup at 4.9 s own
per window against a 60 s budget, and the queue-health and partial-message
deliveries at ~2 % own. That covers about 1190 of ~1360 lifetime op-time
occurrences seen in the last 7 days: the sub rollup, the push rollup,
`deliver:queue-health.pulse`, the `sub *:rows` alarms, `edited-files*`,
`deliver:partial-message`, and `db [background-acquire]` / `[acquire]`.

Their time now has a single home. `read-admit` averaged 63.8 s of waits per
window on main, so expect `op-time:wait:read-admit`, with its holders, to trip.
That is the real congestion, filed once at the gate. Sibling task
task-1793967465-8xd27d owns it.

## Not done (follow-ups)

- ~~`push deliver:<key>` and the client `element` still count the loader's join
  wait inside their own drain window.~~ Done (task-1793971051-sfx116):
  runtime-profiler keeps each entry's `join` waits positioned and hands them,
  keyed by run, to the enclosing entry. `deliver:<key>` names its
  `push <key>` (`joinsOf`) and takes only that run's joins off, never a
  sibling's from the flush's mixed bands. The `sub` origin's join union rides
  the sub-ack as `joinedMs`, and `element` takes it off as `server-join`.
- A claim reaching back past a wait already charged to the same entry is
  under-counted by the streaming union: a loader that joined 1500 → 4000 and
  was then filed (0 → 4000) leaves its `push` and `flush` with only the join
  excluded, so they can still be filed on time the loader owns. Latency leaves
  are unaffected (they intersect positioned bands).
- Identical-duration slow DB ops at one instant are NOT a loop stall. For
  example, `job_run_stats` upserts at 2393 ms had 0.9 ms `event-loop` charged.
  The cause is database-side and is uninvestigated.
- The stuck-spans watchdog cannot see that an open span is queued in a gate
  right now: a wait is charged only when the slot is acquired. A span stuck in
  a queue is still reported as stuck itself, now once per operation.
- A latency leaf's lane queue (`flush-queue`) is filed to slow-ops but is not
  in `gates`.
