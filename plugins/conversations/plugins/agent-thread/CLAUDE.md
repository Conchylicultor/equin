# agent-thread

The embedded conversation view: a conversation an app started on the user's
behalf, shown inside the app's own surface as a thread. Design: the Singularity
page "Embedded conversation view" (block-b8192e78-a010-421e-8443-c7d0ba327b3c).

A run is an ordinary conversation (launched under a scratch profile, in the
host's task category). There is no table of its own: the thread is a fold over
the live transcript, so it and the Agent Manager can never disagree.

## Results — `defineThreadResult({ tool, schema })` (core)

A result kind is an MCP tool the host's profile reserves plus the zod schema of
its input, declared once in the host's `core/`: the server registers the tool
with `schema` as its input schema (a bad payload goes back to the agent as the
tool's error), the web parses an accepted call's input with it. `tool` is the
tool's OWN name (`places_show_picks`) — calls are matched by it whatever MCP
server serves them (`mcp__<server>__<tool>`); a transcript name throws.

## Turns — `groupThread(events, results, conversation)` (core, pure)

- A turn opens at each `user-text` of the transcript as rendered
  (`useVisibleEvents`); the harness context before the first belongs to none.
- Each `tool-call` is a **step** (`running` / `done` / `error`) — unless it is a
  call of a result tool the tool **accepted**, which makes it a **result**
  (`accepted`, typed by its kind; or `invalid` when its input no longer parses
  under the schema — a state, never a guessed payload). A call the tool refused
  stays a step, drawn red. A later result of one kind replaces the earlier one
  in the same turn.
- `answer` is the turn's last non-blank assistant text.
- Only the newest turn can be `running`: while the conversation is starting,
  working, or waiting on the user mid-turn (`waitingFor`). Every other turn is
  `done` with an answer or a result, `failed` with neither. A step still
  without a result in a turn that is over is `error` (stopped, or died).

`threadProgressOf` / `threadStateOf` (core) derive what a header or a host's
pill says: `working` / `waiting` (a question or menu) / `done` / `failed`, the
newest turn's finished steps, its running step, its accepted results, and
`unseen` — the newest answer or result is later than the row's `lastViewedAt`.

## Web

- `<AgentThread conversationId results renderResult placeholder? />` — the live
  thread; fills its container (the host owns the frame). Status is
  `useOptimisticConversationStatus`; the composer's draft is the conversation's
  own prompt draft (`CONVERSATION_PROMPT_DRAFT_KEY`, shared with the Agent
  Manager and with Copy to draft); every turn goes through
  `sendConversationTurn`; an ended conversation (`gone` / `done`) is resumed
  (`resumeConversationEndpoint`) and the turn sent once it is back; Stop while
  working (its rewound text goes back to the draft). A pending question mounts
  the `JsonlViewer.PendingPrompt` dispatch; sent turns show as
  `PendingTurnCard`s.
- `AgentThreadView` — the same look over given turns, every live part handed
  in. The exhibits render it.
- `AgentThreadSlots.StepLabel` — dispatch on the tool's own name; the host
  labels its tools. This plugin labels the common built-ins (Read, Write, Edit,
  Bash, WebSearch, WebFetch, Grep, Glob, ToolSearch, TodoWrite,
  AskUserQuestion, Agent/Task); the fallback is the tool name and a one-line
  input summary. `<StepLabel step>` renders one for a host's own surface.
- `useThreadTurns` / `useThreadProgress` / `useLatestResult` — the same fold for
  a host's other surfaces (the pill, map pins). Each is a `ResourceResult`
  (loading until the row and the transcript are in; a ready `null` when no such
  conversation exists).

## Starting and restoring runs

- `useStartThread({ profile, categoryId, model }).start({ title, prompt, input })`
  — files a task under the host's category and launches it now (`launchTask`)
  with the workspace option set to the host's scratch profile and the model on
  the auto-start option; nothing opens. Answers the `MachineResult` with the
  conversation id. A thread agent's profile should not list `exit_clean`: the
  agent ends its turn instead, so the user can keep replying.
- `threadRuns` (core) / `useThreadRuns(profile)` (web) — the recent
  conversations launched under a scratch profile, newest first (default 20,
  max 100), for a host to restore its latest run after a reload. The profile
  is read from `attempts.workspace`; no index backs that filter yet.

### Marking viewed

`AgentThread` calls `useMarkConversationViewed` only while the thread is on
screen (page visible) AND has an answer or result newer than `lastViewedAt`.
The hook does two things: stamps `lastViewedAt` (which also resets the idle
hibernation timer) and, when the row's `hibernatedAt` is set, transparently
resumes the conversation (a desktop-only endpoint). The
"only when unseen" gate keeps a host that restores its latest run on load from
waking a hibernated agent with nothing new to show. A refused resume is a toast.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Agent thread: the embedded conversation view apps host for the background agents they start — <AgentThread> (user bubbles, the agent's tool calls as a live step list labelled through the AgentThreadSlots.StepLabel dispatch, its answer, the host's own result cards, a composer that resumes an ended conversation), the hooks a host's other surfaces read (useThreadTurns, useThreadProgress, useLatestResult), generic step labels for the common built-in tools, and useThreadRuns (a host's recent runs under its scratch profile). Serves `agent-thread.runs` — the recent conversations launched in a scratch workspace, newest first, filterable by profile — over `_conversations` with the attempt joined (routed: a conversation write refills its own row).
- Web:
  - Slots: `AgentThreadSlots.StepLabel`
  - Slot contributors: `AgentThreadSlots.StepLabel` ← `conversations.agent-thread`
  - Contributes:
    - `AgentThreadSlots.StepLabel` "Read" → `PathStepLabel`
    - `AgentThreadSlots.StepLabel` "Write" → `PathStepLabel`
    - `AgentThreadSlots.StepLabel` "Edit" → `PathStepLabel`
    - `AgentThreadSlots.StepLabel` "Bash" → `BashStepLabel`
    - `AgentThreadSlots.StepLabel` "WebSearch" → `WebSearchStepLabel`
    - `AgentThreadSlots.StepLabel` "WebFetch" → `WebFetchStepLabel`
    - `AgentThreadSlots.StepLabel` "Grep" → `GrepStepLabel`
    - `AgentThreadSlots.StepLabel` "Glob" → `GlobStepLabel`
    - `AgentThreadSlots.StepLabel` "ToolSearch" → `ToolSearchStepLabel`
    - `AgentThreadSlots.StepLabel` "TodoWrite" → `TodoWriteStepLabel`
    - `AgentThreadSlots.StepLabel` "AskUserQuestion" → `AskUserQuestionStepLabel`
    - `AgentThreadSlots.StepLabel` "^(Agent|Task)$" → `AgentStepLabel`
  - Uses: 56 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `conversations/conversation-view/pending-turn` ×7
    - `primitives/live-state` ×6
    - `conversations/conversation-view/jsonl-viewer` ×3
    - `conversations/conversation-view/user-message` ×2
    - `conversations/conversation-view` ×2
    - `infra/endpoints` ×2
    - `primitives/css/status-dot` ×2
    - `primitives/css/ui-kit` ×2
    - `primitives/dom/auto-scroll` ×2
    - `primitives/slot-render` ×2
    - `conversations/conversation-view/jsonl-viewer/tool-call.ToolNameLabel`
    - `conversations/hibernation.useMarkConversationViewed`
    - `conversations.useConversation`
    - `network/live.useLive`
    - `primitives/collapsible.FoldMotion`
    - `primitives/css/bouncing-dots.BouncingDots`
    - `primitives/css/center.Center`
    - `primitives/css/column.Column`
    - `primitives/css/fill.Fill`
    - `primitives/css/grow.growClass`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Stack`
    - `primitives/css/spinner.Spinner`
    - `primitives/css/text.Text`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/launch.useTaskLaunch`
    - `primitives/loading.Loading`
    - `primitives/markdown.Markdown`
    - `primitives/pane.useOpenPane`
    - `primitives/persistent-draft.useDraft`
    - `primitives/text-editor.TextEditor`
    - `shell/toast.showToast`
    - `ui/icons.Icon`
  - Exports (types):
    - `AgentThreadProps`
    - `AgentThreadViewProps`
    - `RenderThreadResult`
    - `StartThreadOptions`
    - `StartThreadRequest`
    - `StartThreadResult`
    - `StepLabelContribution`
    - `StepLabelProps`
    - `ThreadSnapshot`
  - Exports (values):
    - `AgentThread`
    - `AgentThreadSlots`
    - `AgentThreadView`
    - `StepLabel`
    - `useLatestResult`
    - `useStartThread`
    - `useThread`
    - `useThreadProgress`
    - `useThreadRuns`
    - `useThreadTurns`
- Server:
  - Contributes:
    - `resource.declare` "agent-thread.runs"
    - `resource.declare` "agent-thread.runs:groups"
    - `resource.declare` "agent-thread.runs:rows"
  - Uses:
    - `network/live.serveCollection`
    - `network/live.ServeCollectionOptions`
    - `tasks/tasks-core._attempts`
    - `tasks/tasks-core._conversations`
  - Resources:
    - `agent-thread.runs` (keyed, window)
    - `agent-thread.runs:groups` (push)
    - `agent-thread.runs:rows` (keyed, point)
- Core:
  - Uses:
    - `conversations/conversation-view/jsonl-viewer/tool-call.ToolCallEvent`
    - `conversations/conversation-view/jsonl-viewer/tool-call.toolName`
    - `fields/text/config.textField`
    - `network/live.liveCollection`
    - `network/live.LiveRowsCollection`
    - `tasks/tasks-core.conversationsEntityRef`
  - Exports (types):
    - `AcceptedThreadResult`
    - `ProgressConversation`
    - `ThreadConversation`
    - `ThreadProgress`
    - `ThreadResult`
    - `ThreadResultDef`
    - `ThreadResultPayload`
    - `ThreadRun`
    - `ThreadState`
    - `ThreadStep`
    - `ThreadStepState`
    - `ThreadTurn`
    - `ThreadTurnState`
  - Exports (values):
    - `defineThreadResult`
    - `groupThread`
    - `latestOutputAt`
    - `latestResultOf`
    - `THREAD_RUNS_DEFAULT_LIMIT`
    - `threadProgressOf`
    - `threadRuns`
    - `threadStateOf`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --spacing`

<!-- AUTOGENERATED:END -->
