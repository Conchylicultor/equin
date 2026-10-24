# Running sub-agents above the prompt box — v2

Supersedes `2026-09-22-conversations-running-subagents-band.md`. The design (what
the user sees) is unchanged; the data layer is rewritten, because main landed
both things v1 had to build for itself.

## What changed under us

Two commits landed on main while v1 was being written:

- **`34eafe687` — the `jsonl-viewer/plugins/subagents` plugin.** It reads the
  `subagents/` dir beside a conversation's session files and publishes
  `subagentActivityResource` (every sub-agent of a conversation, in start order:
  `agentType`, `description`, `model`, `requestShape`, `startedAt`,
  `lastActivityAt`, `lastStep`), plus `subagentRunState` — the one
  three-armed authority on `running` / `finished` / `ended-without-reporting`.
- **`882ea6bef` — DataView's hosted toolbar.** `toolbar={{kind:"hosted",frame}}`
  draws no band; the surface's own card hosts the options trigger. This is the
  option the prerequisite task added, and it is what the band's row list uses.

v1's `running-agents/core/derive.ts` (plus its 8 tests) is **deleted**: it
answered "which sub-agents are running" from the parent transcript alone, which
main now answers better — from what each sub-agent actually wrote, with a third
state v1 could not express (killed / died with the session) and coverage of
named in-process teammates, which have no `Agent` card at all.

What survives from v1: the whole UI, and the shared `AgentInput` zod schema in
the agent tool plugin's `core/` (already rebased, `agent-tool-view.tsx` parses
instead of casting).

## Design (unchanged, user-confirmed)

Its own box above the prompt box via `Conversation.AbovePromptInput`, alongside
the op-status banner and turn-summary card. Summary line — spinner ·
"**N** agents working" · "longest m:ss" · chevron — open by default, click to
fold. One row per agent: dot, type, description (truncates first), model tag,
"background" tag, **what it last did** (new in v2, now that `lastStep` exists),
elapsed clock. Monochrome. No stop action. A finished agent lingers ~3 s with a
check and "done m:ss". Hidden when nothing runs. Spinner held still under
`prefers-reduced-motion`.

## Plan

### 1. `subagents` plugin: the conversation-wide read (new)

`useSubagentStatus` answers for ONE sub-agent, joined from a card. The band
needs the set, so add the list-level twin **in the subagents plugin** (it owns
this question; the band must not re-derive it):

- `core/join.ts` — add the mirror of `describedSubagent`: given a row and the
  parent's tool-call events, find the `Agent` call that spawned it (match
  `toolUseId`, else `requestedName` === `row.name`). Pure, unit-tested beside
  the existing `join.test.ts`.
- `web/internal/use-subagent-statuses.ts` — `useConversationSubagents(convId)`:
  subscribes once to `subagentActivityResource`, `jsonlEventsResource` and the
  conversation, gates on all three (`pending` arm, never a false empty), and
  returns one entry per row: `{ row, state, startedAt, endedAt, lastStep,
  agentToolEvent }`. `useSubagentStatus` should be refactored to read from it
  so the join lives in one place.
- Export both from the plugin's web/core barrels; update its `CLAUDE.md`.

### 2. `conversation-view/plugins/running-agents` (rework of the v1 skeleton)

Delete `core/derive.ts` + `core/derive.test.ts`; `core/` likely disappears
entirely.

- `web/components/use-running-agents.ts` — `useConversationSubagents` →
  keep `state.kind === "running"`, plus `finished` / `ended-without-reporting`
  rows whose `endedAt` is within the last 3 s (the linger). One `setTimeout` to
  the next expiry; a past expiry fires at once. Returns the pending arm while
  any read is still loading, so the band renders nothing rather than "0 agents".
- `web/components/running-agents-band.tsx` — `null` when no rows. Card chrome
  like `TurnSummaryCard` / `OpStatusBanner`; summary line is the
  `Collapsible` trigger (`defaultOpen`, `aria-expanded`); rows are a
  **DataView with `toolbar={{kind:"hosted",frame}}`**, `views={["list"]}`,
  the card hosting the options trigger — read
  `research/2026-09-22-primitives-data-view-hosted-toolbar.md` and data-view's
  `CLAUDE.md` first. Row click opens `agentReportPane` (now exported).
  Clocks from `primitives/relative-time`; last step rendered with the
  subagents plugin's own `SubagentLastStep` / `formatLastStep` rather than a
  second spelling.
- `web/index.ts` — `Conversation.AbovePromptInput({ id: "running-agents", … })`.
- `CLAUDE.md`: what it shows, that state comes from the subagents plugin, and
  why there is no stop button.

### 3. Verify

- `./equin test` on both plugins (new join tests; a jsdom test of the band
  over fixture rows: running, background running, just-finished lingering,
  ended-without-reporting).
- `./equin build` (background, then `./equin await`), then screenshot
  `/agents/c/<id>` light + dark, and during a live fan-out of three sub-agents.
- `./equin check`.

## Critical files

- New: `.../jsonl-viewer/plugins/subagents/web/internal/use-subagent-statuses.ts`,
  additions to `.../subagents/core/join.ts`
- Rework: `plugins/conversations/plugins/conversation-view/plugins/running-agents/**`
- Reuse: `subagentActivityResource`, `subagentRunState`, `describedSubagent`,
  `agentCallJoin`, `SubagentLastStep`, `subagentStateDisplay`,
  `hasLiveProcess`, `ElapsedTime`, `Conversation.AbovePromptInput`,
  DataView hosted toolbar.
