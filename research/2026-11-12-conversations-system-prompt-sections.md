# System-prompt sections: per-agent context out of MCP server instructions

## Context

Per-agent context (the Mandate, the global page instructions, the Task tree) reaches
an agent today as **MCP server instructions** (`Mcp.instructions`, rendered on
`initialize`). Two problems:

- **Claude Code cuts MCP server instructions at 4,096 characters, silently.**
  `conv-1794373741-jgbkfw` (supervisor) got Mandate 2,029 + Page instructions 2,213
  → the "Supervisor instructions" global card was cut mid-header and the whole
  Task tree dropped, while `renderGlobalSection` had recorded the card as delivered
  (so no later `read_page` / refused write re-sent it).
- **Wrong channel.** MCP instructions describe how to use an MCP server's tools.
  These sections are context about *this agent and its task*; they ride MCP only
  because `Mcp.instructions` was the hook that existed.

The SDK runtime already appends to Claude Code's system prompt
(`systemPrompt: { preset: "claude_code", append }`, `runtime-sdk/bin/agent.ts:467`),
today carrying only the task preprompt. No 4 KB cap, survives compaction,
re-rendered on every spawn.

Also: the Mandate is mostly redundant with the tools it gates — a gated tool only
appears when granted, and its own description (add_task's `liveDescription` even
ends with "## Your mandate allows …") states the same limits. Its size is the main
reason supervisor sessions overflowed.

Outcome: one extensible, uncapped channel for agent context; a Mandate that says
only what no tool says; each section's cost visible under **System prompt** in the
context card.

## Design

### 1. `conversations/system-prompt` plugin (new)

`server/` (portable) — the contribution and the composer:

```ts
export const SystemPrompt = {
  Section: defineServerContribution<SystemPromptSection>(
    "conversations.system-prompt.section", { docLabel: (s) => s.id }),
};
interface SystemPromptSection {
  id: string;              // stable, also the wrapper id and the card's row label key
  label: string;           // "Mandate", "Page instructions", "Task tree"
  render(conversationId: string): Promise<string | null>; // null = nothing to add
}
export async function composeSystemPromptAppend(
  conversationId: string, preprompt: ConversationPrepromptSnapshot | undefined,
): Promise<string | undefined>
```

- Sections render in parallel, joined in **id order** (as `Mcp.instructions` does;
  no numeric order), after the preprompt's `<special_instructions>` block.
- Each section is wrapped `<equin-context id="mandate">…</equin-context>` so the
  prompt-snapshot viewer and `extractPreprompt` (first-match regex,
  `transcript-source/core/protocol.ts:26`) keep working and sections stay
  attributable in the transcript.
- **Failure isolation** reused from `infra/mcp/machine/internal/isolate.ts`
  semantics: a throwing section is reported (crash report) and replaced by a
  "section unavailable" notice; the spawn goes on. (Move `runContribution` to a
  shared leaf if it is not importable from `server/`.)
- **Records what it composed**: one upsert into
  `conversations_ext_system_prompt` (`conversationId` PK, `sections:
  [{ id, label, chars }]`, `renderedAt`) — via the entity-extensions primitive,
  like `conversations_ext_context_usage`. Served as a lookup-only live collection
  `conversations.system-prompt` (`serveCollection`, by id).

### 2. One seam: render at spawn, never at enqueue

`systemPromptAppend()` (`conversations/server/internal/lifecycle.ts:255`) becomes
`composeSystemPromptAppend(conversationId, preprompt)` and is called **right
before `runtime.create`** at every spawn site:

- `spawn-job.ts` (~130): first launch and retries. The job input stops carrying a
  rendered `appendSystemPrompt`; it carries nothing and the job renders, so a job
  retried after a server restart renders fresh, not the string from enqueue time.
  `prepareConversation` / `retryLaunch` drop their `appendSystemPrompt` field.
- `finishConversation` (fork / reuse-attempt inline create, ~617).
- `respawnResume` (~804): every resume after stop / hibernate / rewind.

Bound (stated, not fixed): runtime-sdk's internal relaunches
(`moveToLaunchAccount`, rewind via `stop`, `launch-options.ts:107-145`) replay the
stored options file, so they keep the append of their spawn. Mid-life changes reach
the agent through event turns (§5), as today.

### 3. Move the three sections, delete `Mcp.instructions`

| Section | From | To `SystemPrompt.Section` | Change |
|---|---|---|---|
| `mandate` | `mandate/server/internal/instructions.ts:34` | same file | renders the shrunk list (§4) |
| `page-instructions` | `agent-access/machine/internal/mcp-tools.ts:501` | `agent-access/server` (portable — `renderGlobalSection` already lives in `server/internal/instructions-gate.ts`) | keep `markInstructionsDelivered` on render: the render is now immediately followed by the spawn that carries it, and every resume re-renders (an edited card is re-recorded at its new hash). Delete the `mcp-page-instructions` log sink — the size is now recorded in §1's table. |
| `tree-digest` | `tasks/machine/internal/tree-digest.ts:71` | `tasks/server` or keep `machine/` contribution | **render a full snapshot, then advance the cursor**: today's initialize render calls `treeDigest()` (full only when no cursor), so a *resumed* process — whose new system prompt replaced the old one — gets only "changed since you last saw it". Render `taskTree()` cut with `fitToBudget` (the compaction `task-tree` fit part already does exactly this, `tree-digest.ts:86` — reuse it) with a section budget (~4,000 chars, footer → `task_tree`), then `store.advance(...)` so later `add_task` digests stay incremental. |

Then **delete `Mcp.instructions`** (registry, `renderInstructions`, the initialize
branch in `handle-mcp.ts:59-68`, docs, tests). Nothing else contributes; leaving it
keeps the 4 KB-capped channel one call away. MCP tool usage belongs in tool
descriptions.

Compaction: `restoreAfterCompaction` keeps skipping global cards — still true,
for the right reason now (they are in the system prompt). Update its comment and
the docs that say "they ride the MCP server instructions"
(`instructions-gate.ts:255`, `agent-access/CLAUDE.md` "At conversation start",
`instructions/CLAUDE.md`). No delivery-check for the system prompt: there is no cap
to detect.

### 4. Shrink the Mandate: `describe` returns `string | null`

`MandateCapabilityEntry.describe: (value: T) => string | null`
(`mandate/server/internal/contribution.ts:13`); `renderMandateInstructions` skips
`null`, and drops the "What you may do in this task's subtree:" preamble when the
list is short. Rule (written on the type's doc): *a line only for what no tool,
gate or CLAUDE.md says.*

| Capability | Line after |
|---|---|
| `tasks.file` (add_task) | none — `add_task`'s liveDescription states the grant |
| `tasks.manage` (edit/drop_task) | none — gated tools, scope in their description |
| `message.tree` | none — gated tools say the same |
| `context.compact` | none |
| `flag.raise` | none |
| `exit.clean` | `on-request`: none (implicit). `when-done`: kept — the only channel saying the agent closes on its own |
| `push.policy` | `on-request`: none (CLAUDE.md). `never` / `safe` / `checks`: kept, one line — the **only** channel for an autonomous or forbidden push (push is a CLI command, no tool to describe it) |
| `report.required` | shortened to the part the stop gate and tool don't say: "Never ask mid-way — decide, or stop." |
| `watch.children` + `watch.tree` | merged into one line: "What happens under the tasks you file (as root agent: the whole tree) arrives as event turns — end your turn, don't poll." |

Interactive default (on-request push, on-request exit) → Mandate section is just
the watch line or absent. Supervisor ≈ 2,029 → ~300 chars.

### 5. Mid-session changes

`mandate/plugins/change-notice`: keep `reconnectMcp` (tool gating changes with the
mandate) and the event turn; reword `notice.ts` from "the `## Mandate` section of
the equin server instructions" to "the Mandate section of your system prompt".
Next spawn renders the new mandate anyway.

### 6. Cost under **System prompt** in the context card

`transcript-stats/plugins/context/web/components/context-card.tsx` `setupDetail`
gains a `"System prompt"` branch (constant next to `MEMORY_FILES_ROW`; confirm the
SDK's exact category name from a live reading). It reads
`useLive(conversationSystemPrompt, { id })` and lists:

- each section: `label`, `~chars/4` tokens (shared helper
  `estimateTokens(chars)` in `system-prompt/core`, shown with `~`);
- **Claude Code** = the row's measured tokens − Σ estimates (clamped ≥ 0).

The preprompt is recorded as a section too (`id: "preprompt"`), so the breakdown
is complete. Loading state while the read is pending (never an empty list).

## Critical files

- new `plugins/conversations/plugins/system-prompt/{server,core}/…`
- `plugins/conversations/server/internal/{lifecycle.ts,spawn-job.ts}`
- `plugins/tasks/plugins/orchestration/plugins/mandate/server/internal/{contribution.ts,instructions.ts}` + every `Mandate.Capability` describe (8 files)
- `plugins/tasks/plugins/orchestration/plugins/mandate/plugins/change-notice/server/internal/notice.ts`
- `plugins/page/plugins/annotations/plugins/agent-access/{machine/internal/mcp-tools.ts,server/internal/instructions-gate.ts,server/index.ts,CLAUDE.md}`
- `plugins/tasks/machine/internal/tree-digest.ts`, `tasks/plugins/orchestration/plugins/tree-digest/server/internal/digest.ts`
- `plugins/infra/plugins/mcp/{server,machine}` (delete `Mcp.instructions`)
- `…/transcript-stats/plugins/context/web/components/context-card.tsx`

## Verification

- Unit: `composeSystemPromptAppend` (order, wrapper, null skip, failing section →
  notice + report, record upsert); mandate render per policy combination
  (interactive → no/short section; supervisor; `checks` push); tree section =
  full snapshot under budget + cursor advanced.
- `./equin test plugins/conversations/plugins/system-prompt plugins/tasks/plugins/orchestration plugins/page/plugins/annotations/plugins/agent-access`
- `./equin check` (boundaries: `server/` contribution imported by tasks/page; `plugins-doc-in-sync`).
- E2E: `./equin build`, launch a supervisor task in this worktree; in its
  transcript the `prompt_snapshot` last segment holds the three
  `<equin-context>` blocks in full, no `mcp_instructions_delta` for `equin`; the
  context card's System prompt row expands into Mandate / Page instructions / Task
  tree / Claude Code. Stop and resume it: the new snapshot carries a full tree
  again. `read_page` on a globally-covered page does not re-deliver the global
  cards.
