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
  SIGKILL when it will not), liveness = the socket answers `hello`, the `events.jsonl` consumer (one file watcher, DB
  cursor, reads rotated generations, reports a seq gap), questions into
  question-relay, and the partial message (`partial-stream.ts`: one
  `subscribe` connection per watched conversation, reconnected when the
  consumer sees the agent's `ready`). `agent-processes.ts` serves
  `runtime-sdk.agent-processes`, the agents running here and in every other
  namespace (one watch of the pid files). `attempt-ended-job.ts` (main
  only): when an attempt's last conversation is closed (`done`), SIGTERMs
  every agent its worktree's backends launched — the conversations an agent
  started in its own build while testing, which nothing else reaps once that
  backend stops (`stopCheckoutAgents`, the one cross-namespace command: by pid,
  never by socket).
- **Every agent path is under the launching backend's namespace**
  (`machine/internal/paths.ts`, which reads `runtimeNamespace()` itself): a
  worktree's DB is a fork of main's, and with paths keyed by conversation id
  alone a worktree backend found main's agents answering and commanded them.
  Layout: `state/sdk-agents/<ns>/<id>/` (launch.json, events.jsonl, agent.log),
  `locks/sdk-agents/<ns>/<id>.pid`, `sockets/agents/<ns>/<id>.sock`.
- `server/` — the `conversations_ext_sdk_agent` side table, the pure event
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
- `core/partial.ts` — token streaming: the agent folds the SDK's
  `stream_event`s (`includePartialMessages`) into frames — never written to
  `events.jsonl` — and streams them on `subscribe` connections; the backend
  folds the same frames into the `conversations.partial-message` value.
  Design: [`research/2026-10-20-conversations-token-streaming.md`](../../../../research/2026-10-20-conversations-token-streaming.md);
  every block (thinking, text, tool input) since
  [`research/2026-10-21-conversations-stream-every-block.md`](../../../../research/2026-10-21-conversations-stream-every-block.md).
- `web/` — the health report's Claude Code row: Claude Code (its own verdict),
  the Agent SDK's version drift, and the agents running here and elsewhere
  (each other worktree as its task's chip, in the expanded detail), the
  active Claude account's usage limits as meters (glance: the week collapsed,
  the session too expanded; the row is `attention` while its limit is
  reached), and the account picker (`components/claude-accounts.tsx`: every
  account with its weekly room, add / remove / switch, auto-switch, a
  "Continue on …" banner when the active account is limited).
- Claude accounts (`infra/claude-cli/accounts` owns the list and the tokens):
  `machine/internal/agent-process.ts` picks the launch account at every agent
  process start (`launchAccount`: the active one, or with auto-switch on and
  its limit reached, the roomiest other — which becomes active) and passes
  `--account <id>`; `bin/agent.ts` fetches that account's token from the
  secrets store itself and gives it to Claude Code only, as
  `CLAUDE_CODE_OAUTH_TOKEN` in the SDK's `env`. A running agent keeps its
  account until its process restarts.
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
  again, a launch's re-check) for the active account — a `claude auth login`
  as someone else changes the system account's limits and announces nothing
  else. A reply without plan limits (an API key, a token without the profile
  scope) is `unavailable`, shown as such, never written. The SDK method is
  experimental (`usage_EXPERIMENTAL_…`): an SDK bump that renames it fails
  tsc. Design: [`research/2026-10-22-conversations-claude-usage-on-demand.md`](../../../../research/2026-10-22-conversations-claude-usage-on-demand.md).

Gotchas the spike hit:

- The socket cannot sit next to `events.jsonl`: a kqueue watch of that
  directory opens every entry, and `open(2)` on a socket fails (EOPNOTSUPP).
- `fs.watch` under bun never reports appends; watch with the file-watcher
  engine (`writesWhileOpen`).
- `canUseTool` must stay set: the SDK warns it is shadowed under
  `bypassPermissions`, but it still fires for AskUserQuestion — and without
  it the CLI removes AskUserQuestion from the tool set.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The health report's Claude Code row: Claude Code itself (critical while missing or signed out, with the install / sign-in commands and Check again), attention when it differs in major.minor from the CLI version the pinned Agent SDK was built for, the agent processes running — here, and in every other worktree (each as its task's chip) — the active Claude account's usage limits as meters (the week collapsed, the session too expanded; attention while its limit is reached), and the Claude account picker (each account's weekly room, add / remove / switch, auto-switch, Continue on another account when the active one is limited). The sdk runtime's portable half: the conversations_ext_sdk_agent side table (each agent's event cursor and the projection of its events — session id, busy/idle, the open question, the last turn and its rewind anchor), the pure event reducer, and the mapping of a launch onto the agent's options file; the runtime-sdk.error-stopped collection (active conversations whose agent's turn an API error stopped — a usage limit, a server error, a lost connection — with the CLI's kind of failure).
- Web:
  - Contributes: `HealthReport.Row` "Claude Code" → `ClaudeCodeRowDetail`
  - Uses: 37 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/claude-cli/availability` ×4
    - `infra/endpoints` ×4
    - `primitives/css/ui-kit` ×4
    - `primitives/setup-steps` ×4
    - `primitives/data-view` ×3
    - `conversations/conversation-view.conversationPane`
    - `network/live.useLive`
    - `primitives/avatar.Avatar`
    - `primitives/css/clip.Clip`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.Rigid`
    - `primitives/css/row.Row`
    - `primitives/css/spacing.Stack`
    - `primitives/css/switch.Switch`
    - `primitives/css/text.Text`
    - `primitives/icon-button.IconButton`
    - `primitives/live-state.combineResources`
    - `primitives/pane.useOpenPane`
    - `primitives/relative-time.useNow`
    - `primitives/text-editor/inline-chip.renderInlineChip`
    - `shell/health-report.HealthReport`
    - `ui/icons.Icon`
- Server:
  - Contributes:
    - `resource.declare` "runtime-sdk.agent-processes"
    - `resource.declare` "runtime-sdk.bundled-cli"
    - `resource.declare` "runtime-sdk.claude-usage"
    - `resource.declare` "runtime-sdk.error-stopped"
    - `resource.declare` "runtime-sdk.error-stopped:groups"
    - `resource.declare` "runtime-sdk.error-stopped:rows"
    - `trigger` "runtime-sdk.attempt-ended"
  - Uses:
    - `conversations/agent-launch.LAUNCH_CLI_SETTINGS`
    - `conversations/agent-launch.mergeLaunchSettings`
    - `database.db`
    - `infra/entity-extensions.defineExtension`
    - `network/live.serveCollection`
    - `network/live.ServeCollectionOptions`
    - `tasks/tasks-core._conversations`
  - DB schema: `plugins/conversations/plugins/runtime-sdk/server/internal/tables.ts`
  - Entity extension of: `tasks/tasks-core` (table `conversations_ext_sdk_agent`)
  - Resources:
    - `runtime-sdk.agent-processes` (push, notified)
    - `runtime-sdk.bundled-cli` (push, fixed)
    - `runtime-sdk.claude-usage` (push, notified)
    - `runtime-sdk.error-stopped` (keyed, window)
    - `runtime-sdk.error-stopped:groups` (push)
    - `runtime-sdk.error-stopped:rows` (keyed, point)
- Machine:
  - Uses:
    - `conversations/question-relay.holdQuestion`
    - `conversations/question-relay.retireQuestion`
    - `infra/claude-cli/accounts.readClaudeAccounts`
    - `infra/claude-cli/accounts.selectClaudeAccountById`
    - `infra/endpoints.implementMachine`
    - `network/live.serveValue`
  - Register:
    - `defineFileWatcher('runtime-sdk.events')`
    - `defineDaemon('runtime-sdk.agent')`
    - `defineJob('runtime-sdk.attempt-ended')`
  - Routes:
    - `POST /api/claude-usage/refresh`
    - `POST /api/runtime-sdk/resume-stopped`
- Core:
  - Uses:
    - `fields.nullable`
    - `fields/date/config.dateField`
    - `fields/text/config.textField`
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveCollection`
    - `network/live.LiveRowsCollection`
    - `network/live.liveValue`
    - `tasks/tasks-core.conversationsEntityRef`
  - Exports (types):
    - `AgentAnswer`
    - `AgentCommand`
    - `AgentEvent`
    - `AgentLaunchOptions`
    - `AgentLifecycle`
    - `AgentProcesses`
    - `ClaudeUsage`
    - `ClaudeUsageRead`
    - `ClaudeUsageRefresh`
    - `ClaudeUsageWindow`
    - `CommandReply`
    - `ErrorStoppedConversation`
    - `HelloReply`
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
    - `AgentProcessesSchema`
    - `API_ERROR`
    - `applyPartialFrame`
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
    - `PROTOCOL_VERSION`
    - `refreshClaudeUsage`
    - `RESUME_TURN_TEXT`
    - `resumeStoppedConversations`
    - `ResumeStoppedResultSchema`
    - `roomiestAccount`
    - `sameMajorMinor`
    - `sdkAgentProcesses`
    - `sdkBundledCli`
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
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --input`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`

<!-- AUTOGENERATED:END -->
