# running-agents

The sub-agents working for this conversation, in a card above the prompt box:

> ◌ **3** agents working · longest 4:06 ⌄

Open by default; the summary line folds the rows. One row per sub-agent — dot,
what it was asked to do, **what it last did**, type, a ticking clock — nested
under the sub-agent (or workflow run) that spawned it. Every sub-agent row opens
that sub-agent's report pane.

## The hierarchy

A sub-agent can spawn its own (a lead fanning out to named teammates). Each
row sits under its parent, read from the meta file's `parentAgentId`; older
Claude Code versions don't write it, so those rows sit at the top level.

- **A stopped parent stays while anything under it is shown** (reading
  "done"), or its children would silently move to the top level — a claim that
  the conversation launched them. `visibleAgentRows` keeps every ancestor of a
  shown row; such a parent arms no linger timer of its own
  (`nextLingerExpiry` skips expiries already behind `now`) and leaves with its
  last child.
- **A row opens by the sub-agent's OWN id** (`{ by: "agent" }`), not by the
  tool-use id of the call that launched it. A named teammate records no
  tool-use id, and when another sub-agent spawned it, that launching call is in
  the spawner's transcript, which the call-keyed lookup never reads. The own id
  names its files directly, so every row opens.

### Workflow runs are rows too

Agents a `Workflow` call spawned sit under **one row for their run**
(`RunningAgentRow` is a union on `kind: "agent" | "workflow"`). The run row is
keyed `workflow:<runId>` at the top level, named by the script's `meta.name`
(else the run id), and its type reads "workflow". Its agents point at it as
their `parentKey`, and their type cell shows their `workflowPhase`. Its state
and clock come from `workflowRuns` (the subagents plugin), never derived here.

- The same ancestor rule keeps the run row on screen while any of its agents is
  shown. It also shows on its own while the run is going, including between
  phases with no agent live.
- **A run row opens nothing** (`rowActivation` resolves to `undefined`). There
  is no whole-run pane, and the transcript's Workflow card already draws the
  DAG, so folding is its only interaction. Its agents open their report pane
  like any other row.
- **The summary counts agents only.** A run is not an agent working, and
  "4 agents working" over three would be a miscount. A run still going with no
  agent live (between phases) is counted apart (`runsGoing`), so the header
  reads "Workflow running · between phases", never "All agents finished".

### Background shells are rows too

A `Bash` call with `run_in_background` is a **shell row** (`kind: "shell"`),
keyed `shell:<shellId>`, always top-level, type "shell", named by the call's
`description`, else its command. Its state, start and end come from
[`../jsonl-viewer/plugins/background-shells`](../jsonl-viewer/plugins/background-shells/CLAUDE.md)
(`useConversationShells`) and merge into the rows by start.

- **Its "last step" is its latest output line** — `lastOutputLine` over the
  live tail (`useShellOutput`, the same subscription the output pane holds),
  "no output yet" before any; nothing while the tail is still landing.
- **A stopped shell says how it stopped** (`shellStateDisplay`: "exit 0",
  "Failed · exit 1", "Killed") where an agent says "done".
- **It opens its output pane** (`shellOutputPane({ shellId })`).
- **The summary counts shells apart**: "2 agents working", "2 shells running",
  or "1 agent · 2 shells running"; "longest" is the oldest of either.
- The band is `pending` while either read (sub-agents, shells) is, and
  `failed` when either failed.

## It derives nothing

Run state, last step and duration all come from
[`../jsonl-viewer/plugins/subagents`](../jsonl-viewer/plugins/subagents/CLAUDE.md)
(`useConversationSubagents`, `formatLastStep`, `SubagentDuration`). **Do not
fold the parent transcript here again.** An earlier version did, and that answer
is strictly smaller: it cannot see a sub-agent killed or died with its session
(it says "running" forever), nor a named in-process teammate, which has no
`Agent` card in the parent at all.

This plugin owns only *which* of them to show right now, and the card.

## The linger, and its one timer

A stopped sub-agent stays 3 s showing a check and "done m:ss" — otherwise a row
vanishes at a moment nobody was looking at and the band silently shrinks. That
instant is the one thing pushed data cannot provide, so `useRunningAgents` arms
ONE `setTimeout` to the next expiry (presentational, not a poll; an expiry
already behind the clock fires at once). **Ended-without-reporting lingers the
same way** — it stopped, whichever way it stopped.

A row is shown while its state is `running`, or until `DONE_LINGER_MS` past its
recorded `endedAt`. **A stopped row with no recorded end is not shown**: a shell
that ended without reporting (the conversation exited, killing it, and no
notification dates it) has `endedAt: null`. Lingering needs an instant to count
from; "when the band first noticed" would be the band deriving a fact the
transcript does not hold, and showing it forever would claim it is still worth
watching. (A sub-agent always has one — its last activity.)

## No stop button, monochrome

The app drives Claude Code by typing into its terminal, and its only stop
(Escape) interrupts the whole turn. A control on one row would be a lie about
what pressing it does, so there is none.

Greys only: directly above the composer, per-type colours read as a status the
transcript does not have. The one motion is the summary ring, **held still**
under `prefers-reduced-motion` rather than removed, so the line keeps its shape.

## The rows are a DataView with a HOSTED toolbar

`views={["tree"]}` with a read-only `hierarchy` (ranks minted from launch
order, no `onMove`), `toolbar={{ kind: "hosted", frame }}` — no band (a
search/filter/sort strip over four rows in a small card does nothing); the card
places the one options trigger the host hands it. Two things to know before
editing `running-agents-band.tsx`:

- **The card IS the frame**, so it renders *inside* the DataView: the summary
  and the open/closed state reach it through a context the band provides around
  the DataView. The frame is module-scope — a new identity per render remounts
  the card.
- **The last step rides in the label.** A tree row's non-label fields are
  rigid chips that never shrink, so a sentence there squeezes the task to
  nothing. The label (`TaskLabel`) is the one truncating leaf: task, then the
  muted step, so the step is cut first. Plain inline spans only — a box of its
  own (a `Line`, a chip row) takes the truncation with it. The `lastStep` field
  stays for search and filter, hidden from the body.

Config-backed like every DataView:
`config/conversations/conversation-view/running-agents/running-agents.jsonc`.

## Nothing, rather than a false nothing

`null` while the reads are landing, and `null` when nothing is running.
"0 agents working" is a claim that would reverse itself a moment later.

## The agents stat toggles the card

A `TranscriptStats.Item` (`agents-stat.tsx`) in the strip at the foot of the
transcript: **`3 agents · 165k total`**, shown when at least one agent was
launched. The total is output tokens: the transcript's own plus every agent's
`usage` total, which the subagents plugin reads incrementally.

Clicking it toggles this card's `showAll`: every agent and run, finished or not,
unfolded, and the card stays up with nothing running ("6 agents · all
finished"). Clicking again restores the band. The stat and the card sit in
slots with no common ancestor, so they share one per-conversation `useDraft`
value (`band-view.ts`: `showAll` + `open`).

- **In a sub-agent's pane it counts that sub-agent's own children**
  (`rowsUnder` its agent id, via `useTranscriptSubject()`) and toggles nothing:
  the card is the conversation's.
- **Scrolled back into history**, it counts only agents started by the row on
  screen. Each agent's total is still as of now.

## Design

[`research/2026-09-22-conversations-running-subagents-band-v2.md`](../../../../../../research/2026-09-22-conversations-running-subagents-band-v2.md)

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The sub-agents working for this conversation, in a card above the prompt box: a summary line (how many are working, how long the longest has been going) that folds the list, and one row per agent — what it was asked to do, what it is, what it last did and how many tokens it has produced. A finished agent lingers a few seconds showing 'done m:ss'; the card is not there at all when nothing is running. The transcript's stats strip carries an agents reading (how many agents, and the output tokens the conversation and they produced in all) that toggles the card to list every agent, finished or not
- Web:
  - Contributes:
    - `Conversation.AbovePromptInput` → `RunningAgentsBand`
    - `TranscriptStats.Item` "agents" → `AgentsStat`
  - Uses: 34 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `conversations/conversation-view/jsonl-viewer/background-shells` ×4
    - `primitives/collapsible` ×4
    - `conversations/conversation-view/jsonl-viewer/transcript-stats` ×3
    - `conversations/conversation-view/jsonl-viewer` ×3
    - `conversations/conversation-view/jsonl-viewer/subagents` ×2
    - `primitives/css/fill` ×2
    - `primitives/data-view` ×2
    - `conversations/conversation-view/jsonl-viewer/tool-call/agent.agentReportPane`
    - `conversations/conversation-view.Conversation`
    - `primitives/css/clip.Clip`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/live-state.ResourceErrorInline`
    - `primitives/pane.useOpenPane`
    - `primitives/persistent-draft.useDraft`
    - `primitives/relative-time.ElapsedTime`
    - `ui/icons.Icon`

<!-- AUTOGENERATED:END -->
