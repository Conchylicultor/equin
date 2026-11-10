# runtime-sdk

The `sdk` conversation runtime — the only one (track: wiki *Mental model →
Agent Manager → SDK Claude*). Design:
[`research/2026-10-19-conversations-sdk-runtime-phase1.md`](../../../../research/2026-10-19-conversations-sdk-runtime-phase1.md);
spike: [`research/2026-10-19-conversations-sdk-agent-spike.md`](../../../../research/2026-10-19-conversations-sdk-agent-spike.md);
the default flip and the tmux runtime's removal:
[`research/2026-10-20-conversations-sdk-default-and-tmux-removal.md`](../../../../research/2026-10-20-conversations-sdk-default-and-tmux-removal.md);
agents without tmux, per-namespace paths, the Claude Code health row:
[`research/2026-10-20-conversations-sdk-tmux-removal.md`](../../../../research/2026-10-20-conversations-sdk-tmux-removal.md).

- `machine/` — the runtime (`sdkRuntime`): launch detached
  (`agent-process.ts`: one `runtime-sdk.agent` daemon instance per agent,
  followed by its pid file, re-attached after a restart; stop = `shutdown`,
  SIGKILL when it will not), liveness = its pid file names a live pid and the
  socket answers `hello` — asked of every sdk row whatever its status
  (`runningAgentIds`), since the status is what the reconciler derives from it
  (a `gone` row whose agent runs is resurrected, never hidden), the `events.jsonl` consumer (one file watcher, DB
  cursor, reads rotated generations, reports a seq gap), questions into
  question-relay, and the partial message (`partial-stream.ts`: one
  `subscribe` connection per watched conversation, reconnected when the
  consumer sees the agent's `ready`). `agent-processes.ts` serves
  `runtime-sdk.agent-processes`, the agents running here and in every other
  namespace, and how many run on each Claude account (one watch of the pid
  files; an agent's pid file is its pid, then its account —
  `core/agent-pid-file.ts`). **Temporary**: an agent started before pid files
  named their account counts on no account until it restarts. `attempt-ended-job.ts` (main
  only): when an attempt's last conversation is closed (`done`), SIGTERMs
  every agent its worktree's backends launched — the conversations an agent
  started in its own build while testing, which nothing else reaps once that
  backend stops (`stopCheckoutAgents`, the one cross-namespace command: by pid,
  never by socket).
- **A stalled consumer is loud, never silent** (incident 2026-10-25: main's
  consumer applied nothing of one conversation for the backend's lifetime, no
  report — [`research/2026-10-25-conversations-turn-identity-and-fresh-projection.md`](../../../../research/2026-10-25-conversations-turn-identity-and-fresh-projection.md)).
  - Launch (`launchAgent` / `waitForStart` in `sdk-runtime.ts`): waits for the
    consumer to apply this launch's `started` line (the projection's
    `agentPid`, with `statusAt` past the launch, so a predecessor's unapplied
    pid does not count), bounded at 60 s, then asks `hello` once. Outcomes:
    `ready`; `slow` (no answer yet — not a failure, left to the readiness
    waiters); `consumer-behind` (it answers at a seq past the row's cursor —
    reported as `sdk-consumer-stalled`, NOT thrown: the agent took the launch
    prompt, and a failed launch would release the turn to be sent twice); a
    process exit still throws `AgentStartError`. A `ready` start then waits
    for its Claude Code's initialize (the projection's `cliReady`, reset by
    every `started`; the agent writes `ready` only after `started`) or the
    agent's exit, bounded the same: a CLI that dies before initializing
    (2026-11-10: a clone named for a title ending in ".ts" run by Bun as
    TypeScript) fails the launch with its output — a spawn failure, "Failed to
    start", and the task's watcher hears "agent failed to start: <why>" —
    instead of a launch that succeeded and an agent that silently ended. `waitUntilReady` is the same
    wait with no launch in hand, and Stop's rewind relaunch goes through
    `launchAgent` too (it used to wait on `agentPid` alone, which the
    predecessor's unapplied pid satisfied). The agent writes `started` only
    once its socket listens, so the `hello` after it answers.
  - A wedged consumer ends the launch wait in seconds, not 60 s: the events
    watch notifies `onEventsAppended(id)` listeners before (and whatever)
    catch-up does; the wait gives each append a bounded catch-up
    (`catchUpWithin`, 10 s), and one that does not settle stops the wait —
    the `hello` then names `consumer-behind`. Push-only: no timer runs unless
    the agent writes.
  - Inspect (`inspectAgents`, every reconcile and the minute sweep): `hello`
    first, the rows after; a row whose `cursorSeq` is behind `hello.seq`
    gets `catchUpWithin(id, 5 s)` and a re-read, and one still behind is
    `{ kind: "unverified" }` — the reconciler then marks the conversation
    `statusUnverifiedSince` instead of planning from the stale projection.
    An agent that holds its socket but does not answer `hello` within 10 s
    (`AgentUnresponsiveError`) is `unverified` too — that conversation only,
    never a throw of the whole `list()` (2026-10-30: one agent starved by host
    duress made every sdk conversation unknown and filed a crash). A stretch
    of misses past 5 min (`unresponsive.ts`, in memory) is reported once as
    `sdk-agent-unresponsive`.
  - Catch-up (`consumer.ts`): each run is `runTracked("runtime-sdk:catch-up")`
    and watched by a one-shot deadline (`packages/deadline`, 30 s); past it,
    one `sdk-catch-up-overdue` report per run names the step it is parked in
    (`lease`, `report`, `effect:<kind>`, `write-projection`, `signal`). No
    cancellation — the run keeps the coalescer slot until it settles. An events
    file with no row is reported (`SdkEventsWithoutRow`); only "no row, no
    file" (create has not prepared it) is silent. `isOurs` caches only a yes:
    a cached no would skip a conversation forever.
- **One writer per agent row** (`machine/internal/agent-row-lease.ts`). Every
  write of `conversations_ext_sdk_agent` — a catch-up's projection, a launch
  preparing the row (`prepareLaunchRow`), a relaunch naming its session
  (`recordLaunchSession`) — runs under the agent's lease (a keyed mutex), which
  holds the row as last written. A catch-up starts from the held row: a batch
  costs its one update, a batch with nothing new no query at all (before: a
  re-read per batch: 2,411 of the 4,534 acquires of 2,348
  catch-ups on main, 2026-11-06 — and a catch-up that read
  just ahead of a relaunch wrote the old `sessionId` back over it). Other
  reads take `currentAgentRow` (held, else read after the writes in flight).
  Only writers hold; a catch-up of an agent no longer followed releases it.
  Sound because one backend per DB serves the runtime and nothing else writes
  the table.
- **The per-batch checkpoint is out of the change feed; the stop is its own
  row** (`server/internal/tables.ts`, `rows.ts`). `conversations_ext_sdk_agent`
  (cursor, read position, the projection) moves on every batch an agent writes
  and is read only through the lease, so the server barrel excludes it from the
  feed (`ExcludeFromChangeFeed`). The fields a live surface reads — `stoppedAt`,
  `stopError`, `account` (the runtime-sdk.error-stopped collection, auto-resume)
  — live in `conversations_ext_sdk_agent_stop`, written in the SAME statement
  as the batch's checkpoint (`writeAtomically`) and only when one of them moved
  (`STOP_FIELDS`). Before: every batch was a feed change — trigger, changelog
  row, NOTIFY, routing pass reaching no reader (2026-11-08: ~6,500/h on main).
  The file watch and catch-up per append remain: each append is an event to
  apply.
- **The consumer signals the status reconciler only when the runtime's answer
  moves** (`machine/internal/runtime-info.ts`): `infoOf` is the one derivation
  of what `inspect` reports from a projection, and a batch signals only when
  `reportedStateChanged(before, after)` (any `RuntimeInfo` field, or the agent
  pid) — a turn starting or ending, background work, a new session, a start or
  exit. Assistant text and tool lines move the cursor only. What their effects
  move signals from its own store (turn-ledger's `onStatusEvidence`, the
  question relay's `requestStatusReconcile`). An inspect that answers
  `unverified` owes the agent's next batch a signal (`signalNextBatch`), so the
  mark clears when it catches up, not at the sweep. Before: one reconcile per
  batch, ~1/s per working agent, almost all no-op plans.
- **Every agent path is under the launching backend's namespace**
  (`machine/internal/paths.ts`, which reads `runtimeNamespace()` itself): a
  worktree's DB is a fork of main's, and with paths keyed by conversation id
  alone a worktree backend found main's agents answering and commanded them.
  Layout: `state/sdk-agents/<ns>/<id>/` (launch.json, events.jsonl, agent.log),
  `locks/sdk-agents/<ns>/<id>.pid`, `sockets/agents/<ns>/<id>.sock`.
- **The seq continues from the DB, not from the events file.** Every start
  writes the row's `cursorSeq` into launch.json as `seqFloor`
  (`startAgentProcess`, a per-start field like `claudeBin`), and the agent
  numbers its events past `max(seqFloor, the file's last seq)` — so a launch
  whose events file is gone cannot restart at seq 1 under the cursor, where
  the reducer would skip every line. The agent removes its `bin/` clones'
  folder on exit.
- **An agent directory lives as long as its attempt's workspace**
  (`machine/internal/agent-dirs-reclaim.ts`, wired in `agent-dirs-job.ts`). A
  reaper that deletes workspaces announces it (`Workspace.Reclaimed`,
  conversations/workspace); this plugin's handler removes those attempts'
  agent directories — their conversations' in this namespace, and the whole
  `<attemptId>/` namespace a worktree's own build launched agents under —
  skipping any whose agent runs (its pid file). The daily main-only
  `runtime-sdk.agent-dirs-reclaim` is the backstop with the same rule
  (workspace not on disk via `Workspace.pathFor`, agent not running), for
  reaps before the announcement or a handler that failed; input `{ dryRun:
  true }` only counts. What the DB cannot place (no conversation or attempt
  row, a namespace that is no attempt) is kept. Never by age: a held task's
  idle agent keeps its directory while its workspace does.
- `server/` — the `conversations_ext_sdk_agent` and `…_stop` side tables, the pure event
  reducer, the launch → options-file mapping.
- Conversations left on the retired tmux runtime were moved by the data
  migration `retire_tmux_rows` (`runtime='sdk'`; a live row hibernated, so its
  next Send resumes it from its transcript).

- `bin/agent.ts` — one detached agent process per conversation: the Agent SDK's
  `query()` in streaming-input mode, commands over its socket, every SDK
  message unchanged as a numbered line of its `events.jsonl`, its pid file, a
  readable log on stdout (`agent.log`, for debugging).
- **The pid file exists exactly while the agent is alive, and one agent runs per
  conversation.** The agent removes it only as it really exits (an `exit`
  listener, or its hard exit just before self-SIGKILL); the backend only after
  killing it. So "alive" is the pid file naming a live pid whose argv carries
  that pid file, never the agent's `exited` line, written before the exit. The
  exit always happens: `process.exit` returning, a 5 s watchdog, or a SIGTERM
  mid-exit run the hard exit, which samples the process (`/usr/bin/sample` →
  `exit-stall-*.txt`), writes `exit_stalled` (reported as
  `SdkAgentExitStalled`), then SIGKILLs the CLI (spawned by the agent via
  `spawnClaudeCodeProcess`, so it holds the handle) and itself. The backend's
  `stopAgent` waits for the process (pid-file watch), not the event, and a kill
  there (`SdkAgentKilled`) or a launch finding a live predecessor
  (`SdkAgentDuplicate`) is reported too. Why:
  [`research/2026-10-21-conversations-sdk-agent-exit-guarantee.md`](../../../../research/2026-10-21-conversations-sdk-agent-exit-guarantee.md).
- `core/protocol.ts` — the wire: commands, replies, event lines, `PROTOCOL_VERSION`.
  An addition an older peer can ignore does not bump the version (an agent
  refuses a `hello` of any other version, so a bump would cut the backend off
  from every running agent); the agent advertises it in `hello` instead.
- **Turn identity.** Every turn carries its turn-ledger row id: `sendTurn`
  sends `{ type: "turn", turnId, text }` and a launch writes `prompt:
  { turnId, text }` into launch.json; the agent echoes the id in the
  `turn_started` it writes when the SDK dequeues the turn, beside the user
  message's uuid (`promptUuid`, the transcript line's uuid) — the turn id's own
  uuid (`transcriptUuidOfTurn`), so a reader holding the id finds the line
  without waiting for the confirmation; a turn without an id gets a fresh one. The reducer turns
  it into a `prompt-submitted { turnId, promptUuid, at }` effect and the
  consumer calls turn-ledger's `confirmTurn` — no text matching; an id the
  ledger does not hold for this conversation is a `turn-unknown-id` report.
  Relaunches (Stop's rewind, an account switch) write `prompt: null`, so a
  confirmed launch prompt is never queued twice. **Temporary**: an agent
  started before turn ids (`hello.turnIds` / `started.turnIds` absent, the
  projection's `turnIds` false) put no id on its launch prompt; its id-less
  `turn_started` is confirmed by EQUAL text (`prompt-submitted-by-text` →
  `resolvePromptSubmit`, the oldest unsettled row whose typed text is the
  prompt). An id-less turn from an agent with `turnIds` is a
  `turn-without-id` report. The fallback, the `turnIds` column and
  launch.json's bare-string `prompt` reading go once no such agent runs (no
  live row with `turn_ids` false) — the last step of
  [`research/2026-10-25-conversations-turn-identity-and-fresh-projection.md`](../../../../research/2026-10-25-conversations-turn-identity-and-fresh-projection.md).
- **Stop answers a uuid, not text.** `stop` interrupts the running turn and,
  when it got no reply, relaunches on the session rewound to before it
  (`rewindRelaunchOptions`), answering `{ returnedPromptUuid }` — the
  projection's `lastPromptUuid`, the transcript line of the turn taken back.
  The conversations server returns the ledger row confirmed as that line and
  hands back the row's own text; the agent's prompt text is never read back.
- **The context window is pushed, never asked.** The agent measures it
  itself (`getContextUsage`, summary detail) once its CLI is ready and after
  every `result` (a compaction ends a turn too), one measure at a time, and
  writes a `context_usage` line (`context_usage_failed` when the measure
  threw). The reducer keeps a batch's latest as a `context-measured` effect,
  which the consumer records with conversations/context-usage's
  `recordContextUsage`; a
  failure is reported (`SdkContextUsageFailed`), a reading that does not parse
  is a malformed event. `conversations.context-usage` reads that row — no
  loader waits on the agent. Why: 2026-11-04, a host under duress starved an
  agent past the 10 s socket bound, and the read that asked it (`hello` +
  `contextUsage`, once a second per open tab) failed as a loader crash every
  time. An agent started before it measured itself reports nothing until its
  next start (the ring says "No reading yet").
- `core/partial.ts` — token streaming: the agent folds the SDK's
  `stream_event`s (`includePartialMessages`) into frames — never written to
  `events.jsonl` — and streams them on `subscribe` connections; the backend
  folds the same frames into the `conversations.partial-message` value.
  Design: [`research/2026-10-20-conversations-token-streaming.md`](../../../../research/2026-10-20-conversations-token-streaming.md);
  every block (thinking, text, tool input) since
  [`research/2026-10-21-conversations-stream-every-block.md`](../../../../research/2026-10-21-conversations-stream-every-block.md).
- `web/` — the health report's Claude Code row: Claude Code (its own verdict,
  with the in-app sign-in from `infra/claude-cli/sign-in` — the row's Sign in
  remedy, the run's panel heading the detail, "Signing in…" while it runs),
  and the agents running here and elsewhere
  (each other worktree as its task's chip, in the expanded detail) and on
  which Claude account (every worktree's, by account name), the
  active Claude account's usage limits as meters, named by the account
  (glance: the week collapsed, the session too expanded; the row is
  `attention` while its limit is reached), the conversations an API error
  stopped (Resume all), and **Manage accounts** — which opens the agent
  manager and its account menu. The row lists no accounts itself.
- The account menu lives in the agent manager's sidebar foot
  (`components/claude-account-foot.tsx`, a `Shell.Sidebar` item placed last
  in `config/shell/sidebar.jsonc`, under the filling conversation list): the
  active account with its weekly quota; open, its session and week meters,
  then the account picker (`components/claude-accounts.tsx`: every account
  with its weekly room, Add account — sign in to another account in the app
  (`AddClaudeAccountSignIn`) or use an API key —, remove / switch,
  auto-switch, auto-resume, a "Continue on …" banner when the active account
  is limited). Its open state is page-wide (`internal/account-menu.ts`) so
  the health row can open it.
- Claude accounts (`infra/claude-cli/accounts` owns the list and the tokens):
  `machine/internal/agent-process.ts` picks the launch account at every agent
  process start (`launchAccount`: the active one, or with auto-switch on and
  its limit reached, the roomiest other — which becomes active) and passes
  `--account <id>`; `bin/agent.ts` fetches that account's token from the
  secrets store itself and gives it to Claude Code only, as
  `CLAUDE_CODE_OAUTH_TOKEN` in the SDK's `env`. A running agent keeps its
  account until its process restarts. Which account a running agent is on is
  read from its pid file (`runningAgentAccount`), never from the stop row's
  `account` copy, which can be stale.
- Usage limits: every agent turn's `rate_limit_event` carries
  `rate_limit_info.unifiedWindows` (`five_hour`, `seven_day`: utilization and
  reset) — not in the SDK's types, so `core/claude-usage.ts` parses it. The
  agent overwrites its account's machine-wide file
  (`state/claude-usage/<accountId>.json`, `--usage-file`; the limits are the
  account's), which `machine/` watches and serves, every account's at once, as
  `runtime-sdk.claude-usage`. `core/usage-limits.ts` reads a report against
  now (limit reached, weekly room, the roomiest account). A window reset since
  the last report shows as such, never as empty.
- Usage limits on demand (`machine/internal/usage-probe.ts`): an SDK session
  that sends no prompt asks Claude Code its `get_usage` control request (what
  `/usage` shows — no model call, ~1 s) under the account's sign-in, and writes
  the same file (`writeClaudeUsageFile`, beside the reader).
  Triggered by `POST /api/claude-usage/refresh` (the account picker, after
  adding or picking an account) and by every fresh Claude Code probe (Check
  again, a launch's re-check) for the active account — signing in as someone
  else changes the system account's limits and announces nothing
  else. A reply without plan limits (an API key, a token without the profile
  scope) is `unavailable`, shown as such, never written. The SDK method is
  experimental (`usage_EXPERIMENTAL_…`): an SDK bump that renames it fails
  tsc. Design: [`research/2026-10-22-conversations-claude-usage-on-demand.md`](../../../../research/2026-10-22-conversations-claude-usage-on-demand.md).

- Which Claude Code: the build the Agent SDK ships (`bundledClaudeBin()`,
  `infra/claude-cli/sdk`), resolved by `startAgentProcess` at every start —
  `claudeBin` in launch.json is never carried over, so a relaunch from an
  options file written for the computer's own `claude` moves onto it. The
  computer's install is never run.
- macOS permission prompts (`machine/internal/named-claude.ts`): with
  disclaim-exec (packages/spawn-disclaim) claude is its own responsible
  process, and a prompt names its executable file. Each start clones
  claude (an APFS clone, packages/process-name) to `<agent dir>/bin/equin · <conv-id> · <title>` and the agent spawns that
  (`namedClaudeBin` in launch.json), so a prompt says which agent asks. TCC
  keys a bundle-less client by path, so each conversation's grants are its
  own; the name is chosen at its first start and kept across relaunches
  (read back from the previous launch.json), re-cloned from the current binary
  when it changed, and removed by the agent on exit (a kept clone would pin a
  replaced binary).

Gotchas the spike hit:

- The socket cannot sit next to `events.jsonl`: a kqueue watch of that
  directory opens every entry, and `open(2)` on a socket fails (EOPNOTSUPP).
- `fs.watch` under bun never reports appends; watch with the file-watcher
  engine (`writesWhileOpen`).
- `canUseTool` must stay set: the SDK warns it is shadowed under
  `bypassPermissions`, but it still fires for AskUserQuestion — and without
  it the CLI removes AskUserQuestion from the tool set.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The health report's Claude Code row: Claude Code itself (critical while the computer is signed out, with the in-app Sign in — claude-cli/sign-in, 'Signing in…' while it runs — and Check again), the agent processes running — here, and in every other worktree (each as its task's chip) — the active Claude account's usage limits as meters (named by the account; the week collapsed, the session too expanded; attention while its limit is reached), the conversations an API error stopped (Resume all), and Manage accounts. The agent manager's sidebar foot: the Claude account new agents launch on with its weekly quota, opening the account menu (its session and week meters; each account's weekly room, add — signing in to another account in the app, or an API key — / remove / switch, auto-switch, auto-resume when a limit resets, Continue on another account when the active one is limited). The sdk runtime's portable half: the conversations_ext_sdk_agent side table (each agent's event cursor and the projection of its events — session id, busy/idle, the open question, the last turn and its rewind anchor — out of the change feed, being the consumer's per-batch checkpoint) and the conversations_ext_sdk_agent_stop side table (the part a live surface reads: the API-error stop and the account, written only when it changes), the pure event reducer, and the mapping of a launch onto the agent's options file; the runtime-sdk.error-stopped collection (active conversations whose agent's turn an API error stopped — a usage limit, a server error, a lost connection — with the CLI's kind of failure); the auto-resume setting (Resume agents when their usage limit resets).
- Web:
  - Contributes:
    - `HealthReport.Row` "Claude Code" → `ClaudeCodeRowDetail`
    - `Shell.Sidebar` "Claude account" → `ClaudeAccountFoot`
    - `ConfigV2.WebRegister` "runtime-sdk-auto-resume"
  - Uses: 56 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×7
    - `infra/claude-cli/availability` ×4
    - `infra/claude-cli/sign-in` ×4
    - `infra/endpoints` ×4
    - `primitives/setup-steps` ×4
    - `config_v2` ×3
    - `primitives/css/meter` ×3
    - `primitives/data-view` ×3
    - `apps-core/tabs` ×2
    - `network/live/live-state` ×2
    - `primitives/avatar` ×2
    - `primitives/css/control-panel` ×2
    - `conversations/conversation-view.conversationPane`
    - `network/live.useLive`
    - `primitives/css/clip.Clip`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.Rigid`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/icon-button.IconButton`
    - `primitives/loading.Loading`
    - `primitives/pane.useOpenPane`
    - `primitives/relative-time.useNow`
    - `primitives/text-editor/inline-chip.renderInlineChip`
    - `shell/health-report.HealthReport`
    - `shell.Shell`
    - `ui/icons.Icon`
- Server:
  - Contributes:
    - `resource.declare` "runtime-sdk.agent-processes"
    - `resource.declare` "runtime-sdk.claude-usage"
    - `resource.declare` "runtime-sdk.error-stopped"
    - `resource.declare` "runtime-sdk.error-stopped:groups"
    - `resource.declare` "runtime-sdk.error-stopped:rows"
    - `change-feed-exclusion` "conversations_ext_sdk_agent"
    - `ConfigV2.Register` "runtime-sdk-auto-resume"
    - `trigger` "runtime-sdk.attempt-ended"
    - `Workspace.Reclaimed` "runtime-sdk.agent-dirs"
    - `report-kind` "sdk-agent-unresponsive"
    - `report-kind` "sdk-catch-up-overdue"
    - `report-kind` "sdk-consumer-stalled"
    - `report-kind` "turn-unknown-id"
    - `report-kind` "turn-without-id"
  - Uses:
    - `config_v2.ConfigV2`
    - `conversations/agent-launch.LAUNCH_CLI_SETTINGS`
    - `conversations/agent-launch.mergeLaunchSettings`
    - `database.db`
    - `database.writeAtomically`
    - `infra/entity-extensions.defineExtension`
    - `network/live.serveCollection`
    - `network/live.ServeCollectionOptions`
    - `network/live/change-feed.ExcludeFromChangeFeed`
    - `tasks/tasks-core._attempts`
    - `tasks/tasks-core._conversations`
    - `tasks/tasks-core._tasks`
  - DB schema: `plugins/conversations/plugins/runtime-sdk/server/internal/tables.ts`
  - Entity extension of:
    - `tasks/tasks-core` (table `conversations_ext_sdk_agent`)
    - `tasks/tasks-core` (table `conversations_ext_sdk_agent_stop`)
  - Resources:
    - `runtime-sdk.agent-processes` (push, notified, whole: one entry per namespace on this machine with a live agent — at most its worktrees, whole: one entry per Claude account on this machine — a handful)
    - `runtime-sdk.claude-usage` (push, notified, whole: one entry per Claude account signed in on this machine — a handful)
    - `runtime-sdk.error-stopped` (keyed, window)
    - `runtime-sdk.error-stopped:groups` (push)
    - `runtime-sdk.error-stopped:rows` (keyed, point)
- Machine:
  - Uses:
    - `conversations/compaction-context.compactionHookEntry`
    - `conversations/question-relay.holdQuestion`
    - `conversations/question-relay.retireQuestion`
    - `conversations/stop-gate.stopGateHookEntry`
    - `infra/claude-cli/accounts.readClaudeAccounts`
    - `infra/claude-cli/accounts.selectClaudeAccountById`
    - `infra/claude-cli/sdk.bundledClaudeBin`
    - `infra/endpoints.implementMachine`
    - `network/live.serveValue`
    - `packages/process-name.cloneNamedBinary`
  - Register:
    - `defineFileWatcher('runtime-sdk.events')`
    - `defineDaemon('runtime-sdk.agent')`
    - `defineJob('runtime-sdk.attempt-ended')`
    - `defineJob('runtime-sdk.auto-resume')`
    - `defineJob('runtime-sdk.agent-dirs-reclaim')`
  - Routes:
    - `POST /api/claude-usage/refresh`
    - `POST /api/runtime-sdk/resume-stopped`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields.nullable`
    - `fields/bool/config.boolField`
    - `fields/date/config.dateField`
    - `fields/text/config.textField`
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveCollection`
    - `network/live.LiveRowsCollection`
    - `network/live.liveValue`
    - `packages/list-bound.wholeList`
    - `packages/list-bound.wholeRecord`
    - `tasks/tasks-core.conversationsEntityRef`
  - Exports (types):
    - `AgentAnswer`
    - `AgentCommand`
    - `AgentEvent`
    - `AgentLaunchIntent`
    - `AgentLaunchOptions`
    - `AgentLaunchPrompt`
    - `AgentLifecycle`
    - `AgentProcesses`
    - `AutoResumePlan`
    - `ClaudeUsage`
    - `ClaudeUsageRead`
    - `ClaudeUsageRefresh`
    - `ClaudeUsageWindow`
    - `CommandReply`
    - `ErrorStoppedConversation`
    - `HelloReply`
    - `LaunchCandidate`
    - `OpenRequest`
    - `PartialFrame`
    - `PartialMessage`
    - `ResumeStoppedResult`
    - `UsageLevel`
    - `UsageWindowId`
    - `UsageWindowView`
    - `WeekRoom`
  - Exports (values):
    - `AGENT_EVENTS_FILE`
    - `AGENT_OPTIONS_FILE`
    - `AgentAnswerSchema`
    - `AgentCommandSchema`
    - `AgentEventSchema`
    - `AgentLaunchOptionsSchema`
    - `AgentLifecycleSchema`
    - `agentPidFileAccount`
    - `agentPidFileText`
    - `AgentProcessesSchema`
    - `API_ERROR`
    - `applyPartialFrame`
    - `AUTO_RESUME_MARGIN_MS`
    - `AUTO_RESUME_RETRY_MS`
    - `autoResumeConfig`
    - `claudeUsage`
    - `claudeUsageFileName`
    - `claudeUsageOf`
    - `claudeUsageOfReply`
    - `ClaudeUsageReadSchema`
    - `ClaudeUsageRefreshSchema`
    - `ClaudeUsageSchema`
    - `CommandReplySchema`
    - `DismissReplySchema`
    - `errorStoppedConversations`
    - `HelloReplySchema`
    - `launchAccount`
    - `limitReached`
    - `OpenRequestSchema`
    - `partialFrameOf`
    - `PartialFrameSchema`
    - `PartialStreamLineSchema`
    - `planAutoResume`
    - `PROTOCOL_VERSION`
    - `refreshClaudeUsage`
    - `RESUME_TURN_TEXT`
    - `resumeStoppedConversations`
    - `ResumeStoppedResultSchema`
    - `roomiestAccount`
    - `sdkAgentProcesses`
    - `stopErrorLabel`
    - `SubscribeReplySchema`
    - `TurnReplySchema`
    - `USAGE_LIMIT_ERROR`
    - `usageLevel`
    - `viewUsageWindow`
    - `weekRoom`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --faint-foreground`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-smd`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/density --space-xsm`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `conversations/conversation-view/jsonl-viewer/api-error`
    - `infra/paths/root-migration`

<!-- AUTOGENERATED:END -->
