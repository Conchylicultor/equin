# conversations

## Status reconciliation

`server/internal/status-reconciler.ts` keeps each row's `status` /
`waitingFor` / session id in step with its runtime, from push signals plus the
per-minute `conversations.status-sweep` backstop (`reconcileAll`); the decision
is the pure `planConversationUpdate` (`plan-update.ts`).

- `ConversationRuntime.inspect` / `list` answer per conversation
  `{ kind: "live", info }` or `{ kind: "unverified", reason }` (the agent is up
  but the runtime cannot vouch for its state — the sdk runtime's projection is
  behind the agent's own `hello.seq` even after a bounded catch-up). A
  runtime that throws makes all its conversations unknown.
- Unknown (either way) never plans from the stale state: `status` stays the
  last KNOWN one and the row gets `statusUnverifiedSince` (first time kept);
  the next reconcile that can check (live or absent) clears it, `gone` /
  `done` writes clear it too. A whole-runtime failure marks as well — the
  status really is unverified — and is cleared by the next answering
  reconcile (a signal, or the sweep within a minute), so it cannot flap
  faster than reconciles run.
- Readers: `convStatusDot(conv)` (conversation-ui/item) takes the row, so no
  dot can paint an unverified status as fact; the header status chip shows
  "Unknown" (tooltip: since when, last known status); the transcript foot says
  "Status unknown" instead of the quiet idle foot.
  Design: [`research/2026-10-25-conversations-turn-identity-and-fresh-projection.md`](../../research/2026-10-25-conversations-turn-identity-and-fresh-projection.md) (B3/B4).
- **A row is classified only by the database that created it**
  (`isOwnConversation`: created after `databaseForkedAt()`, or the database was
  never forked) — never by namespace. A worktree's fork holds copies of main's
  rows, whose agents it cannot see, and leaves them alone; the conversations it
  launched itself it hibernates / settles / sweeps like main does its own. The
  turn-emitter follows the same rule.
- **A `starting` row with no session is decided by whether its launch is
  still coming, never by its age.** Two facts, read before the runtimes are
  asked: its `conversations.spawn` job is in flight (`inFlight`: a queue row
  or a pending wait, in one read — `infra/jobs`), or an inline launch (fork,
  resume, rewind, hibernation resume — `inline-launch.ts`) is running in this
  backend, held from before the row turns `starting` / is stamped
  `resumingSince` until its create settled — or held at any point since the
  mark the reconcile took before reading its rows (a launch that settled in
  between may have rewritten the row it read). Neither → the launch is not
  coming: gone (or hibernated, when there is a session to resume). The 30 s
  `STARTING_TIMEOUT_MS` this replaced called launches waiting on their checkout
  "Couldn't start" (2026-11-04 12:24Z / 12:52Z).
- **A spawn holds its row `starting` until it hands it over — with or
  without a session.** The spawn starts its agent as soon as the workspace's
  files exist (`WorkspacePrepareCtx.filesReady`: a checkout's files, before
  its install), so Claude Code's startup overlaps the rest of `prepare`. While
  the spawn is in flight a live agent does not move the row (`planLive`), so
  every turn is held (turn-ledger's `isComingUp`) and no tool call can run
  guards against a half-installed checkout. Once `prepare` returned the spawn
  types the oldest held turn — the launch prompt — into the agent
  (`typeLaunchTurn`), then hands the row over (`spawn-handover.ts`: an
  in-process mark that takes it out of `spawnInFlight` before the queue
  completes the run) and asks for a reconcile, which flips it live and
  flushes whatever else was held. A spawn that dies for good stops the agent
  it started before anything else (`onDead`): left running, the reconcile
  would take it up as live and flush the held prompt into a workspace that
  never got ready.
- **A spawn's end is announced, not discovered.** `conversations.spawn`'s
  `onDead` (`infra/jobs`) fires once its run will never come — last attempt
  failed, worker killed on the last attempt, the wake-up from its checkout
  wait dead-lettered, or the row cancelled. It records the launch as failed
  (`spawn-failure`; step `job` when no step of the body saw it end) and asks
  for a reconcile of that row, which no longer counts the run in flight and
  moves it to `gone` with the failure shown. A wait whose wake-up died no
  longer reads as "still coming" either way (`keysInFlight` checks the
  waker). `spawn-dead-letter.test.ts` drives it end to end.
- **A closed conversation's agent is stopped, whoever failed to.** The stop
  is derived from the close: `markConversationClosed` (the only `done` write)
  commits the row and `conversation.statusChanged` in one transaction, which
  queues close's `conversations.teardown-closed` stop in that same commit.
  Before, the event was emitted after the commit — and on 2026-11-08 (main
  crash-looping every ~10 s) exit_clean's finalize died on a killed `git log`
  three times, the row was then closed by a backend that crashed a second
  later, and nothing stopped conv-1794151725-hdw3rp's agent for ten days.
  `done` rows are never planned (a close is final) and not even read by the
  sweep, so the backstop is explicit: the minute sweep (`stopAgentsOfClosed`)
  takes every agent the runtimes' `list()` answered that no active row
  claims; one whose row is this database's own `done` row, closed over a
  minute ago (`CLOSE_STOP_GRACE_MS`: the close's own stop is bounded at 15 s)
  and with no inline launch since the reconcile's mark (a resume turns the
  row `starting` first), is stopped through its runtime and reported as
  `AgentOutlivedClose`.
- A live agent is `working` while it holds a turn-ledger turn it has not
  started (`typing` / `typed`) — but only for `STUCK_TURN_MS` once the runtime
  says it is at rest: past that it is **stuck** (`waiting`, `waitingFor:
  "stuck-turn"`, a `conversation-stuck-turn` report), never `working` forever
  on a Claude Code wedged while alive. See turn-ledger's CLAUDE.md.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Conversation domain: shared hooks and client-side API. Conversation domain: shared server code and types; view plugins live under `plugins/`.
- Load-bearing: yes
- Server:
  - Contributes:
    - `trigger` "conversations.notify-created"
    - `trigger` "conversations.turn-emitter.reconcile"
    - `trigger` "conversations.turn-emitter.reconcile"
    - `trigger` "tasks.maybe-launch-on-armed"
    - `trigger` "tasks.maybe-launch-on-status"
    - `report-kind` "auto-start-model-unavailable"
    - `report-kind` "claude-code-unavailable-at-spawn"
    - `report-kind` "conversation-spawn-failed"
    - `report-kind` "conversation-stuck-turn"
    - `report-kind` "held-turn-undelivered"
    - `resource.declare` "conversations.partial-message"
  - Uses: 92 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `tasks/tasks-core` ×27
    - `conversations/turn-ledger` ×15
    - `conversations/transcript-watcher` ×8
    - `conversations/conversation-preprompt` ×3
    - `conversations/spawn-failure` ×3
    - `conversations/workspace` ×3
    - `infra/claude-cli/availability` ×3
    - `tasks/auto-start` ×3
    - `conversations/launch-timeline` ×2
    - `database` ×2
    - `infra/endpoints` ×2
    - `infra/events` ×2
    - `infra/jobs` ×2
    - `reports` ×2
    - `conversations/model-provider/catalog.getModelCatalog`
    - `conversations/preprompts.resolvePrepromptItem`
    - `conversations/session-chain.recordSessionId`
    - `conversations/system-prompt/composer.composeSystemPromptAppend`
    - `conversations/workspace/launch-option.getTaskWorkspace`
    - `database/fork-point.databaseForkedAt`
    - `infra/attachments.getAttachment`
    - `infra/host/machine-sleep.sleptDuring`
    - `infra/paths.claudeTranscriptPath`
    - `infra/warmup.defineWarmup`
    - `reports/engine.recordReport`
    - `shell/notifications.recordNotification`
    - `tasks/task-category.setTaskCategory`
    - `tasks/task-effort.getTaskEffort`
    - `tasks/task-preprompt.getTaskPreprompt`
  - DB schema: `plugins/conversations/server/internal/tables-turn-completed-event.ts`
  - Exports (types):
    - `ConversationRuntime`
    - `ConversationTurnCompletedPayload`
    - `IfAlreadyStarted`
    - `LaunchTaskNowResult`
    - `OutgoingTurn`
    - `QuestionHold`
    - `QuestionHoldSource`
    - `RunningAccount`
    - `RuntimeInfo`
    - `RuntimeInspection`
    - `RuntimeSignal`
    - `SubmitOutcome`
    - `Turn`
    - `TurnSubmission`
  - Exports (values):
    - `afterTurn`
    - `conversationRunningAccount`
    - `conversationRunningAccountSince`
    - `conversationTurnCompleted`
    - `createConversation`
    - `deleteConversation`
    - `ensureResumed`
    - `getConversationRow`
    - `interruptConversation`
    - `launchTaskNow`
    - `maybeLaunchTaskJob`
    - `previewRewind`
    - `QuestionHolds`
    - `readConversationTurns`
    - `requestStatusReconcile`
    - `resolvePromptAttachments`
    - `ResumeBlockedError`
    - `resumeConversation`
    - `retryLaunch`
    - `rewindConversationAt`
    - `Runtime`
    - `submitTurn`
    - `TranscriptCutError`
  - Register:
    - `defineJob('tasks.maybe-launch')`
    - `defineJob('tasks.maybe-launch-on-status')`
    - `defineJob('tasks.maybe-launch-on-armed')`
    - `defineJob('conversations.notify-created')`
    - `defineJob('conversations.turn-emitter.reconcile')`
    - `defineWarmup('conversations.turn-emitter-replay')`
    - `defineJob('conversations.spawn')`
    - `defineJob('conversations.deliver-held-turns')`
    - `defineTriggerEvent('conversation.turn-completed')`
    - `defineJob('conversations.status-sweep')`
  - Resources: `conversations.partial-message` (push, notified, whole: one model turn's content blocks, held only while it streams)
  - Routes:
    - `GET /api/conversations`
    - `GET /api/conversations/:id`
    - `DELETE /api/conversations`
    - `GET /api/conversations/:id/turns`
- Web:
  - Uses:
    - `network/live.LiveRowResult`
    - `network/live.mapRow`
    - `network/live.rowOrStale`
    - `network/live.useLive`
    - `network/live/live-state.foldResource`
    - `network/live/live-state.mapResource`
    - `network/live/live-state.ResourceResult`
    - `network/live/live-state.useCombinedResources`
    - `primitives/file-links.FileLinksWorkspaceProvider`
  - Exports (values):
    - `ConversationFileLinks`
    - `useActiveConversations`
    - `useConversation`
    - `useConversationById`
    - `useConversations`
    - `useConversationTitleBySlug`
    - `useHasActiveSiblingInWorktree`
    - `useHasActiveSiblings`
    - `useLiveConversation`
- Machine:
  - Uses:
    - `infra/endpoints.implementMachine`
    - `network/live.serveValue`
  - Routes:
    - `POST /api/conversations`
    - `POST /api/conversations/:id/turn`
    - `POST /api/conversations/:id/turns/:turnId/retry`
    - `POST /api/conversations/:id/turns/:turnId/withdraw`
    - `POST /api/conversations/:id/interrupt`
    - `POST /api/conversations/:id/stop`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `conversations/model-provider.ModelChoiceSchema`
    - `conversations/runtime-catalog.ConversationRuntimeIdSchema`
    - `conversations/turn-ledger.turnIdKind`
    - `conversations/turn-ledger.TurnStateSchema`
    - `conversations/workspace.WorkspaceSpecSchema`
    - `fields/bool/config.boolField`
    - `fields/int/config.intField`
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
    - `packages/list-bound.wholeList`
    - `primitives/pane.defineRoute`
    - `primitives/text-editor/paste-images.attachmentFileMarkdown`
    - `primitives/text-editor/paste-images.attachmentMarkdown`
    - `tasks/tasks-core.ConversationSchema`
  - Exports (types):
    - `BackgroundWork`
    - `ConversationEntry`
    - `CreateConversationBody`
    - `CutLosses`
    - `CutRefusal`
    - `DeleteConversationQuery`
    - `ListTurnsQuery`
    - `PartialBlock`
    - `PartialMessage`
    - `PostTurnBody`
    - `ResumeBlocked`
    - `ResumeBlockedReason`
    - `ResumeOutcome`
    - `RewindOutcome`
    - `RewindPreview`
    - `RewindRefusal`
  - Exports (values):
    - `attachmentDiskRef`
    - `attachmentImagePathsOf`
    - `attachmentRefsOf`
    - `BackgroundWorkSchema`
    - `canSendTurn`
    - `closeConversation`
    - `conversationPartialMessage`
    - `conversationRoute`
    - `CONVERSATIONS_CATEGORY_ID`
    - `createConversation`
    - `CreateConversationBodySchema`
    - `CutLossesSchema`
    - `CutRefusalSchema`
    - `deleteConversation`
    - `DeleteConversationQuerySchema`
    - `getConversation`
    - `hasLiveProcess`
    - `hibernationConfig`
    - `interruptConversationTurn`
    - `isActiveStatus`
    - `isAgentBusy`
    - `isAttachmentDiskPath`
    - `isTurnRunning`
    - `listConversations`
    - `listConversationTurns`
    - `ListTurnsQuerySchema`
    - `PartialBlockSchema`
    - `PartialMessageSchema`
    - `postConversationTurn`
    - `PostTurnBodySchema`
    - `QUESTION_WAITING_FOR`
    - `ResumeBlockedReasonSchema`
    - `ResumeOutcomeSchema`
    - `retryConversationTurn`
    - `RewindOutcomeSchema`
    - `RewindPreviewSchema`
    - `RewindRefusalSchema`
    - `stopConversation`
    - `STUCK_TURN_WAITING_FOR`
    - `SYSTEM_CATEGORY_ID`
    - `withdrawConversationTurn`
- Cross-plugin:
  - Imported by: 90 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `conversations` ×61
    - `tasks` ×10
    - `apps` ×6
    - `infra` ×3
    - `review` ×3
    - `active-data` ×2
    - `debug/profiling/ops`
    - `hints/ask`
    - `page/annotations/agent-notes/agent-page`
    - `primitives/launch`
    - `upstream`
  - Endpoint callers:
    - `close`
    - `compaction-context`
    - `rename`
    - `stop-gate`
    - `transcript-api`
- Exemptions:
  - Exempts itself from:
    - `ids:pk-declared` — `server/internal/tables-turn-completed-event.ts` (debt)
    - `boundaries/no-platform-api` — `server/internal/lifecycle.ts`, `server/internal/locate-cut.ts`, `server/internal/status-reconciler.ts` (debt)
- Sub-plugins:
  - **`agent-launch`** — What every app-launched agent starts with, whatever runtime hosts it: the agent process's allowlisted environment (the env -i wrapper, the values it delivers, its PATH and login shell…
  - **`agent-thread`** [exempt] — Agent thread: the embedded conversation view apps host for the background agents they start — <AgentThread> (user bubbles, the agent's tool calls as a live step list labelled through the…
  - **`agents`** [exempt] — Named agent definitions that launch conversations. Named agent definitions that launch conversations: the agents roster and launches (tables, live collections, CRUD and move routes), portable; the…
  - **`all-conversations`** — All-conversations app pane: a live DataView over the `conversations.all.v2` collection (filter/sort/search over every conversation, kept fresh by the routed change feed) reachable from the…
  - **`automatic-turn`** — Whether the app may type an automatic turn into a conversation now: automaticTurnReadiness(conversationId, { own? }) — held while the agent is busy, waits on the user (waitingFor), or another…
  - **`before-after`** — Before / after pairs in the browser: registers the ba id kind; draws a register_before_after call as its tool row with a swipe preview of the pair under it (read back by tool-use id; Open in pane)…
  - **`close`** — Closing a conversation, portable half: POST /api/conversations/:id/close marks it done on every host (markConversationClosed) — the demo's in-browser server included — then runs every CloseTeardown…
  - **`commit-conversation`** — The commit row action that opens the conversation which wrote a commit (its conversation trailer) in a new browser tab.
  - **`compaction-context`** [exempt] [1 sub-plugin] — The compaction-context backend: the CompactionContext contribution (a plugin's restore — re-record what the compacted agent no longer holds, return the text to hand back; a `whole` part is never…
  - **`companion-status`** — The agents' part of every companion's status line (Companion.Status 'agents' — the menu-bar tray's header, later the browser extension's): from useConversations(), partitioned like the agent…
  - **`context-usage`** — Each conversation's last context reading — what fills its agent's context window, as the harness measured it — in the conversations_ext_context_usage table: recordContextUsage, which a conversation…
  - **`conversation-category`** [exempt] — Per-conversation categories: the sidebar row avatar painted from the category chosen for it. Auto-classified by Haiku after each turn. The conversation-category assignments, portable half: the…
  - **`conversation-preprompt`** — Header chip showing the preprompt the conversation's task was launched with; a popover reveals the full instruction text. Sidebar rows show the preprompt's icon (resolved live from the library, with…
  - **`conversation-progress`** [exempt] — 4-step progress bar (started → designed → implemented → pushed) in the conversation toolbar and sidebar chip. Tracks each conversation through four phases (research → design → implementation →…
  - **`conversation-ui`** [3 sub-plugins] — Umbrella for visual primitives that render a Conversation. Sub-plugins ship the actual components (item rows/chips, future cards/mentions/etc.).
  - **`conversation-view`** [exempt] [139 sub-plugins] — Conversation pane host. The header is the pane's own Actions slot (title plus chips); the prompt bar is slot-driven.
  - **`conversations-view`** [5 sub-plugins] — Sidebar list of all conversations.
  - **`effort-provider`** — Registry mapping thinking-mode (effort) levels to Claude CLI delivery (--effort flag / --settings ultracode) and display metadata. Reusable EffortSelect picker.
  - **`hibernation`** — Records conversation selection so idle hibernation can reset the idle timer and transparently resume. Idle-conversation hibernation, portable half: the global hibernation config, and the viewed…
  - **`idle-blocker`** — Idle blocker `agents`: any conversation starting or working (isAgentBusy) keeps the host busy; every conversation.statusChanged that crosses that line asks the idle signal to re-evaluate.
  - **`launch-timeline`** — Agent launches in Debug → Profiling: per-stretch p50 / p90 of the newest launch records (request → spawn → checkout child start, boot, checkout → agent started → CLI ready → first token → first…
  - **`model-provider`** [exempt] [2 sub-plugins] — Model pickers and labels over the live model catalog: useModelCatalog (the pushed, preloaded catalog), useVisibleModels / useModelItems / ModelSelect / ModelChoiceLabel (families with today's…
  - **`pane-restore`** — Saves and restores the pane route per conversation in the budgeted web storage.
  - **`preprompts`** — Settings library of system-prompt snippets and a reusable picker for selecting a task's preprompt. Library of named instruction snippets added to a task's agent system prompt, after Claude Code's…
  - **`prompt-snippets`** — Named prompt snippets ({ title, prompt }) edited in place inside the popup that lists them: SnippetEditor (a name and a prompt, Add / Save / Delete / Cancel, holding its popup open) and…
  - **`question-relay`** — Answers a held AskUserQuestion from the web: owns the transcript's `"question"` pending prompt — the held question's form, answered as the tool's real result. The AskUserQuestion relay's backend…
  - **`recover`** [exempt] — Sidebar entry + pane listing recently-closed conversations with restore buttons.
  - **`rename`** — Rename a conversation by hand: RenameConversationAction, the item action a conversation list contributes to its rows (the sidebar's Queue and History, in the row's ⋯ menu), opening a dialog that…
  - **`runtime-catalog`**
  - **`runtime-sdk`** [exempt] — The health report's Claude Code row: Claude Code itself (critical while the computer is signed out, with the in-app Sign in — claude-cli/sign-in, 'Signing in…' while it runs — and Check again), the…
  - **`self-compact`** [1 sub-plugin] — An agent compacting its own context: the compact_context MCP tool (granted by context.compact) records the request in conversation_compactions; when the agent can take an automatic turn…
  - **`session-chain`** — Registers the session-chain row id kind (sess) with the web id registry — the server barrel registers the same kind. Append-only mapping of a conversation to the ordered Claude session ids it has…
  - **`spawn-failure`** — Per-conversation spawn failure: the latest error of a conversation's spawn job (the failed step and its message), stored in conversations_ext_spawn_failure by the job on every failed attempt and…
  - **`stop-gate`** [exempt] — The stop-gate backend: the StopGate contribution (a plugin's check(conversationId) — block the agent's stop while it still owes the plugin something, with the reason it reads) and the StopWaiver…
  - **`summary`** — Toolbar button that opens a side pane with the Summarise action and the latest structured Sonnet summary (phase, flags, next action). On-demand structured summaries of conversations: phase, flags…
  - **`system-prompt`** [1 sub-plugin] — What equin appends to an agent's system prompt: the SystemPrompt.Section contribution — a plugin's context about this agent and its task (mandate, global page instructions, task tree), rendered at…
  - **`task-categories`** — The task categories a conversation's own task is filed under (Conversations, System), registered from a portable barrel so every host labels them — the browser host included, which does not boot the…
  - **`transcript-api`** — Agent API: GET /api/conversations/:id/transcript returns the ordered on-disk JSONL paths of a conversation's Claude session chain.
  - **`transcript-retention`** [exempt] — Keeps retained conversations' Claude session JSONL alive by refreshing their mtime daily — active rows plus every conversation of a held task — so Claude Code's cleanupPeriodDays sweep never deletes…
  - **`transcript-source`** [1 sub-plugin] — A conversation's transcript as a host service: TranscriptSource (its events, a signature that moves with them, and a watch), with the Claude Code JSONL parser every provider runs. The desktop's…
  - **`transcript-watcher`** [exempt] — Foreign-session report renderer: a one-line Debug, Reports summary for the conversation-foreign-session kind — which conversation holds a session id that belongs to another, and how it was seen.…
  - **`turn-ledger`** [exempt] — Registers the turn id kind (turn) with the web id registry — the server barrel registers the same kind. The turn ledger's backend: the conversation_turns table (one row per turn sent to an agent…
  - **`usage`** — Cost, Tokens and Agents fields on every conversation list whose rows are conversations (the usage extension's exposed fields), sorting and filtering server-side. Per-conversation usage — cost…
  - **`workspace`** [test helpers] [exempt] [3 sub-plugins] — Workspace web presence: eagerly registers the boot-preloaded workspace.catalog live value (every workspace a task can name) so boot-snapshot can hydrate it before first paint. Agent workspaces…

<!-- AUTOGENERATED:END -->
