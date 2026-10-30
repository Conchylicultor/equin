# A conversation reads idle while its agent is about to start a turn

Task: task-1793370919-4dcr3h — watch `quiet` events (and `list_agents` "idle")
while agents in the watched subtree were still mid-task.

## Evidence (main DB, tree task-1793313534-w54p8d, 2026-10-29/30)

Every false `quiet` event lines up, to the millisecond, with a
`conversation.statusChanged` flip out of `starting`/`working` into `waiting`
(`event_emissions`) that reverts a moment later. `watch.on-conversation-status`
enqueues `watch.quiet` on the busy → idle flip, the job reads the gap, and an
irrevocable `quiet` lands ~15 ms after the flip. Two distinct gaps:

**A. Launch: `starting → waiting` (≈4–6 s) `→ working`.** Every fresh launch
(S2 14:25:01, xgweva 14:32:01, bk33ds 14:27:27, this task 14:35:25,
v7ta9d 13:18:25, rk1ow1 13:48:55). The sdk agent writes `started` once its
socket listens (projection `working: false`); the reconciler sees a live,
idle agent and writes `waiting`. The launch prompt is already in the agent
(ledger row `typing`/`typed`, written into launch.json), but its CLI is still
booting: `ready` and `turn_started` come seconds later. E.g. this task:
launch turn created 14:35:19.176, status `waiting` 14:35:25.245, quiet
14:35:25.262, turn confirmed 14:35:29.565, `working` 14:35:29.978.

**B. Background task completion: `working → waiting` (150–350 ms) `→ working`.**
S5 13:18:01, S3 13:41:08, S1 13:49:05, S4 13:52:29 (and the S1 00:30 instance).
The agent rests between turns on a backgrounded command
(`working`/`background`). It finishes; the CLI writes `task_notification`, then
`background_tasks_changed` (0 tasks), then — ~300 ms later — `system/init` of
the turn it starts for that notification. Between the last two the projection
is `working: false, backgroundTasks: 0` → `waiting`. Measured over every sdk
events file on main: a `task_notification` written at rest is followed by the
CLI's `init` in 2,577 of 2,577 cases (never by a `result` first); one written
mid-turn is folded into that turn (≈95 %).

`message_agent` makes A/B frequent but is not itself a cause: an event turn is
delivered only to an idle agent (or queues behind a busy one, which case is
also covered below).

## Root cause

The conversation's status is derived from "is a turn running right now"
(`working`) and "are background tasks pending" — not from "will the agent run
again on its own". In both gaps the agent holds input it will act on without
anyone doing anything: an unstarted turn in its CLI's queue (A — and a turn
sent while busy, at the turn's end) or a background completion notification
(B). The status says `waiting` — "its work is in front of the user" — which is
false, and every reader (watch quiet, `list_agents`, the UI) inherits it.

## Fix — the status itself never claims idle while input is pending

1. **Turn ledger evidence** (`conversations` reconciler): a conversation with
   a turn on its way into the agent — ledger state `typing` or `typed`
   (`PENDING_TURN_STATES`, turn-ledger store) — is `working`/`turn` while its
   agent is live. Read in one batch with `latestSubmitAt`
   (`conversationsWithPendingTurn`), passed to `liveStatusFor` as
   `turnPending`. A row entering or leaving those states signals the
   reconciler (`onStatusEvidence`, formerly `onTurnSubmitted`), so a failed or
   dropped turn releases the status at once, not at the minute sweep. Not
   `held`: a held turn waits for a flush that may never come
   (`held-turn-undelivered`), so it is no evidence the agent will run.
2. **Projection evidence** (`runtime-sdk` reducer): a `task_notification`
   written while no turn runs opens the turn the CLI is starting for it
   (`working: true`), exactly as `system/init` would ~300 ms later.

A question held open still wins (`waiting`/`question`), as before.

No change to `watch`: its predicate (`isAgentBusy` on the status column) is
right once the column is.

## What keeps fix 1 from inventing work

A `typed` row of a process that died WITHOUT writing `exited` (a crash, a
kill) was never dropped — harmless before (a stale Queued echo), but under
fix 1 it would keep the next agent of that conversation `working` forever.
So a new process's `started` also drops every `typed` row created before it
(`turns-dropped`): its CLI queue is empty by construction. The launch's own
prompt is `typing` at that point (the launch waits for the consumer to apply
`started` before recording `typed`). In the rare launch whose wait gives up
before `started` is applied (`consumer-behind`), the launch row can be failed
and then confirmed by its `turn_started` — a confirmation always wins.

A `typing` row whose sending process died (a backend restart mid-send) has
no event left to move it either: every boot fails the `typing` rows last
moved before the process loaded (`failOrphanedTypingTurns`, warm-up
`turn-ledger.orphaned-typing`) — Retry; a confirmation still wins.

Review (independent agent) raised the held/typing/signal points above; all
three are folded in.

On main at the time of writing no live conversation held a pending row
(only `done` ones, which the reconciler never plans), so the change takes
effect without a backfill.
