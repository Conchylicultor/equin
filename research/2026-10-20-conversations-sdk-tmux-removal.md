# SDK agents without tmux: detached processes, per-worktree agent paths, one health row

Track: wiki *Mental model → Agent Manager → SDK Claude* (`block-3005117a-…`), last unchecked item.

## Context

Every sdk agent (`runtime-sdk/bin/agent.ts`) is still started with `tmux new-session`. tmux drives
nothing any more: it only keeps the process alive past a backend restart, and backs the
conversation's terminal button, a read-only `tmux attach` of the agent's stdout log. That keeps
tmux as an install dependency (mise, install.sh, doctor, toolchain smoke check), a
terminal pane plugin, and an env-scrubbing wrapper written only because the tmux server leaks its
environment into every pane.

Open issue found on the track: **a worktree backend reaches main's agents.** Agent paths are global
and keyed only by conversation id (`sockets/agents/<id>.sock`, `state/sdk-agents/<id>/`). A
worktree's DB is a fork of main's, so it holds main's live sdk rows. Its `liveSdkConversationIds()`
returns them, `helloAgent` on the shared socket gets an answer from main's agent, and the worktree
then treats that agent as its own: it shows it as alive, sends turns, interrupt, `shutdown` (Stop,
Exit, rewind) to it, and its consumer tails main's `events.jsonl` into the fork.

Outcome:
- Agents are started detached (their own session and process group), with no tmux. They still
  outlive a backend restart or crash.
- Every agent path is scoped to the namespace of the backend that launched it, so a backend can only
  see its own agents.
- The terminal button, its pane and tmux are gone.
- The health report has one **Claude Code** row in place of two: the CLI, the Agent SDK, and how
  many agent processes are running. **Its UI is prototyped first.**

## Step 0: Prototype the row (stop for review)

`./singularity prototype new "Agents health row"`, which mocks the health-report popover, with
options for the states:
- ok: `Claude Code v2.1.x · SDK 0.x · 3 agents running`
- drift: attention, SDK built for another CLI version
- CLI missing or signed out: critical, with the install / sign-in actions
- 0 agents
- an agent count that is not known yet

Directions to compare as one option: a single-line summary, versus the summary plus a three-line
glance (CLI / SDK / Agents). **Stop here and wait for the user's pick** before building the row.

## Step 1: Detached launch through `defineDaemon`

`infra/spawn/daemon` is the sanctioned way to keep a long-lived child (the `no-raw-bun-spawn` lint
routes there). Its `launchDetached` / `attach` arms (`restart: { kind: "never" }`) follow a detached
process by a pid file. The agents then also appear in Debug → Background activity.

- `runtime-sdk/machine/internal/agent-daemon.ts`: `sdkAgentDaemon = defineDaemon({ name:
  "runtime-sdk.agent", startedBy: "on-demand", where: "every-worktree", restart: { kind: "never" } })`,
  registered from the machine barrel.
- `agent.ts` writes `locks/sdk-agents/<namespace>/<id>.pid` (Step 3) at start and removes it in `shutdown()`. Its stdout and stderr
  both go to one appended `<dir>/agent.log`, which replaces `stderr.log`. That log is kept for debugging
  and is now the only record of a crash before the first event. Drop the SIGHUP handler's tmux
  wording; keep SIGTERM.
- `sdk-runtime.ts`:
  - `startAgentSession` → `sdkAgentDaemon.launchDetached({ instance: id, argv, env, cwd, pidFile })`.
    `launchDetached` takes no `cwd` or log fd today. If it needs them, or it does not fit a process
    that is itself long-lived (it was built for a bootstrap that exits), extend the daemon primitive
    with that arm rather than calling `Bun.spawn` raw.
  - On boot (`subscribe`), `attach({ pidFile })` every live agent dir of this namespace.
  - `stopAgent`: `shutdown` command → wait for `exited`. If the pid is still alive, SIGTERM it, then
    SIGKILL it, then `instance.stop()`. This replaces `tmux kill-session`.
  - The "kill a stale session" step in `create` becomes "a live pid file means the agent is already
    running", covered by the existing `isRunning` check.
  - Delete `machine/internal/tmux.ts`.
- Environment (`agent-launch/agent-session-env.ts`): keep the closed `env -i` + account login-shell
  wrapper, because the agent's tools need the user's profile PATH. The values now come from the spawn
  env, not `tmux -e`.
  - `agentSessionArgs` → `agentSessionArgv`, which returns `["/bin/sh", "-c", WRAPPER, …]` to spawn
    directly.
  - Drop `TMUX` and `TMUX_PANE` from the allowlist; set `TERM=dumb` explicitly.
  - Rewrite the header comment: the leak it guards against is now the backend's own environment.
  - Update `agent-session-env.test.ts`.
- `infra/launcher/systemd-unit.ts`: keep `KillMode=process` and correct its comment (it now protects
  the detached agents in the unit's cgroup).

## Step 2: Agent paths per worktree

- `paths.ts`:
  - `agentDir(id)` = `sdkAgentsDir/<namespace>/<id>/`.
  - `agentSocketPath(id)` = `sockets/agents/<namespace>/<id>.sock`.
  - Both read `runtimeNamespace()` and take no namespace parameter, so a backend can only spell its
    own agents. Every reader (consumer, partial-stream, socket-client, launch) already goes through
    these functions.
- Assert the socket path is under the 104-byte limit at launch, with a loud error. Today's path is
  about 88 bytes.
- Result: a worktree's forked copies of main's rows find no socket, so they read as not running.
  Non-main reconcilers already answer `leave-unowned` (`hibernation-decision.ts`), so nothing is
  written to them. Update that file's "tmux is host-global" comment and the one in
  `hibernate-idle-job.ts`.
- **Handover of the agents that are running at deploy time** (old, unscoped paths): a one-time boot
  step on main.
  - For each `sockets/agents/<id>.sock` at the top level, send `shutdown`, then remove the old
    `state/sdk-agents/<id>/`.
  - Those rows hibernate (status unchanged) and resume from their transcript on the next Send. This
    is the same path the `retire_tmux_rows` migration used.
  - Cost: a turn in progress at deploy time stops, and must be sent again.
  - Delete the step in a later cleanup once main has run it.

## Step 3: The merged health row

- `infra/claude-cli/availability/web` stops contributing its row. It exports `useClaudeCodeHealth`,
  `ClaudeCodeActions` and `ClaudeCodeDetail` for reuse. It keeps `RecheckOnReturn` and
  `useClaudeCodeLaunchBlock`.
- `runtime-sdk/web` contributes the one row: id `claude-code`, title "Claude Code", order 5.
  - Its state is the worst of: the CLI's health, the version drift (`cliDriftVerdict`, already in
    `web/internal/cli-drift.ts`) and the process count.
  - It reuses the CLI's actions and detail. Its layout follows the prototype pick.
- New machine live value `runtime-sdk.agent-processes`, with an "unavailable" sentence on a host
  without the computer. It counts **both**:

  ```ts
  { here: number; elsewhere: { namespace: string; running: number }[] }
  ```

  - **Pid files live in their own folder:** `locks/sdk-agents/<namespace>/<id>.pid`, a new
    `locks`-kind data dir with `reclaim: restart`. They are not in the agent folder, which
    `events.jsonl` appends would keep waking.
  - **The count is pushed:** one file watcher on that folder, which changes only when an agent starts
    or exits.
  - **A file only counts if its pid is alive**, checked at each recompute, so a SIGKILLed agent's
    leftover file drops out. The recompute also runs on each `list()` call the status reconciler
    already makes.
  - **Reading other worktrees' pid files is count-only.** It never touches their sockets.
- Row summary: `3 agents running · 2 more in other worktrees`. The detail lists each other
  namespace with its count, drawn as the standard id chip (`active-data/id-chip`'s
  `GenericIdChip`, through the `att-…` kind's `IdKinds.Presenter`): the task's title, clickable,
  never the raw `att-…` id. A namespace that is not an attempt id (`singularity` = main) reads
  "main".

## Step 4: Delete the terminal and tmux

- Delete the `conversation-view/terminal-pane` plugin:
  - its `Conversation.ActionBar` button, its pane, and the `open-terminal` PendingPromptAction;
  - the entries in `config/conversations/conversation-view/jsonl-viewer/pending-prompt-action*.jsonc`;
  - the `JsonlViewer.PendingPromptAction` slot and its `Render`, which then have no contributor.
- Delete `primitives/terminal` (PTY-over-WebSocket, `/ws/terminal`, bun-pty, xterm) if nothing else
  uses it (the explore pass found no other consumer), along with the xterm stubs in
  `auto-stub-packages.ts`.
- Remove the `TMUX` bin (`infra/paths/server/internal/bins.ts`) and the tmux tool:
  - `toolchain/core/internal/tools.ts` and `versions.test.ts`;
  - `mise.toml` / `mise.lock`, `install.sh`, `doctor.sh`, `deps/mise/mise-updater.ts`;
  - `sidequests/clean-install`.
- Delete `bin/spike.ts`. Its results live in the spike doc.
- Stale wording sweep. These are user-visible task prompts, so they matter:
  - "look at the tmux pane" / "tmux paste" in `turn-ledger/machine/internal/report-kinds.ts`,
    `deliver-held-turns-job.ts` and `reports/turn-unconfirmed/turn-unconfirmed-task.ts`;
  - the comments listed by the explore pass, including `runtime-sdk/CLAUDE.md`, `agent-launch`
    and `exit-clean-finalize-job.ts`.
- Dead env scrubs: drop the `TMUX*` handling in `gateway/env.go` and `launcher/runtime-env.ts`,
  together with their tests.

## Verification

- `./singularity test plugins/conversations/plugins/runtime-sdk plugins/conversations/plugins/agent-launch plugins/shell/plugins/health-report`
  and `./singularity check`.
- Build, then in the worktree app:
  - launch a conversation, send, Stop, AskUserQuestion, rewind, close and resume;
  - `ps -o pgid,sess` shows the agent outside the backend's process group;
  - no `tmux` process is involved (`tmux ls` is empty or absent).
- **Survives a restart:** start a long turn, rebuild (the backend restarts), and check that the turn
  completes, events are not lost, and the row is re-attached (Background activity lists it).
  Repeat with `kill -9` on the backend.
- **Isolation:** from this worktree's backend, a forked main conversation reads as not running.
  `query_db` on the fork shows its row untouched, and main's agent never receives a command (its
  `agent.log` has no line from the worktree).
- **Health row:** the count follows launch, close and a `kill -9` of an agent. The CLI-missing and
  drift states render as in the prototype. Check with `screenshot.ts --click` on the health dot.
- Handover: simulate with an agent started on the old layout (main code), then deploy this build to
  the worktree. The old agent is shut down, its row hibernates, and the next Send resumes it.
- Update the wiki track (`write_agent_note` on the track card): check the item, record the
  isolation fix, file the next task.

## Outcome (2026-10-20)

Implemented as planned, with these differences:

- **The detached launch is `launchDetached`** with two new options, `cwd` and `outputFd`. `outputFd`
  is an fd the caller opens (`agent.log`, append) and closes after the spawn, so the daemon's
  `server/` code needs no `node:fs`. The daemon barrel now exports `readPidFile` and `pidAlive`.
- **The row layout differs from the prototype.** The other worktrees' chips are in the row's
  expanded detail, not its glance: a health row's glance sits inside the row's click target and
  may hold no controls. The glance shows plain lines: `Claude Code vX`, `Agent SDK Y · built for
  vZ`, `Agents N here · M in K other worktrees`.
- **The handover only runs on main.** A worktree's agents started on the old paths are left
  running; nothing commands them, and they stop when their conversation is resumed or the machine
  restarts.
- **Stop path:** `shutdown`, then wait for the agent's `exited` event. If the agent does not answer
  its socket or does not exit within 15 s, it is killed with SIGKILL and its pid file and socket are
  removed.
- **Deleted:**
  - `primitives/terminal`, the `JsonlViewer.PendingPromptAction` slot and `bin/spike.ts`;
  - the `TMUX` bin, the tmux tool, and tmux in mise, install.sh, doctor and clean-install.

Verified live in this worktree (`att-1792522568-jqdk8q`):

- **Detached launch:** a Sonnet agent on the Hello scratch workspace ran in its own process group
  (PGID = its pid), with no tmux process on the machine. Its files were under the namespace:
  `state/sdk-agents/<ns>/<id>/`, `locks/sdk-agents/<ns>/<id>.pid` and `sockets/agents/<ns>/`.
- **Restart:** `kill -9` of the backend mid-turn (a background `sleep 60`). The agent was
  re-parented to launchd and kept running. The new backend applied its events: the turn finished
  with `DONE`, and a new message got `PONG`.
- **Health row:** showed `1 agent here`. With pid files planted under `singularity` and another
  attempt, it showed `2 in other worktrees` live; a pid file naming a dead pid was not counted. The
  detail drew the attempt as its task chip and main as "main".
- **Close:** `shutdown` → the agent exited, and its pid file and socket were removed.

Not verified live: the handover on main. It runs on main's first boot after the push.
