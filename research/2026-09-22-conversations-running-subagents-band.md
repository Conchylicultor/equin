# Running sub-agents above the prompt box

## Context

When an agent fans work out to sub-agents, the only trace in a conversation
today is one collapsed "Agent" card per launch, scattered up the transcript.
Nothing tells the user, at the place they are about to type, how many
sub-agents are still working, on what, and for how long.

Design: prototype `proto-1789940389-8r46` (summary-only, monochrome, spinner).
Decisions taken with the user:

- A summary line — "3 agents working · longest 4:06" + chevron — over one
  row per running agent. **Open by default**; clicking the summary line folds
  the list.
- Each row: a neutral dot, the agent type, its description (truncates first),
  its model tag, a "background" tag when launched in the background, and a
  ticking elapsed clock.
- **No colours.** Greys only.
- **No stop action.** The app drives Claude Code by typing into its terminal;
  the only stop it has (Escape) interrupts the whole turn. A single sub-agent
  cannot be stopped from here.
- **Activity cue: one small spinning ring** at the start of the summary line.
  Held still under `prefers-reduced-motion`.
- A finished agent shows a check and "done m:ss" for ~3 s, then leaves.
- **Its own box** above the prompt box, like the op-status banner and the
  turn-summary card — not fused with the composer's border.
- Hidden when no sub-agent is running.

## Where the data comes from

Everything is already on the client. No server change, no new resource.

- `jsonlEventsResource` (`conversation-view/plugins/jsonl-viewer/core`) pushes
  the **whole** event array for the conversation's session chain — not
  windowed — so an agent launched far back is still in it. Read the raw
  resource, never `useVisibleEvents` (display filters would hide rows).
- An Agent launch is a `tool-call` event with `name === "Agent"`; its `input`
  carries `subagent_type`, `description`, `model`, `run_in_background`.
  Start time is `event.at`.
- **Foreground** agent: running while `event.result` is absent; finished at
  `result.at`. An Escape interrupt writes an error `tool_result`, so an
  interrupted agent ends too.
- **Background** agent: `result` is set immediately to the "Async agent
  launched" placeholder, so `result` means nothing. It is running until a
  `task-notification` event with the same `toolUseId` arrives; finished at that
  notification's `at`. The join key is the same one `event-key.ts` already
  uses for row identity (`tool:<toolUseId>`).
- **Dead session backstop:** when `hasLiveProcess(conversation.status)`
  (`plugins/conversations/core/status.ts`) is false, nothing is running —
  covers a crashed/restarted session whose background notifications will never
  land.

Precedent for exactly this shape — a pure client fold over the raw event array:
`jsonl-viewer/plugins/tool-call/plugins/task-tools/web/components/use-task-aggregate.ts`.

## Plan

### 1. Share the Agent input shape

`AgentInput` is a local interface in `agent-tool-view.tsx`. Move it (as a zod
schema + inferred type, parsed rather than cast) into the agent tool plugin's
`core/` barrel so the renderer and the new band read one definition:
`conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/agent/core/`.
Update `agent-tool-view.tsx` to import it.

### 2. New plugin `conversation-view/plugins/running-agents`

```
running-agents/
  CLAUDE.md
  package.json
  core/
    index.ts
    derive.ts          # pure: JsonlEvent[] → SubAgentRun[]
    derive.test.ts
  web/
    index.ts           # Conversation.AbovePromptInput({ id: "running-agents", … })
    components/
      running-agents-band.tsx
      use-running-agents.ts
```

**`core/derive.ts`** — pure and tested:

```ts
type SubAgentRun = {
  toolUseId: string;
  type: string;            // subagent_type ?? "general-purpose"
  description: string;
  model?: string;
  background: boolean;
  startedAt: number;
} & ({ state: "running" } | { state: "done"; endedAt: number });

deriveSubAgentRuns(events: JsonlEvent[]): SubAgentRun[]
```

One pass: collect `task-notification` events by `toolUseId`; for each Agent
tool-call, compute the running/done state by the foreground/background rules
above. Launch order. Returns every run in the conversation; the hook narrows.

**`web/components/use-running-agents.ts`** —
`useResource(jsonlEventsResource, { id })` → `useMemo(deriveSubAgentRuns)` →
keep `running` runs, plus `done` runs whose `endedAt` is within the last 3 s
(the "done m:ss" linger). If `!hasLiveProcess(conversation.status)`, return
none. Returns the `useResource` state as-is while loading, so the band renders
nothing rather than a false "0 agents".

The linger needs a re-render when it expires: one `setTimeout` to the earliest
linger end, reset whenever the input changes. That is a timer for a
presentational fade, not a poll — the data itself arrives pushed.

**`web/components/running-agents-band.tsx`** — renders `null` when there are
no rows. Otherwise:

- Card chrome matching the turn-summary card / op-status banner (bordered,
  rounded, muted background), built from the css primitives
  (`Clip`, `Stack`, `Text`, `Badge variant="muted"`) — no ad-hoc layout.
- Summary line is the toggle button (`aria-expanded`), using `Collapsible`
  (`primitives/collapsible`) with `defaultOpen`: spinner · "**N** agents
  working" · "longest" + clock · spacer · chevron. The spinner comes from
  `primitives/loading` if it has a small inline spinner; otherwise a small
  ring with `motion-safe:animate-spin`.
- Rows: the running agents list is a homogeneous set of domain records, so it
  is a `DataView` with `views={["list"]}` (per the data-view rule), toolbar
  hidden, fields: dot, type, description (label, truncates), model and
  background tags, clock (trailing). Row click opens that agent's report pane
  (`agentReportPane`, already exported by the agent tool plugin) — same as the
  "View report" link on its transcript card.
- Clocks: `ElapsedTime` / `formatElapsed` from `primitives/relative-time`;
  done rows show a check + "done" + `formatElapsed(endedAt - startedAt)`.
- Many agents: the list caps at ~4 rows and scrolls inside the card.
- All greys: `text-muted-foreground`, `bg-muted`, no categorical colours.

Wire it: `Conversation.AbovePromptInput({ id: "running-agents", component:
RunningAgentsBand })`. It stacks with op-status / turn-summary through the
slot's existing `gap-sm`, and the slot is reorderable, so the user can move it.

### 3. Docs

`running-agents/CLAUDE.md` (what it shows, the foreground/background rule,
why there is no stop). `./equin build` regenerates the plugin registry
and `docs/plugins-*.md`.

## Critical files

- New: `plugins/conversations/plugins/conversation-view/plugins/running-agents/**`
- Edit: `.../jsonl-viewer/plugins/tool-call/plugins/agent/web/components/agent-tool-view.tsx`
  and a new `.../agent/core/index.ts` (shared `AgentInput`)
- Read-only reuse: `jsonlEventsResource` (jsonl-viewer/core),
  `hasLiveProcess` (conversations/core/status.ts),
  `ElapsedTime`/`formatElapsed` (primitives/relative-time),
  `Conversation.AbovePromptInput` (conversation-view/web/slots.ts),
  `agentReportPane` (agent tool plugin), `use-task-aggregate.ts` (pattern).

## Verification

1. `./equin test plugins/conversations/plugins/conversation-view/plugins/running-agents`
   — `derive.test.ts` covers: foreground running → done; background with the
   placeholder result stays running until its `task-notification`; interrupted
   foreground (error result) ends; notification for an unknown `toolUseId` is
   ignored; non-Agent tool-calls ignored; launch order kept.
2. `./equin build` (background), then in the deployed worktree open a
   conversation and ask the agent to launch two foreground and one background
   Explore sub-agent: the band appears with 3 rows and ticking clocks; each row
   turns to "done" and leaves as it finishes; the band disappears after the last.
   Fold/unfold via the summary line. Click a row → the report pane opens.
3. Screenshot via `e2e-harness/e2e/screenshot.ts --path /agents/c/<id>` in light
   and dark, and alongside the op-status banner during a build, to confirm the
   boxes stack cleanly.
4. `./equin check` (boundaries, data-view rule, lint) passes.
