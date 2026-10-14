# Fold harness-injected context in the transcript

## Context

Claude Code injects a burst of context attachments into the JSONL at session start and again
after every compaction: `instructions`, `session_context`, `date`, `credential_org`,
`remote_session_change`, `prompt_snapshot`, `environment`, `model`, `deferred_tools_delta`,
`agent_listing_delta`, `skill_listing`, `auto_mode`, `mcp_instructions_delta`, `invoked_skills`,
and others. The transcript renders each one as its own row. `invoked_skills` has no renderer, so
it shows as a raw `attachment:invoked_skills` card. After a compaction there is also a
`System · informational  Compacted while idle…` line. The conversation gets pushed below a stack
of noise.

Compactions already fold into one `Context compacted · 318k → 10k` divider
(`research/2026-10-13-conversations-compaction-divider.md`). The user wants the re-injected
context folded into that divider too, and the session-start context folded into a similar
section, done generically.

Constraints from the user:

1. Nothing is lost: collapsed is fine, hidden is not.
2. The grouping is not done in the parser. Other readers (token budget, artifacts, subagents,
   outline) keep seeing every event.
3. A member nobody renders keeps the fallback row and its investigate / raw-JSON actions.

## What the JSONL actually looks like (conv-1791818418-k72458)

```
attachment instructions, session_context, date, credential_org, remote_session_change, prompt_snapshot
user       "Cold start: …"                       ← first prompt splits the start burst in two
attachment environment, model, deferred_tools_delta, agent_listing_delta, skill_listing, auto_mode,
           total_tokens_reminder (already hidden by token-budget's EventFilter)
…
assistant/tool calls, then mid-turn: prompt_snapshot, deferred_tools_delta, mcp_instructions_delta
…
system     compact_boundary            ┐
user       isCompactSummary            │ already folded into the `compaction` event (parser)
attachment file / compact_file_reference ┘
attachment invoked_skills, deferred_tools_delta, agent_listing_delta, mcp_instructions_delta,
           environment, model
system     informational "Compacted while idle, before the prompt cache expired"
```

This trace shapes the design in three ways:

- **Grouping is by kind, not by position.** The start context arrives in two runs, one on each
  side of the first prompt, and smaller runs also arrive mid-conversation.
- **Some attachments are conversation, not context.** `file` (an @-mentioned file),
  `hook_*_error`, `task_reminder`, `queued_command` and `edited_text_file` must stay visible
  rows. A blanket "fold every attachment" rule is wrong.
- **Unclassified lines show up inside the runs.** `invoked_skills` and `credential_org` have no
  renderer, and the informational system line has no special handling. They need to join a run
  without classifying every unknown subtype as context. A lone informational notice such as
  "Usage limit reached" must stay a row.

## Design

The fold is a view step in `jsonl-viewer`, applied after the `EventFilter` and before the rows.
The events themselves are untouched. Each member still renders through its own
`EventRow` → `EventRenderer.Dispatch`, so renderers, row actions, investigate and raw-JSON all
work as they do today. The fold only decides which rows sit behind a disclosure.

### 1. Classification: an event's context role (open set, declared by the renderer owner)

`jsonl-viewer/web/slots.ts` gets a new behaviour slot:

```ts
type ContextRole = "context" | "ambient";
// context: harness-injected model context; it can start a fold.
// ambient: it joins a fold it sits inside or next to, but never starts one.
// undefined: conversation; it breaks a fold.
JsonlViewer.ContextRole: defineSlot<{ id: string; useRole: Hook<() => (e: JsonlEvent) => ContextRole | undefined> }>
```

- The value is a hook (`framework/hook-value`'s `Hook` brand) because a contributor reads its own
  dispatch registry to answer.
- jsonl-viewer combines all contributions into one `useContextRole()`. The first defined answer
  wins, and each contributor only answers for its own kind.
- **attachment plugin**: `JsonlViewerAttachment.Renderer` gains `Extra = { context?: true }`,
  following the precedent of `BlockFrameMeta` and `CounterpartKindMeta`. Its `useRole` resolves
  as follows:
  - matched contribution with `context: true` → `"context"`;
  - matched contribution without it → `undefined`;
  - unmatched subtype (fallback) → `"ambient"`.

  The classification sits on the same line as the renderer in each subtype plugin, so whoever
  adds a subtype decides its role.
- **system plugin**: `subtype === "informational"` → `"ambient"`.
- **Subtypes marked `context: true`** (one line per plugin): `instructions`, `session-context`,
  `date`, `remote-session`, `prompt-snapshot`, `environment`, `model`, `deferred-tools`,
  `agent-listing-delta`, `skill-listing`, `mcp-instructions-delta`, `command-permissions`,
  `team-context`, `nested-memory`, and `session-mode` for `auto_mode` only (plan-mode
  enter/exit stay rows).
  - `session-mode` matches 4 subtypes with one contribution. It is split into two
    contributions, or `context` takes a predicate. The implementation picks one.
- **Left as rows**: `file`, `edited_text_file`, all hooks, `task_reminder`, `queued_command`,
  `structured_output`, tool-output notices, harness nudges, `directory`.

### 2. Grouping: a pure function

`jsonl-viewer/web/context-runs.ts` exports:

```ts
groupContextRuns(events, role, isHost) → Item[]
// Item = { kind: "event", index } | { kind: "fold", host?: index, members: index[] }
```

- A **run** is a maximal stretch of consecutive visible events whose role is `context` or
  `ambient`, holding at least one `context`.
  - A run can never cross a `user-text`, because that is conversation. The sticky sections in
    `EventSections` therefore keep working unchanged: grouping runs per section.
- A run directly after a **host** event (see §3) attaches to that host. This includes a run of
  only one member.
- Any other run of 2 or more members becomes a standalone fold. A single member stays a plain
  row, since folding it buys nothing.
- Indices refer to the visible array. Each member's `EventRow` keeps its `data-event-index` and
  `data-event-key`, so outline and anchors do not change. The fold wrapper carries the first
  member's key, so scroll persistence lands on the fold while it is collapsed.
- Unit test: `context-runs.test.ts`, pure logic, built from the trace above.

### 3. Rendering: a `ContextFold` row, and hosts

- **`ContextFold`** (jsonl-viewer/web, exported) is a thin rule in the same visual language as
  the compaction divider:
  - layout: hairline · icon · label `· N items` · chevron · hairline;
  - closed by default;
  - when opened, it renders each member as a full `EventRow`, behind a left hairline.
- **Labels** are sentence case, with a middot-led note:
  - `Session context · 7 items` for runs before the conversation's first assistant event;
  - `Context update · 3 items` for later runs.
- **Hosts.** `JsonlViewer.EventRenderer` gains `Extra = { hostsContext?: true }`.
  - When a host event is followed by a run, `EventRow` provides the rendered run through a
    `HostedContext` React context, and the host renderer places `<HostedContext/>` in its own
    fold.
  - The compaction plugin is the only host. It declares `hostsContext: true`, and `CompactionRow`
    adds a third block after "Re-read after compacting": `Context re-injected · N items`, a nested
    `ContextFold`.
  - `hasFold` becomes true when context is present, even with no summary or files.
  - Loss guard (rung 4): if the provided context is never mounted by the host, `EventRow` throws
    in dev. A host that forgets it fails loudly instead of dropping rows silently.

### 4. Interactions

- Token budget, artifacts, subagents, outline, event-counter and server readers do not change:
  none of them read the folded view.
- `useVisibleEvents` stays the single enumerator. Folds are a rendering of it, not a filter.
- Sub-agent transcripts get the fold automatically, because they render through the same
  `TranscriptView`.

## Files

- `jsonl-viewer/web/slots.ts` — `ContextRole` slot, `hostsContext` Extra on `EventRenderer`.
- `jsonl-viewer/web/context-runs.ts` (+ test), `web/components/context-fold.tsx`,
  `hosted-context.tsx`; `transcript-view.tsx` (`EventSections` renders items);
  `event-row.tsx` (hosted-context provider and dev assert); `web/index.ts` exports; `CLAUDE.md`
  (renderer rule: "declare your subtype's context role").
- `jsonl-viewer/plugins/attachment/web/{slots.ts,index.ts}` — `context` Extra, `useRole`
  contribution.
- `jsonl-viewer/plugins/attachment/plugins/<subtype>/web/index.ts` — `context: true` on the
  listed contributions (e.g. `environment`, `model`, `skill-listing`).
- `jsonl-viewer/plugins/system/web/index.ts` — the ambient role for `informational`.
- `jsonl-viewer/plugins/compaction/web/{index.ts,components/compaction-row.tsx}` — host.
- `research/2026-10-13-conversations-compaction-divider.md` — link to this doc.

## Verification

- `./singularity test plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer`
  covers `groupContextRuns`:
  - the two start runs split by the prompt;
  - an ambient-only run stays a row;
  - a single context member stays a row unless hosted;
  - an ambient run attaches to the compaction;
  - `file` and hook rows break a run.
- `./singularity build`.
- Extend `compaction/e2e/compaction-divider.ts` on conv-1791818418-k72458:
  - "Session context" folds are present and closed;
  - no `attachment:invoked_skills` row is visible at top level;
  - after opening the divider, `Context re-injected · N items` is present;
  - after opening that, the `invoked_skills` fallback card shows its investigate action;
  - screenshots are taken folded and unfolded.
