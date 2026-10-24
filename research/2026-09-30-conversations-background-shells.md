# Background shells in the conversation UI

## Context

When an agent runs `Bash` with `run_in_background: true`, the only way to see it
today is to attach to the conversation's tmux pane: Claude Code shows
"2 shells still running · ↓ to manage". The web conversation view shows the
launching Bash card as **finished** the moment it launches, because the
immediate `tool_result` ack counts as a result. It says nothing about the shell
after that.

Goal: a background shell can be seen, and followed live, from the web UI.

- It is a row in the running-agents band, showing its last output line and a
  ticking clock.
- Clicking the row opens a read-only, live-streaming output pane.
- The launching Bash card reads "running" or "exit N" and opens the same pane.

v1 is view-only. There is no Stop button (see Non-goals).

## What Claude Code already records (verified against real transcripts)

| Moment | Where | Content |
|---|---|---|
| launch | `Bash` tool-call, `input.run_in_background: true` | `command`, `description` |
| launch ack | that call's `tool_result` | `Command running in background with ID: <shellId>. Output is being written to: <path>. …` |
| output | `<path>` = `/private/tmp/claude-<uid>/<cwd-slug>/<sessionId>/tasks/<shellId>.output` | a plain file, appended while the command runs; `\r` progress lines included |
| end | `<task-notification>` in the parent transcript | `task-id` = shellId, `tool-use-id`, `output-file`, `status` ∈ completed/failed/killed, summary `Background command "…" completed (exit code 0)` |

The transcript parser already turns the end record into a `JsonlEvent`:
`{kind:"task-notification", taskId, toolUseId, status, summary, outputFile}`
(`transcript-watcher/core/protocol.ts`, `parse-jsonl.ts`). The launch record is
a `tool-call` event with `result.content`. **Discovery therefore needs no new
server read.** It is a pure fold over the `jsonlEvents` value the browser already
subscribes to, which is exactly how `workflowRunsOf` / `subagentRunState` work.

The only new server piece is **tailing the output file**. Nothing in the repo
reads the tmp `tasks/` dir today, and `watchPaths` is rooted at
`~/.claude/projects`.

## Design

### New plugin: `conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells`

It is a sibling of `subagents` and has the same web/server/core split.

**core/**

- `backgroundShellsOf({ events, conversationStatus }): BackgroundShell[]`. This
  is a pure fold, in start order.
  - It joins each `Bash` call whose input has `run_in_background: true` with the
    ack regex in its `result.content`, which yields `shellId` and `outputFile`.
    The ack parse is zod/regex-checked. A call whose result does not match is
    **not** a shell; it is a failed launch, and the card renders it as-is.
  - It joins `task-notification` by `taskId === shellId`. The fallback key is
    `toolUseId`.
  - `exitCode` is parsed from the summary's `(exit code N)` and is `null` when
    the summary lacks it.
  - State is a union:
    - `running`
    - `completed{exitCode}`
    - `failed{exitCode}`
    - `killed`
    - `ended-without-reporting`
  - `ended-without-reporting` is the answer when there is no notification and
    the conversation is no longer live. Claude Code kills its shells on exit.
    This is the same parent-liveness evidence `subagentRunState` uses, so there
    is **no staleness timeout**.
  - `startedAt` is the call's `at`. `endedAt` is the notification's `at`.
- `lastOutputLine(tail: string): string | null`. It strips ANSI, splits on
  `\n` **and** `\r` (so git/cargo progress shows its latest frame), and returns
  the last non-blank line. It returns `null` when there is none yet, which the
  UI shows as "no output yet" rather than as an empty string.
- `liveValue("background-shell-output", params { id, shellId })`. The payload is
  a union:
  - `{ kind: "present", size, tail, truncated }`, where `tail` is the last
    64 KB, cut at a line boundary.
  - `{ kind: "unknown-shell" }`
  - `{ kind: "gone" }`: the tmp file was removed, for example after a reboot or
    tmp cleanup.

**server/**

- `serveValue(shellOutput, { source: "external", loader, whileSubscribed })`.
  The pattern is copied from `subagents/server/internal/transcript-resource.ts`.
- **Ownership: the browser never sends a path.** The loader resolves
  `(conversationId, shellId)` to `outputFile` itself. It goes through
  `resolveConversationTranscriptPaths(id)` and then
  `readJsonlEventsFromChain(paths)`, then applies the same core fold. It then
  asserts that the path matches
  `^<tmpdir>/claude-<uid>/[^/]+/[^/]+/tasks/<shellId>\.output$`, and throws
  loudly otherwise. The resolved path is memoized per room, because the chain
  read happens once per subscription, not once per notify.
- Tail read: `stat` the file, then read `[max(0, size − 64 KB), size)`. This
  mirrors `subagents/server/internal/tail-read.ts`, which is plugin-internal.
  Either write a small local copy, or promote the helper into
  `infra/corpus-index`'s neighbourhood if a third user appears.
- Watch: `createFileWatcher({ dirs: [dirname(outputFile)], writesWhileOpen: true })`
  from `infra/file-watcher`, filtered to the one file, with `notify()` on change.
  - `writesWhileOpen: true` is **required**. The shell holds its stdout file
    open, and FSEvents only reports on close. The kqueue backend reports every
    write.
  - The `tasks/` dirs measured 79–338 entries, well under
    `WRITES_WHILE_OPEN_MAX_ENTRIES` (5 000).
  - Precedent: `infra/jobs/plugins/supervised-job/server/internal/run/supervisor.ts`.
  - Use a debounce of about 150 ms, so a chatty build pushes at most a few
    frames a second of a ≤64 KB payload.
  - The watcher starts on the first subscriber and stops on the last, like
    every `whileSubscribed` room.

**web/**

- `useConversationShells(conversationId)`. It returns a `pending | failed |
  known{ shells }` union built with `combineResources` over `jsonlEvents` and
  `useConversationById`. It is gated the same way as
  `useConversationSubagents`: never fold a half-arrived transcript.
- `useShellOutput(conversationId, shellId)` wraps
  `useLive(shellOutput, …)`. TanStack dedupes, so a band row and the open pane
  share one subscription.
- `shellOutputPane = Pane.define({ route: segment "shell/:shellId", app:
  agentManagerApp, title: "Shell", width: 600, chrome: { history: false,
  promote: false }, useResolve: false })`.
  - It takes `convId` from `conversationPane.useRouteEntry()`, exactly as
    `AgentReportPaneBody` does, and says so plainly when it has none.
  - Header: `$ command`, a state chip (`running 2:49` / `exit 0 · 3:12` /
    `killed`), and a `FilePath` copy of `outputFile`.
  - Body: `useStickyScroll` + `JumpToBottomButton` (`dom/auto-scroll`), and a
    mono `<pre>` of the ANSI-stripped tail. When `truncated` is set, a muted
    first line reads "showing the last 64 KB".
  - Loading, `gone` and `unknown-shell` are rendered states, never an empty
    box.
- `ShellStateChip`: one rendering of the state (dot + label + `ElapsedTime`),
  shared by the band, the card and the pane.

### running-agents band: a third row kind

`conversation-view/plugins/running-agents/web/internal/agent-rows.ts`

- `RunningAgentRow = AgentBandRow | WorkflowBandRow | ShellBandRow`.
  - The `kind: "shell"` row has key `shell:<shellId>`, `parentKey: null`, and
    type `"shell"`.
  - Its description is `input.description || command`, truncated by the
    existing `TaskLabel` leaf.
  - Its state, `startedAt` and `endedAt` come from `useConversationShells`.
    **The band still derives nothing.**
- The "last step" cell of a shell row is a small component calling
  `useShellOutput` → `lastOutputLine`. It shows "no output yet" when that is
  `null`.
- `rowActivation` for a shell row opens `shellOutputPane({ shellId })`.
- The same linger (`DONE_LINGER_MS`), `visibleAgentRows` and `nextLingerExpiry`
  logic applies unchanged, because it only reads `endedAt`.
- The header counts shells separately: "1 agent · 2 shells running ·
  longest 4:06", or "2 shells running" alone. Update `summary` and its test.
- `pending` now means that either source is pending, and `failed` means that
  either one failed. Same rule as today.
- The band's name stays `running-agents`. Update its CLAUDE.md "Rows" section.

### Bash transcript card

`jsonl-viewer/plugins/tool-call/plugins/bash/web/components/bash-tool-view.tsx`

- When `input.run_in_background` is set, it reads this shell's state through
  `useConversationShells` (joined by `toolUseId`):
  - `running={state.kind === "running"}`. This fixes today's "done at launch".
  - `leading={<MetaBadge>Background</MetaBadge>}`, the same precedent as the
    Agent card at `agent-tool-view.tsx:101`.
  - `note` gets the state chip, and `aside` gets an "Open output" `IconButton`
    that opens `shellOutputPane`.
  - The body shows the ack line as today. The live output is in the pane, not
    inline in the transcript.

### task-notification row: stop hard-coding the agent pane

Today `task-notification-row.tsx` imports `agentReportPane` and offers
"open sub-agent" for **every** notification. For a Bash shell that opens the
wrong pane. The fix follows the collection-consumer rule:

- Add a dispatch slot `TaskNotification.Open`, whose contributions are
  `{ useTarget(event, conversationId) → (() => void) | undefined }`.
- `tool-call/plugins/agent` contributes the sub-agent opener, and
  `background-shells` contributes the shell opener.
- The row renders the first action that claims the event, and nothing when none
  does. The row stops importing `agentReportPane`.

## Non-goals (v1), with follow-ups

- **Stop / kill.** Only Claude can call `TaskStop`, and a server-side
  `kill` would leave the transcript disagreeing with reality. Follow-up: a Stop
  button that sends a prompt ("stop background shell <id>") to the agent, so
  the kill is recorded like any other.
- **Shells launched by sub-agents.** They live in sub-agent transcripts. The
  fold is the same, and each would nest under its agent row via `parentKey`.
  This is a follow-up once v1 lands.
- **`Monitor` tasks** (`Monitor started (task …)`). They are the same shape
  with a different ack, and could be a second ack pattern later.
- **ANSI colour.** v1 strips ANSI, as the Bash card does. An SGR→span renderer
  is its own primitive.

## Critical files

- New: `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells/{core,server,web}/`, plus `CLAUDE.md`.
- `…/running-agents/web/internal/agent-rows.ts`, `…/running-agents/web/components/running-agents-band.tsx`, `…/running-agents/web/internal/use-running-agents.ts`, `…/running-agents/CLAUDE.md`.
- `…/jsonl-viewer/plugins/tool-call/plugins/bash/web/components/bash-tool-view.tsx`.
- `…/jsonl-viewer/plugins/task-notification/web/` (new slot) and `…/tool-call/plugins/agent/web/index.ts` (contributes to it).

Reuse:
- `serveValue` / `liveValue` / `useLive` (`network/live`)
- `createFileWatcher` (`infra/file-watcher`)
- `resolveConversationTranscriptPaths` + `readJsonlEventsFromChain` (`transcript-watcher/server`)
- `combineResources` (`live-state`)
- `useStickyScroll` + `JumpToBottomButton` (`dom/auto-scroll`)
- `ElapsedTime` (`relative-time`)
- `FilePath` (`jsonl-viewer/file-path`)
- `MetaBadge`, `ToolCallCard` (`tool-call`)
- `Pane.define`

## Verification

- **Unit tests** (`./equin test <plugin>`):
  - `backgroundShellsOf` over fixture events covers: launch + ack; completed
    with exit 0; failed with exit 1; killed; no notification with the
    conversation live (running); no notification with it ended
    (ended-without-reporting); a non-matching ack (not a shell).
  - `lastOutputLine` covers `\r` progress, ANSI, trailing blanks, and empty
    input.
  - Tests for the band's `summary` and the shell rows.
  - A server test for the path assertion: a forged or foreign path throws.
- **Build**: `./equin build`, then in the deployed app start a
  conversation that runs `for i in $(seq 60); do echo tick $i; sleep 1; done`
  in the background, and check:
  - The band shows a shell row whose last line advances every second.
  - Clicking the row opens the pane, which streams and sticks to the bottom.
  - The Bash card reads running, then `exit 0`.
  - The row lingers for about 3 s, then leaves.
  - The task-notification row's action opens the shell pane, not the agent
    pane.
- **Also check**: a command that exits 1 shows `failed · exit 1`. Ending the
  conversation while a shell runs shows it as ended-without-reporting.
- **E2E**: add `background-shells/e2e/shell-band.ts`, which drives the flow
  above against a seeded conversation. Take screenshots with
  `e2e-harness/e2e/screenshot.ts --click "shells running"`.
