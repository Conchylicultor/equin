# Live sub-agent transcripts in the conversation view

## Context

When an agent launches a sub-agent, the conversation shows a card naming the sub-agent's
type, model and description, with its prompt folded inside. While the sub-agent runs, the
card shows bouncing dots. When it finishes, a document button appears and opens a 600px
column at the right of the conversation with the sub-agent's final write-up.

So for the whole run — often many minutes — the card says only "something is happening".
You cannot tell a sub-agent that is working hard from one that is stuck, you cannot see
which files it read or what it concluded on the way, and if it dies without reporting, the
card keeps its dots forever.

Meanwhile Claude Code has already written everything we want. Every sub-agent gets its own
transcript file, live, as it works. Nothing in this repo has ever opened one.

Two things change:

1. **The card tells you how it's going** — how long it has been running, and the one thing
   it most recently did.
2. **Clicking it shows the work** — the same side column, now holding the sub-agent's own
   transcript, streaming as it happens, rendered with the exact cards the main conversation
   uses. The final write-up joins it at the top when it lands.

## What is already on disk (verified, 2026-09-20)

Next to the session file `~/.claude/projects/<dir>/<sessionId>.jsonl` sits a directory
`<sessionId>/subagents/` holding, per sub-agent:

```
agent-<agentId>.jsonl        the sub-agent's own transcript, appended live
agent-<agentId>.meta.json    {agentType, description, toolUseId, spawnDepth,
                              requestShape: "background"|"foreground", model, parentAgentId?}
```

Three facts make this cheap to build:

- **`toolUseId` in the meta file is the id of the parent's `Agent` tool-use block.** The
  join from a rendered card to its sub-agent's transcript is exact — no timestamp matching,
  no name guessing.
- **The lines have the same shape as a normal transcript.** They carry `type`, `uuid`,
  `parentUuid`, `message`, plus `isSidechain: true` and `agentId`. So
  `readJsonlEventsFromChain([file])`
  (`plugins/conversations/plugins/transcript-watcher/server/internal/parse-jsonl.ts`)
  parses them unchanged, and every existing event renderer already knows how to draw the
  result.
- **Nothing holds the files open.** Checked with `lsof` against a live session: Claude Code
  opens, appends and closes per line. So the existing parcel watcher over
  `CLAUDE_PROJECTS_DIR` (recursive, `.jsonl`-filtered) already delivers every append — the
  macOS FSEvents "only reports at close" trap that
  [`research/2026-09-17-infra-supervised-run-live-transcript.md`](2026-09-17-infra-supervised-run-live-transcript.md)
  fixed for supervised runs does not apply here. (If that ever changes, the contingency is
  a `writesWhileOpen` watcher scoped to one `subagents/` dir while a pane is open — it is a
  small, bounded directory, which is what that option requires.)

Nested sub-agents land flat in the same directory, linked by `parentAgentId`, and their
spawning tool-use lives in the *parent sub-agent's* transcript. That falls out for free:
the nested card inside a sub-agent's transcript opens the nested sub-agent's pane by the
same join.

## Design

### 1. A new plugin owns "which sub-agents exist, and what are they doing"

`.../jsonl-viewer/plugins/subagents/` (`core/`, `server/`, `web/`) — a sibling of
`tool-call`, one level under `jsonl-viewer`. It sits with its consumers: the pane body it
owns composes `jsonl-viewer/web`'s renderer, and the card three levels down reads its
resources. It must **not** live in `transcript-watcher`, which is upstream of the whole
conversation-view subtree and must never import back down into it. Only the generic watcher
extraction (§ *On the watcher*) belongs there, and that half is server-only.

Its directory discovery derives from the conversation's already-anchored session files:
for each entry `resolveAnchoredChain` keeps, the sub-agent directory is that entry's path
minus `.jsonl`, plus `/subagents`. **Do not add a second glob, and do not re-resolve from
raw session ids.** Deriving from the kept entries means the anchor guard in `anchor.ts`
(one conversation, one projects dir) holds for free — a sub-agent directory is unreachable
unless its parent file already passed the guard. Resolving independently would quietly
reopen the cross-conversation leak that guard exists to close
([`research/2026-08-19-global-pane-session-ownership.md`](2026-08-19-global-pane-session-ownership.md)).

Two resources, both `defineExternalResource` with `mode: "push"`, modelled on
`jsonl-viewer/server/internal/jsonl-events-resource.ts`:

**`subagent-activity`**, keyed `{ id: conversationId }` — one subscription serving *every*
card in the conversation, never one per card. Payload: a row per sub-agent:

```ts
{ toolUseId, agentId, agentType, description, model, requestShape,
  spawnDepth, parentAgentId?, startedAt, lastActivityAt,
  lastStep: { kind, toolName?, preview } | null }
```

`lastStep` comes from a **bounded tail read** (last ~64KB) of the one file the watcher just
reported changed, not a re-parse of every sub-agent transcript. Per-agent state is held in
the room, so a change costs one tail read.

It is derived from the last raw line's own shape — the message's block type (`tool_use`,
`text`, `thinking`, `tool_result`) plus a short preview — by a plain function in `core/`.
That is a genuinely closed list, so per the collection-consumer rule it is data in `core/`,
not a slot. It deliberately does **not** reach into the per-tool web renderers: they are
web-only, and they need a fully built event with its result paired, which is the whole-file
parse this tail read exists to avoid. A tool-aware phrasing later is a separate feature
(a real summary slot over the pane's parsed events), not an extension of this.

Every card in a conversation reads this one resource by `toolUseId`. No provider is needed
to share it: `useResource` is a TanStack Query wrapper, so N cards on identical params are
one query and one subscription.

**`subagent-transcript`**, keyed `{ id: conversationId, toolUseId }` → `JsonlEvent[]`.
Keyed by the *tool-use* id, not the agent id, so the card and the pane route need no extra
identifier: the server resolves `toolUseId` → file through the meta files. Subscribed only
while a pane is open. Payload is produced by the existing
`readJsonlEventsFromChain([path])` — no new parser.

**Not-known-yet is a state.** A sub-agent whose meta file has not landed yet has no row.
The card renders that as "starting", never as "no activity". The transcript resource
returns a discriminated result (`{ kind: "linked", events }` / `{ kind: "unlinked" }`), so
"the file isn't there yet" can never be read as "the sub-agent did nothing".

### 2. "Running" is derived honestly, from the parent transcript

There is no end-of-run marker inside a sub-agent's own file (verified: the last line is an
ordinary assistant line), so the file cannot answer this. The parent transcript can, and
differently per kind:

- **Foreground** (`requestShape: "foreground"`): the parent's `tool_result` lands only at
  completion. So `event.result` present ⇒ finished.
- **Background**: the `tool_result` is an immediate "launched" acknowledgement and means
  nothing. Completion arrives later as the `task-notification` event carrying the same
  `tool-use-id` — which `parse-jsonl.ts` already extracts today, rendered by the
  `task-notification` sub-plugin.
- **Neither, and the conversation is no longer working**: the sub-agent was killed or the
  session died. This is a third state — *ended without reporting* — not "still running".
  Rendering it as running would be the card lying, which is the failure this repo's
  "not-known-yet" rule exists to prevent.

Express it as a three-armed union in `subagents/core`, computed by one exported function
over `(agentToolEvent, taskNotifications, conversationStatus)`, so the card, the pane title
and any future consumer cannot disagree.

**Do not add a staleness timeout as a fourth answer.** A sub-agent that has written nothing
for five minutes may be inside one long tool call; a timeout would turn that into a claim
the code cannot support. Instead the card states the observation — "no update in 4m", from
`lastActivityAt` — next to a state that stays honest. An observation the user can judge,
not a conclusion the code guessed. There is no liveness or exit marker on disk; if one is
ever wanted, that is a harness-level ask, not something to synthesise from timestamps.

### 3. One transcript renderer, used by both surfaces

Today `JsonlPane`
(`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx`)
mixes two jobs: rendering a list of events, and conversation-only chrome (pending turns,
the composer's waiting-for prompt, the working indicator keyed off `conversation.status`,
scroll persistence keyed by conversation + surface tab).

Extract the first job into `TranscriptView`, exported from `jsonl-viewer/web`:

- takes `events: JsonlEvent[]`, a `persistKey`, and trailing `children`
- owns `useVisibleEvents` (the `JsonlViewer.EventFilter` set — the one sanctioned
  enumerator), `EventSections`, `EventRow`, `ImageGallery`, `useStickyScroll`, the bottom
  sentinel and `JumpToBottomButton`
- `JsonlPane` composes it with its conversation chrome; the sub-agent pane composes it with
  its own header

It is not a pure lift: three things inside currently assume "the conversation" and need the
identity passed in instead — the scroll-persistence key
(`conversation-scroll:${conversation.id}:${surfaceTabId}`), `ConversationIdProvider`, and
`LastAssistantProvider`. Check each call site rather than assuming they move untouched.
`paneScrollScope` is per DOM mount and should be fine.

This is the load-bearing step: it makes "the sub-agent's cards look like the conversation's
cards" true *by construction* rather than by two copies agreeing. Leave
`JsonlViewer.Overlay` (the token/context strip) in `JsonlPane` for now — those readings are
conversation-scoped.

Import direction stays a DAG: `jsonl-viewer/web` imports only `row-actions` and
`collapsible-card` among its children, so the `agent` sub-plugin importing
`jsonl-viewer/web` adds no cycle (`user-text`, `summary` and `transcript-stats` already do
exactly this).

### 4. The pane becomes the sub-agent view

Keep the route and the plugin that owns it: `agent-report/:toolUseId` in
`.../tool-call/plugins/agent/web/panes.ts`, a 600px satellite with
`chrome: { history: false, promote: false }`. Rewrite
`components/agent-report-pane.tsx` to render, top to bottom:

- a header naming the sub-agent (type, model, elapsed or total duration, state)
- the final write-up, when there is one, in a collapsible card at the top
- the live transcript below it, via `TranscriptView`

The button that opens it is now always present, not only after the result lands. Its label
follows the state: "Watch" while running, "View report" when done.

While the sub-agent is still starting (no transcript file yet) the pane shows a loading
state, never an empty transcript.

### 5. The card gains elapsed time and a last step

In `.../tool-call/plugins/agent/web/components/agent-tool-view.tsx`:

- **Elapsed** — reuse `<ElapsedTime since={…} />` from
  `plugins/primitives/plugins/relative-time/web` (already exports `ElapsedTime`,
  `formatElapsed`, `useNow`). Start from the row in `subagent-activity`, falling back to
  the card's own `event.at`. `jsonl-pane.tsx` has a private `formatElapsed` +
  `WorkingIndicator` that duplicate the primitive with a different format ("3m 45s" against
  the primitive's `m:ss` clock) — standardise on the primitive, which the op-status banner
  (`.../conversation-view/plugins/op-status/web/components/op-status-banner.tsx`) already
  uses for exactly this "how long has this been running" reading.
- **Last step** — a muted second line under the summary: `Read parse-jsonl.ts`,
  `Bash rg -n isSidechain`, or the first words of the sub-agent's current message. The
  server ships structured data (`{ kind, toolName?, preview }`); the web renders the
  words, through one shared formatter in `subagents/core` so the card and any future
  consumer phrase it identically.
- **State** — running / finished / ended without reporting, from §2. The third state
  replaces perpetual dots with something the user can act on.

Also worth the two lines while in here: the `task-notification` row already carries the
`tool-use-id`, so it can link to the same pane.

## Files

Paths below are under
`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/` unless stated.

New:

- `plugins/subagents/{core,server,web}/` — discovery, the two resources, the run-state
  union, the last-step formatter, the pane body, plus its `CLAUDE.md`

Modified:

- `web/components/jsonl-pane.tsx` — extract `TranscriptView`
- `web/index.ts` — export it
- `plugins/tool-call/plugins/agent/web/components/agent-tool-view.tsx` — elapsed, last
  step, state, always-present open button
- `plugins/tool-call/plugins/agent/web/components/agent-report-pane.tsx` — becomes a thin
  wrapper rendering the `subagents/web` pane body (`panes.ts` keeps route ownership). This
  file is a rewrite, not a rename: today it has no server half at all and reads the
  *parent* conversation's events.
- `plugins/task-notification/web/components/task-notification-row.tsx` — link to the pane
- `plugins/conversations/plugins/transcript-watcher/server/internal/watcher.ts` — the
  generic room + directory dispatch (see below). Server-only; no web coupling enters this
  plugin.

Reused unchanged: `readJsonlEventsFromChain`, `resolveConversationTranscriptPaths`,
`transcriptChainSignature`, `createSignedMemo`, `useVisibleEvents`, `EventRow`,
`ToolCallCard`, `ElapsedTime`, `Pane.define` / `PaneChrome`.

### On the watcher

Generalise, do not duplicate. `startTranscriptWatcher()` already holds **one**
`parcel.subscribe(CLAUDE_PROJECTS_DIR)` covering the whole tree, sub-agent files included —
today their events are simply dropped, because the reverse index has no entry for them. A
second subscription over the identical root would double the native watch cost for nothing.

So: extract the room into a generic `watchPaths(key, resolvePaths, onSnapshot)` inside
`transcript-watcher/server/internal/watcher.ts`, with `watchTranscript` rebound to it
unchanged and a single-file sub-agent binding beside it. Both feed off the one parcel
callback and the one 30s reconcile sweep.

**One dispatch detail is load-bearing.** Today an event is routed by exact path
(`pathToConvId.get(ev.path)`), so a sub-agent file that is not yet in the index — which is
every sub-agent at the moment it is born — routes nowhere, and the card never appears. The
index's rooms must therefore be keyed by **directory**: match `dirname(ev.path)` against
the conversation's `subagents/` directories, so a file appearing there triggers a rescan.
That also removes any need to widen the watcher's `.jsonl` extension filter for the meta
files: a `.meta.json` is always accompanied by transcript appends in the same directory, so
the rescan picks it up.

## Verification

1. `./equin build` (background, end the turn), then open
   `http://<worktree>.localhost:9000`.
2. Open a conversation that launched sub-agents. Confirm on a finished one: the card shows
   a total duration and the button opens a pane holding the sub-agent's transcript, drawn
   with the same cards as the main view, with its write-up at the top.
3. Launch a live one — ask an agent in that worktree to run an `Explore` sub-agent — and
   watch the card's elapsed time tick and its last step change, and the open pane grow, with
   no reload. This is the real test: it proves the file watcher delivers appends.
4. Open a sub-agent that itself spawned one, and confirm the nested card opens the nested
   transcript.
5. `./equin test` on the new plugin — unit tests for the `toolUseId` → file
   resolution, the bounded tail read (including a file that grows past the window), the
   three-armed run state (each arm, including "ended without reporting"), and the one that
   protects the anchor guarantee: **a session id the anchor dropped must never have its
   `subagents/` directory scanned**. Follow `anchor.test.ts` and the `jsonl-events` cache
   tests as precedent, and pair the new resources' revalidate and loader through one
   `createSignedMemo` binding, as `jsonl-events-cache.ts` does — never two ETag probes that
   can drift.
6. An e2e script at `.../plugins/subagents/e2e/subagent-pane.ts`
   following the harness pattern in `plugins/code-explorer/e2e/file-tree-expand.ts`: open a
   known conversation, click a sub-agent card, assert the pane renders its transcript rows.
7. `./equin check`.
