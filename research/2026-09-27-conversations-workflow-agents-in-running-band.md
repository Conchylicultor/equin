# Workflow sub-agents in the running-agents band

## Context

Agents spawned by a `Workflow` tool call never show up in the conversation's
running-agents band (seen on `conv-1790464521-viz8`: 13 workflow agents, band empty).

Claude Code writes them one folder deeper than an ordinary sub-agent:

```
<session>/subagents/
├── agent-<id>.jsonl / .meta.json          ← ordinary sub-agents (what we read)
└── workflows/
    └── wf_<runId>/
        ├── agent-<id>.jsonl / .meta.json  ← workflow agents (never read)
        └── journal.jsonl                  ← {"type":"launched"} / started{agentId,label,phase} / result{agentId,result}
<session>/workflows/wf_<runId>.json        ← run summary, written at the END of the run (status, …)
```

- `listSubagentEntries` (`subagents/server/internal/discovery.ts`) does one flat
  `readdir` per root and keeps only `agent-*` names, so `workflows/` is skipped.
- The transcript watcher routes an event by **exact dirname**
  (`transcript-watcher/server/internal/watcher.ts`, `watchIndex.get(dirname(path))`),
  so writes inside `wf_<runId>/` wake nothing either.
- A workflow agent's meta is `{agentType:"workflow-subagent", description:<label>,
  workflowPhase, spawnDepth:1, requestShape:"foreground"}`. It has no `toolUseId`
  and no `parentAgentId`, so even once discovered it would join no `Agent` call.
  With `requestShape` set to foreground, only `turnEnded` or the parent's liveness
  would decide whether it is still running.
- The parent's `Workflow` call result carries `Run ID: wf_<runId>` (already parsed by
  `parseWorkflowResult` in `tool-call/plugins/workflow/web/internal/parse-workflow.ts`).
  The run's end arrives as a `task-notification` whose `tool-use-id` is that call's id.

Outcome: workflow agents appear in the band, grouped under one row for their
workflow run, with an honest running / finished / ended-without-reporting state.
Their report pane opens as it does for any sub-agent.

## Design

### 1. Discovery and watching — `subagents/server/internal/discovery.ts`

`subagentDirs` stays the **only ownership root** (anchored session dirs). The
workflow layout is walked *below* those roots, never resolved from elsewhere, so
the cross-conversation guard still holds.

- `SubagentEntry` gains `workflowRunId?: string` (the `wf_…` folder name).
- `listSubagentEntries(roots)`: the existing flat pass, plus for each root a
  `readdir(<root>/workflows)` (ENOENT is ordinary). For each `wf_*` child, list its
  `agent-*` files and tag them with `workflowRunId`. Agent ids are globally unique.
  If the same id turns up twice, first-wins as today.
- New `workflowJournalPathsOf(entries)` / a `WorkflowRunDir` list (runId, dir,
  journalPath) returned alongside, so callers need no second walk.
- New `subagentWatchDirs(roots)` = roots + `<root>/workflows` + every run dir. Use
  it in `resolveActivityTargets` (activity-scan.ts) and in
  `transcript-read.ts`'s starting-transcript `dirs`. Parent-folder routing then
  covers: `workflows/` being created (dirname = root), a new `wf_*` folder
  (dirname = `workflows`), and every agent or journal write inside a run.
  Files born in the same event batch as their folder are still picked up,
  because the re-resolve re-reads the disk. The watcher's existing reconcile
  sweep is the backstop.
- `signaturePathsOf` also includes each run's `journal.jsonl`, so a `result` line
  moves the signature.

`findSubagentByAgentId` / `findSubagentIn` go through `listSubagentEntries`, so the
report pane (`{by:"agent"}`) finds workflow agents with no further change.

### 2. Journal read — new `subagents/server/internal/workflow-journal.ts`

The journal only grows, and one run's is ~370 KB (results embed each agent's
structured output), so read it **incrementally**. Per scope, cache per journal
path `{offset, reported:Set<agentId>}`. When the stat grows, read
`[offset, size)`, parse only complete lines (advance `offset` to the last `\n`),
and zod-parse `{type:"result", agentId}` into `reported`. Ignore other types.
A line that fails to parse is skipped **per line** (logged), never failing the
scan. A shrink or mtime reset resets the cache. Evicted with
`evictActivityScan`.

### 3. Row shape — `subagents/core/protocol.ts` + `activity-scan.ts`

- `SubagentMetaSchema` + `DescribedSubagentSchema` gain `workflowPhase?: string`.
- `SubagentBaseSchema` (both arms: an unreadable meta inside a run still belongs to
  the run) gains
  `workflow?: { runId: string; reported: boolean }`.
  `reported` = the journal holds this agent's `result`.
- `scanActivityIn` fills it from the entry's `workflowRunId` and the journal cache.

Everything stays in the existing `subagentActivityResource` payload. No new resource.

### 4. Run state — `subagents/core/run-state.ts` + `use-subagent-statuses.ts`

The journal is to a workflow agent what the parent's `tool_result` is to a
foreground `Agent` call, and the run's `task-notification` is the background
signal. Add two inputs to `SubagentRunStateInput`:

- `workflowReported: boolean | undefined` → `finished` (checked first).
- `workflowRunEnded: boolean | undefined` → after `turnEnded`, before liveness:
  a run that has ended while this agent never reported means `ended-without-reporting`.

New in `subagents/core` (e.g. `workflow-join.ts`):
- `WORKFLOW_TOOL_NAME = "Workflow"`, `workflowCallsIn(events)`.
- `workflowRunIdOf(call)` — the `Run ID: (wf_[\w-]+)` read. **Move**
  `parse-workflow.ts` to a new `tool-call/plugins/workflow/core` barrel (pure, no
  imports), and have both the workflow web view and `subagents/core` import it.
  That adds the edge subagents → workflow/core. The workflow plugin imports
  nothing from subagents, so there is no cycle. (Unlike the `Agent` card, which
  is why `AGENT_TOOL_NAME` is duplicated.)

`useConversationSubagents` then also returns
`workflowRuns: WorkflowRunEntry[]`, derived once, for every `runId` seen on a row:

```ts
interface WorkflowRunEntry {
  runId: string;
  call: ToolCallEvent | undefined;   // the Workflow call naming this run, if still in the kept chain
  state: SubagentRunState;           // notification for call.toolUseId → finished;
                                     // no call → running iff any of its agents is running;
                                     // else parent liveness
  startedAt: Date;                   // call.at, else earliest agent startedAt
  endedAt: Date | null;              // notification time, else latest agent end
}
```

Each agent entry passes `workflowReported` and `workflowRunEnded` (= its run's
state is not `running`) into `subagentRunState`. This plugin remains the single
place where state is derived. The band derives nothing.

### 5. The band — `running-agents/web`

- `RunningAgentRow` becomes a two-arm union on `kind: "agent" | "workflow"`
  (shared: `key, parentKey, description, state, startedAt, endedAt`).
  - Workflow row: `key = "workflow:<runId>"`, `parentKey = null`, `description` =
    the Workflow script's `meta.name` (from the moved `parseWorkflowMeta` on
    `call.input.script`), else the runId. Its `type` cell reads "workflow".
  - Workflow agent row: `parentKey = "workflow:<runId>"`, and the type cell shows
    `workflowPhase` when present (the meta's `agentType` "workflow-subagent" is
    noise).
- `visibleAgentRows` already keeps ancestors of shown rows and lingers ended rows,
  so the run row shows while it or any agent under it is shown. A run between
  phases with no live agent still reads as running, which is true.
- `summarizeAgents` counts **agent** rows only ("3 agents working").
- `rowActivation`: an agent row opens `agentReportPane` `{by:"agent"}` as today.
  A workflow row opens nothing, and folding it is its only interaction. There is
  no whole-run pane today, and the transcript's Workflow card already shows the DAG.
- `leadingIcon`: the same status dot for both arms.

### 6. Docs

Update `subagents/CLAUDE.md` (the second on-disk layout, the journal as a
completion signal) and `running-agents/CLAUDE.md` (the hierarchy section: the run
row as the parent of workflow agents).

## Files

- `jsonl-viewer/plugins/subagents/server/internal/{discovery,activity-scan,transcript-read}.ts`, new `workflow-journal.ts`
- `jsonl-viewer/plugins/subagents/core/{protocol,run-state,index}.ts`, new `workflow-join.ts`
- `jsonl-viewer/plugins/subagents/web/internal/use-subagent-statuses.ts`
- `jsonl-viewer/plugins/tool-call/plugins/workflow/{core/index.ts (new), web/…}` (parse-workflow move)
- `running-agents/web/{internal/agent-rows.ts, components/running-agents-band.tsx, components/use-running-agents.ts}`

## Verification

- Unit tests (`./equin test <plugin>`):
  - `discovery.test.ts`: a temp root containing flat agents, `workflows/wf_a/agent-*` and a
    journal. Entries are tagged, watch dirs include `workflows` and `wf_a`, and
    signature paths include the journal.
  - `workflow-journal` test: incremental offsets, a partial trailing line, a
    malformed line skipped, reset on shrink.
  - `run-state.test.ts`: reported → finished; run ended and not reported →
    ended-without-reporting; `turnEnded` still wins over a live run.
  - `agent-rows.test.ts`: run row + children, ancestor kept while a child
    lingers, summary counts agents only.
- `./equin build`, then in the deployed worktree app, launch a small workflow
  (2 phases, 2–3 agents) from a conversation. Screenshot with
  `e2e-harness/e2e/screenshot.ts --path /agents/c/<id>`. Check that the band shows
  the run row with agents under it, agents flip to done as their `result` lands,
  the band leaves ~3 s after the run's notification, and clicking an agent row
  opens its report.
- Reopen `conv-1790464521-viz8` (finished runs): its old workflow agents must
  **not** show, because they are finished and past the linger.
