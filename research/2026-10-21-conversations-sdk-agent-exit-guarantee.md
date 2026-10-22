# SDK agent: an exit that always happens

Track: wiki *Mental model → Agent Manager → SDK Claude* (`block-3005117a-…`), item
*[Robustness]*. Task `task-1792540663-yilv5t`.

## Context

On main, 2026-10-20 21:55 UTC, the handover sent `shutdown` to 10 agents. Nine exited. One,
`conv-1792512233-nhpy7b` (pid 31059, `agent.ts` at b8b7d98351, under tmux), logged
`● exiting: shutdown command` and kept running until it was SIGKILLed by hand two hours later.

### What the evidence says (new in this session)

- **Its JavaScript kept running after `shutdown()`.** It was not frozen. Its tmux pane logged
  `21:56:18 ● session …` and `21:56:32 ● idle · success` after the "exiting" line. Its
  `events.jsonl` (recreated after the handover deleted the directory) holds seq 2501–2508: the
  background push's `task_notification` and the turn it started. Those lines are written by
  `agent.ts`'s own read loop, so the loop was still being driven.
- **`emit(exited)` ran.** The DB cursor stopped at 2499, and the new file starts at 2501, so 2500 was
  written to the old file just before the handover deleted it.
- **No error was printed.** The pane shows no stack trace after "exiting". A throw from the
  `setTimeout` callback would have killed the process (checked: Bun 1.4.3 prints the error and
  exits 1, and the same happens when an `exit` listener throws). Neither the SDK nor any module
  `agent.ts` imports installs an `uncaughtException` handler or patches `process.exit` (checked).
- **So `process.exit(0)` was reached and did not end the process.** Every statement before it is
  synchronous and cannot block, as the read-loop activity shows. The CLI child (31225) also kept
  running, so the SDK's `exit` listener, which sends SIGTERM to the CLI, never ran either.
- **It does not reproduce.** The current `agent.ts` was run with a real CLI (Haiku) in four states:
  idle with a background task, mid-turn, mid-turn with a background task, and idle with a background
  task with stdout on a pty (as under tmux). `shutdown` ended all four in about 250 ms. The SDK
  version is the same as on 2026-10-20 (0.3.303).

Not reproduced: the exact production setup. That means the real launch environment (the agent's
restricted `env -i`, `taskpolicy -b`, hooks, MCP servers), a long resumed Opus session, and a real
`./singularity push` as the background task.

The Bun-level reason that exit did not take effect stays unknown. So the fix has two halves:

- **A backstop**: the agent's exit happens whatever the runtime does.
- **A detector**: whenever the backstop is needed, it says so loudly and captures what is needed to
  find the real cause. A backstop alone would hide the bug, against *fail loudly*. With the
  detector, the first stall in production gives us the native stack, and then the cause gets fixed
  (or filed with Bun), with the backstop kept as a safety net that keeps reporting.

### Two holes the incident exposed (the second is new)

1. **The agent says it is gone before it is.** `shutdown()` emits `exited`, removes the socket and
   **the pid file**, and only then calls `process.exit`. If that exit does not happen, nothing
   remains that marks the process as alive. Its SIGTERM handler then returns early because
   `closed` is set, so only SIGKILL works.
2. **The backend's 15 s SIGKILL fallback does not cover this case** (the task text assumes it does).
   `stopAgent` (`machine/internal/sdk-runtime.ts`) waits for `agentPid === null`, which the reducer
   sets on the `exited` event, and that event arrives *before* the stall. It then calls
   `forgetAgentProcess`, which only drops the daemon record (`launchDetachedIn`'s `stop` kills
   nothing). Even on a timeout, `killAgentProcess` finds the pid through the pid file, which the
   agent has already deleted, so it kills nothing.

   Two more paths follow from this. The daemon follower (`followPidFile`) reads a missing pid file
   as "exited". And `startAgentProcess` runs `rmSync(agentPidPath(id))` before it launches. So a
   Send that relaunches a conversation whose old agent is still alive starts a **second agent on the
   same session** and overwrites the evidence of the first.

## Invariant

> **A conversation's pid file exists exactly while its agent process is alive, and at most one agent
> process runs per conversation.** Only the exiting process itself (as the very last thing it does)
> or the backend that kills it removes the pid file.

Every reader (`liveAgentIds`, the daemon follower, `killAgentProcess`, the health row) already
treats "pid file present and pid alive" as running. With this invariant, that reading is correct.

## Plan

### Agent: `plugins/conversations/plugins/runtime-sdk/bin/agent.ts`

1. **`shutdown()` cannot stall the exit.** In order:
   - Return if already closing; set `closed`.
   - `process.removeAllListeners("SIGTERM")`: from here on SIGTERM takes the kernel's default action
     (termination). It works even if the JavaScript is stuck, and a stalled shutdown is never again
     immune to SIGTERM.
   - Arm a hard-exit watchdog, `setTimeout(hardExit, EXIT_GRACE_MS)` (≈5 s, not unref'd).
   - Log, `emit(exited)`, `server.close()`, remove the **socket** (stops new commands; the backend
     then reads "not answering", whose path kills by pid file, which still exists).
   - `session.close()`, then `process.exit(0)`. **If `process.exit` returns, call `hardExit()`
     at once.**
2. **The pid file goes last.** Remove it from a `process.on("exit")` listener (it runs inside
   `process.exit`, at the point of no return) and in `hardExit` just before the self-kill. No
   longer remove it in `shutdown()`'s body.
3. **`hardExit(trigger)` is loud, then final.** `trigger` is `"exit-returned"` (`process.exit`
   came back) or `"watchdog"` (`EXIT_GRACE_MS` passed after `process.exit` was called). In order:
   - **Capture the diagnosis**, while the process is still in its stalled state:
     - the last shutdown step reached (a `stage` variable set before each step);
     - what keeps the event loop alive (`process.getActiveResourcesInfo()`);
     - the CLI child's pid and whether it is alive;
     - **a native stack sample of itself**: `spawnSync("/usr/bin/sample", [pid, "1", "-file",
       <dir>/exit-stall-<t>.txt])`, bounded by a ~3 s spawn timeout. This shows where inside Bun the
       exit stalled, which nothing in today's evidence can.
     - The sample needs `sample` to attach to its own process. Check during implementation that it
       works under `taskpolicy -b` and the agent's environment. If it fails, record the failure
       text: that is still a datum, never silently dropped.
   - **Write it down**: append an `exit_stalled` lifecycle event (`{ trigger, stage, reason,
     activeResources, cliPid, cliAlive, samplePath, sampleError }`) to `events.jsonl`, and the
     same as one line to `agent.log`.
   - **Then end it**: SIGKILL the CLI child, remove the pid file, `process.kill(process.pid,
     "SIGKILL")` (a self-SIGKILL is not deferrable).

   If the JavaScript is truly wedged, neither the watchdog nor `exit-returned` can run. That case is
   covered by the default SIGTERM (step 1) and the backend's kill (step 7). The backend's kill is
   loud too (step 9). In the 2026-10-20 incident the JavaScript was alive, so this path would have
   produced the full diagnosis.
4. **A handle on the CLI child**: pass `spawnClaudeCodeProcess` (a public SDK option) that starts the
   CLI with `node:child_process` `spawn(command, args, { cwd, env, signal, stdio })` and keeps the
   `ChildProcess`. The CLI's stderr is inherited, so it lands in `agent.log` directly, and the
   `stderr:` callback goes. To check during implementation: same argv (the SDK builds it), the abort
   signal still SIGKILLs after its grace period, and the SDK still delivers the exit (`SpawnedProcess`
   contract). The handle is needed because a CLI with a running background task keeps going after
   its stdin closes (it took a whole new turn at 21:56:18), so it would outlive a self-SIGKILLed
   agent.
5. **The read loop stops relaying once closing** (`if (closed) break`), so no events are numbered
   after `exited`.

The "SDK stream ended", "initialize failed", SIGTERM and `shutdown` command paths all go through
`shutdown()`, so they all get the same guarantee.

### Backend: `plugins/conversations/plugins/runtime-sdk/machine/internal/`

6. **`stopAgent` waits for the process, not for the event** (`sdk-runtime.ts`). After the
   `shutdown` reply, wait (bounded by `EXIT_TIMEOUT_MS`) for the daemon instance to reach `exited`.
   The follower reports that when the pid file is removed, which now happens only at the real exit.
   On a timeout, `killAgentProcess`. This needs an `awaitAgentExit(id, ms)` in `agent-process.ts`
   built on the instance's `onState` (push-based, from the pid-file watch). Both `launchDetached` and
   `attach` already take `onState`.
7. **`killAgentProcess` kills the CLI too.** It SIGKILLs the agent's direct children (the CLI) before
   the agent. That way a backend kill of a wedged agent (one that does not answer its socket) does
   not orphan a CLI that is holding a session. The pid comes from the pid file (which is now
   reliable) or, failing that, from the instance's last known pid.
8. **One agent per conversation, enforced at launch** (`startAgentProcess`). Replace the blind
   `rmSync(agentPidPath(id))` with this: if the pid file names a live pid, stop that predecessor
   first (the same `stopAgent` sequence: shutdown, wait, kill), and only then launch. This covers
   every path that relaunches after an `exited` event (hibernate then Send, Stop's rewinding
   relaunch, resume) whatever the old process did.

9. **Every backstop firing is a report** (`recordReport`, `@plugins/reports/server`, the same
   path the consumer already uses for `SdkEventGap` / `SdkMalformedEvent`):
   - **`SdkAgentExitStalled`**: the reducer returns the agent's `exit_stalled` events as a side list
     (like `gaps` and `malformed`), and `catchUp` in `consumer.ts` records one report each. Its
     message names the conversation, trigger, stage and active resources; `data` carries the
     sample path and the rest of the event. The event file is the transport, so a report
     still arrives when the backend was down at that moment: it replays from its cursor.
   - **`SdkAgentKilled`**: the backend had to SIGKILL an agent. Either it did not answer
     `shutdown`, or it did not exit within `EXIT_TIMEOUT_MS` (step 6). The JavaScript-wedged case
     lands here.
   - **`SdkAgentDuplicate`**: a launch found a live predecessor (step 8). That means the invariant
     was broken somewhere upstream.

   **Where the user sees it:** the Reports engine, i.e. the bell notification, Debug → Reports
   (the row with its count and `data`, sample path included), and the alert funnel the `debug`
   skill starts from. Each kind is one fingerprint, so a recurring stall bumps one row's count
   instead of flooding the bell. The bell re-alerts at most every 10 minutes after a dismissal.
   The Report investigations automation can turn the row into a task.

The protocol gains one lifecycle event, `exit_stalled`, added to `AgentLifecycleSchema`
(`core/protocol.ts`). A backend older than the agent never sees it: the agent and the backend
ship together, and an agent only emits it on a stall. `exited` keeps its name and meaning for the reducer ("this agent is leaving; its
turn and question end"). The hard-exit bound makes it true within `EXIT_GRACE_MS`, and items 6 and 8
stop anything that matters from relying on it as proof that the process is dead.

### Docs

- `runtime-sdk/CLAUDE.md`: the pid-file invariant and the exit sequence (one paragraph).
- `research/2026-10-20-conversations-sdk-tmux-removal.md`: correct "a stop from the backend is
  covered by the 15 s SIGKILL fallback" (it was not, see hole 2) and link here.

## Verification

1. **Normal exits still work**: rerun the four repro scenarios (a throwaway script outside the repo
   that starts `agent.ts` with a launch.json, waits for the trigger, sends `shutdown`, and checks the
   pid). Each must exit in well under a second, with the pid file and socket gone and the CLI dead.
2. **The stall is covered, and loud**: a scratch copy of the patched `agent.ts` with `process.exit`
   stubbed to a no-op (simulating the incident; never committed).
   - After `shutdown`, the agent and its CLI must die within `EXIT_GRACE_MS`, and the pid file must
     be removed.
   - `events.jsonl` must hold an `exit_stalled` event with `trigger: "exit-returned"`, the stage
     and active resources, and a non-empty `exit-stall-*.txt` sample (or a `sampleError` saying why
     not).
   - A second variant stubs out the hard exit as well, then sends SIGTERM: it must kill.
   - With that stubbed agent launched by a real build, the report must appear in Debug →
     Reports with the sample path.
3. **Backend paths** (`./singularity build`, then in the worktree app with Haiku):
   - Stop and close a conversation: the agent and CLI are gone (`ps`), and Debug → Background
     activity shows the instance exited.
   - Relaunch while a predecessor is alive: start a conversation, `kill -STOP` its agent (it can no
     longer answer), then Send after hibernating, or trigger a relaunch. The predecessor and its CLI
     are killed before the new one starts, and `pgrep -f agent.ts` shows exactly one per
     conversation.
   - A background task during shutdown (the incident's shape): start a background Bash task, close
     the conversation, and check that it exits.
4. `./singularity test plugins/conversations/plugins/runtime-sdk` (reducer and launch-options tests
   unchanged), and `./singularity check`.

## Implemented (2026-10-21): differences from the plan

- **SIGTERM during an exit runs the hard exit; it does not fall back to the default action.**
  Testing the plan's `removeAllListeners("SIGTERM")` showed the cost: the default SIGTERM killed
  the agent and left its CLI running, orphaned to launchd, with its background task still going
  (the incident's mechanism again). So a SIGTERM while closing calls `hardExit("sigterm")`. That
  kills the CLI, reports, then kills the agent. JavaScript too stuck to run the handler is covered
  by the backend's kill, which kills the CLI first.
- **No `activeResources`.** Bun's `process.getActiveResourcesInfo()` always returns `[]` (checked
  with a pending timer). The event records the runtime version (`bun 1.4.3`) instead.
- **The sample shows every thread's stack.** Bun's own frames are unsymbolicated (`??? (in bun)`),
  but the thread names (main thread, Bun Pool, JIT, mi-scavenger) and system frames resolve. That
  is enough to see which thread is blocked and in which system call.
- **The report's details are in its message.** The `crash` kind's payload schema strips unknown
  keys, so the stall's fields would have been dropped from `data`. Each report kind is one
  fingerprint (`errorType`).
- **`livePid` checks the pid is this conversation's agent** (`ps -ww -o command=` contains
  `--pid-file <its pid file>`). Every launch now kills a live predecessor, and a pid file left
  behind by a killed agent can name a pid the system has reused.
- **`AgentUnresponsiveError`.** A wedged agent that still has its socket open used to throw a plain
  timeout `Error` out of `stopAgent`, so it was never killed. A reply timeout and a connection
  closed before replying are now typed. `stopAgent` treats them, and a missing socket, as
  "exiting or wedged": wait for the process, and kill it on timeout.

## Verification results

Repro harness (`/tmp/sdk-shutdown-repro/scripts/repro.ts`, outside the repo): it starts `agent.ts`
with a real Haiku CLI, waits for the trigger, sends `shutdown`, then checks the pid, the pid file,
the socket, the CLI 3 s later, the events and any stall files.

| Case | Result |
| --- | --- |
| Idle with a background task | exit 0 in 251 ms; pid file, socket and CLI gone |
| Mid-turn | exit 0 in 251 ms; all gone |
| Mid-turn with a background task | exit 0 in 251 ms; all gone |
| `process.exit` stubbed (the incident) | SIGKILL at 1.26 s; `exit_stalled` (`exit-returned`, stage `process.exit`, CLI pid) and a 276-line sample; all gone |
| `process.exit` stubbed, no `exit-returned` (watchdog only) | SIGKILL at 6.28 s; `exit_stalled` (`watchdog`) and a sample; all gone |
| Stalled exit, then SIGTERM | SIGKILL at 1.26 s; `exit_stalled` (`sigterm`) and a sample; CLI gone |

Backend, on the deployed worktree build (`scratch.hello` conversations on Haiku, via `POST /api/conversations`):

| Case | Result |
| --- | --- |
| A. Close an idle agent that has a background task (the incident's shape) | The agent exited at once, its pid file was removed, and the CLI and its background task finished their own graceful shutdown within ~3 s |
| B. Close a wedged agent (SIGSTOP: socket open, no reply) | Close took 25 s (10 s reply timeout, `AgentUnresponsiveError`, then the 15 s wait); agent and CLI SIGKILLed, pid file removed; one `SdkAgentKilled` report |
| C. Close a wedged agent whose socket is gone (the incident's invisible state) | Close took 16 s (no socket, then the 15 s wait); agent and CLI killed; the same report's count went to 2 (one fingerprint) |
| D. An `exit_stalled` line in an agent's events | `SdkAgentExitStalled` report with the trigger, step, runtime, CLI pid and sample path in its message |

Not driven live: **a launch that finds a live predecessor** (`SdkAgentDuplicate`, step 8). A Send
relaunches only a hibernated conversation, and only main's reconciler hibernates
(`decideMissingProcessAction` returns `leave-unowned` off main). Its pieces did run live in B and
C: `livePid`'s argv check and the CLI-then-agent kill.

`./singularity test plugins/conversations/plugins/runtime-sdk`: 37 pass, including the new reducer
test for `exit_stalled`.
