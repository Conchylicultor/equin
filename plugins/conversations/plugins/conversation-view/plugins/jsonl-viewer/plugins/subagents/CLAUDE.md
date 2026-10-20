# subagents

Which sub-agents a conversation has, what each one is doing right now, and each
one's own transcript.

When an agent launches a sub-agent, Claude Code writes the sub-agent its own
transcript, live, next to the session file:

```
~/.claude/projects/<dir>/<sessionId>.jsonl
~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl       appended live
~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.meta.json   written once, at spawn
```

Three facts make this cheap. When the meta file records a **`toolUseId`**, it is
the id of the parent's `Agent` tool-use block, so the join from a rendered card
to its sub-agent is exact (see *The join has two keys* below). The transcript's
lines have the **same shape as a session transcript** (`type`, `uuid`,
`parentUuid`, `message`, plus `isSidechain` and `agentId`), so
`readJsonlEventsFromChain` parses them unchanged and every existing event
renderer already draws them. And **nothing holds the files open** — Claude Code
opens, appends and closes per line — so the existing recursive watcher over
`CLAUDE_PROJECTS_DIR` already delivers every append.

## Discovery derives from the anchored chain, and must keep doing so

A sub-agent directory is a kept session transcript's path, minus `.jsonl`, plus
`/subagents` (`subagentDirs`). The paths come from
`resolveConversationTranscriptPaths`, which returns only what
`resolveAnchoredChain` **kept**.

That is the whole ownership story, and it is load-bearing. A session chain is a
list of ids *somebody else* recorded, and it can name another conversation's
session; the anchor guard is what refuses those
([`transcript-watcher/CLAUDE.md`](../../../../../transcript-watcher/CLAUDE.md)).
Deriving from the kept entries means a sub-agent directory is unreachable unless
its parent transcript already passed that guard — for free, with nothing to
remember.

**Never re-resolve from raw session ids.** Globbing each id independently would
resolve the foreign entry too, and we would scan — and stream — another agent's
sub-agent transcripts. That is exactly the cross-conversation leak
[`research/2026-08-19-global-pane-session-ownership.md`](../../../../../../../../research/2026-08-19-global-pane-session-ownership.md)
closed. A test pins it: a session the anchor dropped never has its `subagents/`
directory scanned, even with its files sitting right there on disk.

## The dispatch has to be by DIRECTORY, not by path

The watcher routes a filesystem event by looking the path up in a reverse index.
A sub-agent file is not in any index at the moment it is **created** — which is
every sub-agent, every time — so exact-path routing drops precisely the event
that says "a sub-agent now exists", and the card never appears at all.

So the rooms here declare `dirs` (`watchPaths`'s discovered-membership form): an
event anywhere inside one of the `subagents/` directories re-resolves the room
before re-reading. It also means the `.jsonl` extension filter needs no widening
for the meta files — a `.meta.json` is always accompanied by transcript appends
in the same directory, and the rescan picks it up.

Everything still rides the **one** `parcel.subscribe(CLAUDE_PROJECTS_DIR)` and
the **one** 30 s reconcile sweep that `transcript-watcher` already holds. A
second subscription over the identical root would double the native watch cost
for nothing.

## The two live values

Both are `liveValue`s declared in `core/protocol.ts`, served on the external arm
(`serveValue`, `server/internal/*-resource.ts`) and read with `useLive`. Each
watches its files only while its tuple has a subscriber: `whileSubscribed` opens
a `watchPaths` room (a synchronous start — the sub-ack is never held behind it),
primes the memo from the room's `{ value, signature }` pair before calling
`notify`, and returns the stop that closes the room and evicts the memo.

**`subagentActivity`** (`subagent-activity`), keyed `{ id: conversationId }` — one
row per sub-agent, and **one subscription serving every card in the
conversation**, never one per card. `useLive` is a TanStack Query wrapper, so N
cards on identical params are one query and one subscription; no provider is
needed to share it. Its stop also evicts the parent-chain name index
(`evictConversationJoin`).

`lastStep` comes from a **bounded tail read** (the last 64 KB) of the one file
that changed. A sub-agent transcript grows into the megabytes, and the index
re-reads on every append, so the bound is what keeps a change O(1) instead of
O(all sub-agents × their whole length). The per-agent `(mtime, size)` is held
between scans, and a scan re-stats (cheap) but re-reads only what moved.

The step is derived from the last classifiable line's own message **block type**
— a closed set (`tool` / `tool-result` / `text` / `thinking`), plain data in
`core/` rather than a slot. It deliberately does not reach into the per-tool
renderers: those are web-only and need a fully built event with its result
paired, which is the whole-file parse this tail read exists to avoid. A
tool-aware phrasing is a separate feature over the pane's parsed events.

**A trailing `tool_result` defers to the `tool_use` it answers.** A result always
lands immediately after its call, so the newest line in a live window is a result
about a third of the time (348 of 992 sampled cut points across the 826
transcripts here) — and a result's text is the PAYLOAD, not a description of
anything. Reporting it literally put a file's line-numbered contents on the card:

> Result: 1 # row-actions 2 3 ## What this plugin owns 4 5 **Which** actions a JSONL tran…

where the honest reading was `Read row-actions/CLAUDE.md`. So when the newest
classifiable line is a result, `lastStepOfLines` keeps scanning for the action
that produced it — present in the same window 340 of those 348 times.

The `tool-result` arm survives for the remaining 8, where the call has scrolled
out of the window, and it carries **no preview**: there is nowhere to put that
text any more, which is what stops the payload coming back. It renders as
"Finished a tool call". Not `null` there — a sub-agent mid-tool-loop has plainly
not "not started".

Text and thinking still win outright when they are newest; they are the sub-agent
speaking, which says more than any tool name. They are skipped only when OLDER
than a trailing result, where reporting them would quote something the sub-agent
said before the step it has since taken.

**`subagentTranscript`** (`subagent-transcript`), keyed `{ id, by, key }` — the
parent conversation plus a flat `SubagentRef` (`by: "call"` with the parent's
tool-use id, or `by: "agent"` with the sub-agent's own id) → the parsed events. A
value's params are plain strings on the wire, so the server re-parses `by` / `key`
through `SubagentRefSchema` before it reads anything. While the sub-agent is still
starting there is no file, so the room watches the directories; once the file is
known its identity is fixed and the room narrows to that one path, so a sibling's
appends stop waking it.

Both resources pair their `revalidate` and their `loader` through **one**
`createSignedMemo` binding, exactly as `jsonl-events-cache.ts` does — never two
ETag probes that can drift, which is how `edited-files` once certified a stale
value with a fresh ETag.

## Not-known-yet is a state, in three places

- A sub-agent whose **meta file** has not landed has **no row**. Inventing one
  would mean naming it "unknown"; the card renders the absence as "starting".
- The transcript value is a **discriminated result**
  (`{ kind: "linked", … }` / `{ kind: "unlinked" }`), so "the file isn't there
  yet" can never be read as "the sub-agent did nothing". Before the first value
  lands the read is `pending` — `unlinked` is a settled answer, never used as a
  placeholder.
- `lastStep: null` means it has written nothing classifiable yet — a fact, not a
  stand-in for "idle".

## "Running": the PARENT first, then the sub-agent's own turn end — three answers

`subagentRunState` (`core/run-state.ts`) is the one computation. Evidence, in order:

- **foreground** — the parent's `tool_result` lands only at completion ⇒ finished.
- **background** — that `tool_result` is an immediate launch acknowledgement and
  means nothing; completion is the `task-notification` carrying the same
  tool-use id.
- **…unless it was resumed since.** A `SendMessage` to a stopped sub-agent
  resumes it — a new turn in the same transcript, under the same agent id — and
  Claude Code notifies again "each time this agent stops", the later
  notifications carrying the `SendMessage`'s tool-use id with the agent's id as
  `task-id`. So notifications also join by `task-id` = the row's `agentId`, and
  any completion (notification or foreground result) older than the newest
  resume (`agentResumeTimes`: a `SendMessage` whose result names
  `resumedAgentId`) is stale. Without this the first notification finished the
  agent for good and every resumed turn ran invisibly (conv-1791379404-0sgk).
- **its own turn ended** — the harness streams an assistant message in pieces with
  `stop_reason: null`, and only the last piece of an ended turn carries
  `end_turn` / `stop_sequence`. The tail read records it as the row's `turnEnded`
  (`turnEndedOfLines`, newest assistant/user line decides, bookkeeping lines
  skipped) ⇒ finished. For a sub-agent started by ANOTHER sub-agent this is the
  only signal there is: its launching call and any notification live in the
  spawner's transcript, never the conversation's — before this it read "running"
  until the whole conversation stopped. **Positive-only**: Claude Code versions
  before ~2.1.27x often never wrote the marker (283 of 876 transcripts end on an
  untagged piece), so `false` means "nothing seen", never "still working". A named
  teammate woken by a later message appends a user line, and the next read sees an
  open turn again — nothing is latched.
- **a named teammate went idle** — a teammate gets no task-notification (it has
  no tool-use id to carry), and Claude Code 2.1.29x often writes its turn's last
  text piece with `stop_reason: null`, so the marker above misses. What the lead
  DOES receive is an `idle_notification` relayed into the parent transcript
  (`teammateIdleTimes`, keyed by the teammate's `name`; a name two rows share
  refuses). It counts only while the teammate's newest assistant/user line —
  its own `timestamp`, the row's `newestTurnLineAt` — is no newer than the
  notification: a teammate woken afterwards is working again. Compared against
  the line's timestamp, not the file's mtime, because the harness writes the
  final line up to ~0.1 s AFTER sending the notification (83 of 267 teammates
  on this machine, 2026-10-07); by line timestamp all 267 agree, the two
  exceptions being teammates genuinely woken after their last idle.
- **none of those, and the parent has no live process** — the sub-agent was killed
  or died with the session. That is **ended without reporting**, a third state,
  not "still running". Rendering it as running would be the card lying about work
  that stopped minutes ago.

**Do not add a staleness timeout as a fourth answer.** A sub-agent silent for
five minutes may be inside one long tool call, and a timeout would turn that into
a claim the code cannot support. Surfaces state the observation instead — "no
update in 4m", from `lastActivityAt` — which the user can judge.

## The meta format has GROWN — measure before you require anything

`agent-<id>.meta.json` has gained fields across Claude Code versions, and a
conversation's `subagents/` directory accumulates sub-agents from **every
version it has ever run under**. So the newest directory on the machine is the
worst possible sample: everything looks mandatory there.

Measured over all 818 meta files under `~/.claude/projects` (2026-09-20):

| field           | present | missing |
| --------------- | ------: | ------: |
| `agentType`     |     818 |       0 |
| `description`   |     818 |       0 |
| `spawnDepth`    |     811 |       7 |
| `model`         |     784 |      34 |
| `toolUseId`     |     512 |     306 |
| `requestShape`  |     422 |     396 |
| `parentAgentId` |      16 |     802 |

Seven files are literally `{agentType, description, toolUseId}` and nothing else.
`requestShape` only ever takes `background` (414) or `foreground` (8), and no
file on disk today is unparseable JSON.

**A corpus scan is a good instrument and a poor alarm.** Every count on this page
was measured because a defect had already been seen in the running app, and each
one settled the question it was pointed at. None of them found anything. The
files were there the whole time; a schema modelled on one directory shipped
anyway, and blanked every card in the conversation. So measure before you require
a field — and do not expect measuring to be what tells you a field is wrong.
Driving the app is what does that.

**Only `agentType` and `description` are required.** An earlier version of this
plugin required `model`, `requestShape` and `spawnDepth` because one recent
directory had them all; the result in the deployed app was
`loader failed for subagent-activity: path ["model"] Required` — the resource
errored for the whole conversation, the client retried, the log endpoint 429'd,
and **no sub-agent card rendered at all**.

An absent field means the harness did not record it. That is a fact, so a
surface omits the reading rather than inventing a default. `toolUseId` in
particular is absent for every in-process teammate (`taskKind:
"in_process_teammate"`), which has a transcript but no `Agent` card in the parent
to be reached from; such a sub-agent is listed but is not reachable by the keyed
transcript resource.

Note that `subagentRunState` has always typed `requestShape` as possibly absent
and documented the fall-through — the required schema field contradicted the
function's own contract. If you find yourself tightening one of these, check the
corpus first, and check what the consumer already claims to tolerate.

## The join has two keys, because the harness writes one or the other

Spawning an agent **with a name** makes it an in-process teammate, and the
harness then records the name **instead of** a `toolUseId`:

```json
{"agentType":"live-probe","description":"Live streaming test subject","name":"live-probe",
 "spawnDepth":0,"requestShape":"background","model":"sonnet",
 "taskKind":"in_process_teammate","teamName":"session-359d3e91","permissionMode":"auto"}
```

The parent's `Agent` tool-use block still exists and still has an id, so there is
a card on screen for it. With an id-only join that card finds no row: no
duration, no last step, and a button onto a pane that can never resolve. This is
not a fringe case — **307 of the 818 metas on this machine are
named-with-no-id**, and both agents that built this feature are among them.

The other half of the join is in the parent's own call: `input.name` is the name
it asked for, and the meta records the same string under `name`. Measured across
all 175 sessions: **301 of those 307 resolve this way.**

| join path | rule |
| --- | --- |
| meta has a `toolUseId` | match it; ids are unique by construction |
| meta has only a `name` | match the name the parent's `Agent` call requested |

Two guards on the name path, because **a name is not an id**:

- It considers only metas carrying **no `toolUseId` of their own** — one that has
  an id belongs to a different card, and matching it would steal that card's row.
- A name answered by **more than one** meta refuses to join. The harness permits
  a duplicate name and resolves it "latest wins", but that rule decides which
  LIVE teammate a message reaches; a transcript join has no "live", and picking
  either would put one sub-agent's work under the other's card. Zero collisions
  occur across the 175 sessions here, so this is a guard, not a path.

**Who reads the name.** A surface rendering the card already holds the `Agent`
event, so `agentCallJoin(event)` hands `describedSubagent` both keys and the join
costs nothing. The `subagent-transcript` value cannot: opened `by: "call"`, it is
given only the tool-use id, so it reads the name back out of the parent chain
(`server/internal/agent-calls.ts`) — raw lines rather than built events, memoized
on the parent chain's signature, so the multi-megabyte read happens once per
parent write rather than once per sub-agent append.

**What stays unreachable, deliberately.** A sub-agent that itself spawned a named
teammate (`spawnDepth` 2) has its `Agent` call inside the SUB-AGENT's transcript.
Those are the files that grow constantly, so folding them into the name index
would trade that bound away to buy 5 of 818 cases. Such a teammate stays
`unlinked` when a pane is opened by id — a state the result type can express. A
nested card rendered inside its parent's own pane still joins, because that
surface holds the event and passes the name directly. One further sub-agent
resolves nowhere at all, its parent transcript having been truncated.

## The join runs both ways, from ONE hook

`useSubagentStatus` answers for the card that launched one sub-agent. A surface
listing the conversation's sub-agents — the running-agents band above the prompt
box — asks the same question of every row at once, and it must not re-derive any
of it: `useConversationSubagents(conversationId)` is that read, and
`useSubagentStatus` is now a thin reading of it (`use-subagent-statuses.ts`).

One hook, because the two directions are the same three reads (activity,
`jsonl-events`, the conversation) and the same `pending` gate. Every caller in a
conversation subscribes on the same id, so a band listing ten sub-agents and a
hundred cards each reading their own still cost one query and one subscription
each.

The directions differ only in which key they start from:

| starting from | function | why |
| --- | --- | --- |
| a card's `Agent` call | `describedSubagent` | the call carries BOTH keys |
| a row | `agentCallForSubagent` (`core/join.ts`) | the row carries one |

The reverse join earns its place: without the parent's call there is no
FOREGROUND completion signal, so a listed sub-agent's state would fall back to
the parent's own liveness and a finished one would keep reading as running.

`statusOf` recomputes the state from the CARD's own event rather than reusing the
entry's, and that is deliberate: the reverse join can refuse (two calls asking
for one name), and a card holding its own event never has to.

**The tool name is spelled here, not imported.** `AGENT_TOOL_NAME` lives in this
plugin's `core/join.ts` — the plugin that renders `Agent` cards already imports
this one, so importing it back would close a cycle. The server's raw-line name
index reads the same constant.

## Workflow agents: a second layout, one folder deeper

A `Workflow` tool call runs its agents somewhere else on disk:

```
<session>/subagents/workflows/wf_<runId>/agent-<id>.jsonl / .meta.json
<session>/subagents/workflows/wf_<runId>/journal.jsonl   launched / started{agentId,…} / result{agentId,…}
```

**Discovered below the same roots, never resolved from elsewhere.**
`listSubagentEntries` walks `<root>/workflows/wf_*` under each `subagentDirs`
root and tags those entries with their `workflowRunId`, so the anchored-chain
ownership above still holds. The watcher routes by exact parent directory, so
`subagentWatchDirs` adds `workflows/` and every run folder to the watched set —
without them a write inside a run wakes nothing. Each run's `journal.jsonl` is
a signature path, so a new `result` line moves the signature.

**The journal is the completion signal.** A workflow agent's meta has no
`toolUseId` and no `parentAgentId`, so it joins no `Agent` call and gets no
notification of its own. Its `result` line in the run's journal is to it what
a foreground `tool_result` is to an `Agent` call. `workflow-journal.ts` reads
the journal **incrementally** (per path: a byte offset and the set of agents
that reported; complete lines only; a shrink resets it), because one run's
journal is hundreds of KB and only grows. The row carries it as
`workflow: { runId, reported }` — on both arms, since an agent whose meta is
unreadable still sits in its run's folder.

**Run state.** `workflowRunsOf` (`core/workflow-join.ts`) derives one
`WorkflowRunEntry` per run seen on a row. The run joins its `Workflow` call
through the call result's `Run ID: wf_…` (`parseWorkflowResult`, from the
workflow tool plugin's `core`). A run is finished when the `task-notification`
carrying that call's id lands. With no call left to read, it is running while
one of its agents is. Otherwise the parent's liveness decides. Each workflow
agent then gets two inputs to `subagentRunState`: `workflowReported` (its
journal line, checked first ⇒ finished) and `workflowRunEnded` (its run is no
longer running, checked after its own turn end and before liveness ⇒ ended
without reporting). `useConversationSubagents` computes the runs once and
returns them as `workflowRuns` beside `entries`, so a list's run row and the
state its agents were given cannot disagree.

## One unreadable meta costs one row, never the list

A row is a **union**, not a flat record with an error flag:

- `{ kind: "described", … }` — the meta parsed. Most of its fields may still be
  legitimately absent.
- `{ kind: "undescribed", reason }` — the file is there and we cannot make sense
  of it (corrupt JSON, or a `requestShape` naming something this build has never
  heard of).

Both arms carry what the filesystem knows regardless — `agentId`, `startedAt`,
`lastActivityAt`, `lastStep` — so an undescribed sub-agent still shows when it
started and what it last did.

The union is what makes "this sub-agent's metadata is unreadable" distinguishable
from "this sub-agent has no recorded model", which a flat row with optional
fields cannot express. Dropping the row instead would hide a sub-agent that
demonstrably exists; filling in defaults would have the card state things nothing
on disk supports.

Only the two failures meaning "this FILE makes no sense" become a value —
malformed JSON and a shape the schema rejects. A permission or I/O error still
throws, because those say nothing about the sub-agent and everything about the
machine. An `unreadable` result is never cached, so a torn read of a file being
created heals on the next scan.

## Every reader takes its directories as an argument

`subagentDirs(conversationId)` is the ONE place that decides which directories
this plugin may look at. `listSubagentEntries`, `scanActivityIn` and
`findSubagentIn` all take the directory list, and the conversation-level
functions are thin bindings over them.

That keeps the ownership boundary structural rather than conventional: nothing
downstream can widen the set, because nothing downstream resolves one.

## Design

[`research/2026-09-20-conversations-live-subagent-transcripts.md`](../../../../../../../../research/2026-09-20-conversations-live-subagent-transcripts.md)

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The sub-agent surfaces: how one sub-agent is going (state, elapsed, the one thing it most recently did) for the card that launched it, and the pane body that shows its write-up and its own live transcript, drawn by the conversation's own TranscriptView. Discovers a conversation's sub-agents from the `subagents/` directory beside each of its anchored session transcripts, and serves two live resources: what every sub-agent is doing right now (one bounded tail read per change), and one sub-agent's own transcript, parsed by the same reader as the main conversation.
- Web:
  - Contributes: `Demo.Resource` "subagents"
  - Uses: 25 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/live-state` ×4
    - `primitives/relative-time` ×3
    - `conversations/conversation-view/jsonl-viewer` ×2
    - `primitives/css/spacing` ×2
    - `conversations/conversation-view/jsonl-viewer/collapsible-card.CollapsibleCard`
    - `conversations.useConversationById`
    - `framework/browser-server/demo.demoResource`
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/loading.Loading`
    - `primitives/markdown.Markdown`
    - `ui/icons.Icon`
  - Exports (types):
    - `SubagentEntry`
    - `SubagentStateDisplay`
    - `SubagentStatus`
  - Exports (values):
    - `SubagentDuration`
    - `SubagentLastStep`
    - `SubagentPaneBody`
    - `subagentStateDisplay`
    - `useConversationSubagents`
    - `useSubagentStatus`
- Server:
  - Contributes:
    - `resource.declare` "subagent-activity"
    - `resource.declare` "subagent-transcript"
  - Uses:
    - `conversations/transcript-source.transcriptChainReads`
    - `conversations/transcript-watcher.conversationChainTag`
    - `conversations/transcript-watcher.readChainLines`
    - `conversations/transcript-watcher.readJsonlEventsFromChain`
    - `conversations/transcript-watcher.resolveConversationTranscriptPaths`
    - `conversations/transcript-watcher.transcriptChainSignature`
    - `conversations/transcript-watcher.watchPaths`
    - `infra/git/git-read-cache.createSignedMemo`
    - `network/live.serveValue`
  - Exports (values):
    - `listSubagentEntries`
    - `subagentDirOf`
  - Resources:
    - `subagent-activity` (push, notified)
    - `subagent-transcript` (push, notified)
- Core:
  - Uses:
    - `conversations.hasLiveProcess`
    - `conversations/conversation-view/jsonl-viewer/tool-call/workflow.parseWorkflowResult`
    - `conversations/conversation-view/jsonl-viewer/tool-call/workflow.WORKFLOW_TOOL_NAME`
    - `conversations/transcript-source.JsonlEvent`
    - `conversations/transcript-source.JsonlEventSchema`
    - `conversations/transcript-source.TokenUsage`
    - `conversations/transcript-source.tokenUsageOf`
    - `conversations/transcript-source.TokenUsageSchema`
    - `network/live.liveValue`
  - Exports (types):
    - `DescribedSubagent`
    - `LastStep`
    - `SubagentActivityRow`
    - `SubagentJoin`
    - `SubagentRef`
    - `SubagentReport`
    - `SubagentRequestShape`
    - `SubagentRunState`
    - `SubagentRunStateInput`
    - `SubagentTranscript`
    - `UndescribedSubagent`
    - `UsageFold`
    - `WorkflowRunEntry`
    - `WorkflowRunsInput`
  - Exports (values):
    - `AGENT_TOOL_NAME`
    - `agentCallForSubagent`
    - `agentCallJoin`
    - `agentCallsIn`
    - `agentResumeTimes`
    - `classifyLastStep`
    - `describedSubagent`
    - `DescribedSubagentSchema`
    - `emptyUsageFold`
    - `foldUsageLine`
    - `formatLastStep`
    - `lastStepOfLines`
    - `LastStepSchema`
    - `newestTurnLineAt`
    - `SEND_MESSAGE_TOOL_NAME`
    - `subagentActivity`
    - `SubagentActivityPayloadSchema`
    - `SubagentActivityRowSchema`
    - `SubagentRefSchema`
    - `subagentReport`
    - `SubagentRequestShapeSchema`
    - `subagentRunState`
    - `subagentTranscript`
    - `SubagentTranscriptSchema`
    - `teammateIdleTimes`
    - `toolResultIsOutcome`
    - `turnEndedOfLines`
    - `UndescribedSubagentSchema`
    - `workflowCallsIn`
    - `workflowRunIdOf`
    - `workflowRunsOf`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/categorical --categorical-6`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-caption`
    - `ui/tokens/type-scale --font-weight-normal`
    - `ui/tokens/type-scale --line-height-caption`
  - Imported by:
    - `conversations/conversation-view/jsonl-viewer/tool-call/agent`
    - `conversations/conversation-view/running-agents`
    - `conversations/usage`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/discovery.ts` (debt)

<!-- AUTOGENERATED:END -->
