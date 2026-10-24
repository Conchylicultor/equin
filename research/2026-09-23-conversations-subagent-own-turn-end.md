# Sub-agents read their own "turn ended" marker

## Context

A sub-agent started by ANOTHER sub-agent keeps reading "Running" (band count, ticking
clock, report-pane badge) until the whole conversation stops. Seen on
conv-1790156090-2opp: six named teammates (`test-only-batch1…6`, `parentAgentId:
a921fd41aec51d055`) all ended their turn around 15:05; at 16:20 the band still said
"6 agents working · longest 1:19:40".

`subagentRunState` (`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/core/run-state.ts`)
only looks at the CONVERSATION's transcript: the foreground `tool_result`, or a
`task-notification` carrying the sub-agent's tool-use id. Otherwise it answers
"running while the conversation process is live". A nested sub-agent can never get
either signal there. Checked on disk: the parent transcript mentions the teammates only
in a roster listing — no completion line of any kind. So the only place that can say
they stopped is their own transcript.

The existing doc comment says "there is no end-of-run marker inside a sub-agent's own
transcript". That is not quite true. Claude Code writes each assistant message in
streamed pieces with `stop_reason: null`, and the LAST piece of a finished turn carries
`stop_reason: "end_turn"` (or `"stop_sequence"`). The six teammates' transcripts all end
that way.

### How reliable is it (measured over the 876 sub-agent transcripts on this machine)

Newest assistant/user line of each transcript:

| newest line                          | count |
| ------------------------------------ | ----- |
| assistant, `end_turn`                | 572   |
| assistant, `stop_reason: null`       | 283   |
| user                                 | 11    |
| assistant, `stop_sequence`           | 5     |
| assistant, `tool_use`                | 2     |

Most of the `null` endings come from Claude Code versions that never wrote `end_turn`
at all (the whole file has none). Recent versions (2.1.27x–2.1.280) write it consistently,
for plain sub-agents and teammates alike. So the marker is **positive evidence only**:
present ⇒ the turn ended; absent ⇒ we know nothing, and the current fallback stays.

## Approach

Add one more piece of evidence, read from the sub-agent's own transcript by the tail read
that already runs on every append, and consult it in `subagentRunState` after the parent's
signals and before the liveness fallback.

### 1. Core rule — `turnEndedOfLines(lines)` (new, beside `lastStepOfLines`)

File: `subagents/core/last-step.ts` (or a sibling `turn-end.ts`, exported from `core/index.ts`).

Walk the window backwards, skipping every line whose `type` is not `assistant` or `user`
(attachments, system, queue operations — the harness appends these after the final
message; the teammates' tails show exactly that). The first assistant/user line decides:

- `assistant` with `message.stop_reason` ∈ {`end_turn`, `stop_sequence`} ⇒ `true`
- anything else (a streamed piece with `null`, `tool_use`, any `user` line — a tool
  result, or a message that woke an idle teammate) ⇒ `false`

A woken teammate appends a user line, so the next tail read flips it back to `false` →
running. The reading follows the file; nothing is latched.

### 2. Carry it on the row

- `core/protocol.ts`: `SubagentBaseSchema` gains `turnEnded: z.boolean()` — documented
  as positive-only (`false` = "no end marker seen", never "still working").
- `server/internal/tail-read.ts`: `readLastStep` becomes a read returning
  `{ lastStep, turnEnded }` from the same parsed window (one read, two rules).
- `server/internal/activity-scan.ts`: `TranscriptState` stores `turnEnded`; the base row
  sets it (`false` when there is no transcript yet). The existing `(mtime, size)` cache
  keeps it one bounded read per append.

### 3. Use it in the run state

`core/run-state.ts`: `SubagentRunStateInput` gains `turnEnded: boolean | undefined`
(`undefined` = no row yet). Order:

1. foreground `tool_result` ⇒ finished (unchanged)
2. background `task-notification` ⇒ finished (unchanged)
3. **own transcript's newest turn ended ⇒ finished** (new)
4. conversation live ⇒ running, else ended-without-reporting (unchanged)

Decided: no new "Idle" arm. A teammate that ended its turn reads "Finished"; if a
message wakes it, the next tail read flips it back to "Running".

Applies to every sub-agent, not only nested ones: a plain sub-agent whose turn ended is
done (the harness does not re-invoke it), and this also covers one whose notification
never lands. Rewrite the doc comment that says no end marker exists.

`web/internal/use-subagent-statuses.ts`: pass `row.turnEnded` in both places
(`entries` and `statusOf`). Everything downstream — the band's working count
(`running-agents/web/internal/agent-rows.ts`), `endedAt`, the pane badge,
`subagentStateDisplay` — already keys off the state, so no change there.

### What it does not fix

A nested sub-agent from an older Claude Code version that never wrote `end_turn` still
reads "Running" until the conversation stops. There is no signal on disk for it; the
fallback is unchanged. A nested sub-agent killed mid-turn while the conversation is still
live likewise has none.

## Files

- `…/subagents/core/last-step.ts` (+ test) — `turnEndedOfLines`
- `…/subagents/core/protocol.ts` — `turnEnded` on the base row
- `…/subagents/core/run-state.ts` (+ `run-state.test.ts`) — third evidence step, doc fix
- `…/subagents/server/internal/tail-read.ts` (+ test), `activity-scan.ts` (+ test)
- `…/subagents/web/internal/use-subagent-statuses.ts`
- `…/subagents/CLAUDE.md` — the state rules
- Test fixtures building rows (`running-agents/web/internal/agent-rows.test.ts`,
  `running-agents-band.test.tsx`, `join.test.ts`, `discovery.test.ts`) gain `turnEnded`

(`…` = `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents`)

## Verification

- Unit tests: `turnEndedOfLines` on real-shaped tails (end_turn followed by attachment
  lines ⇒ true; streamed `null` piece ⇒ false; trailing user/tool_result ⇒ false;
  woken teammate ⇒ false); `subagentRunState` with a nested background teammate
  (no tool-use id, no notification, conversation live, `turnEnded: true`) ⇒ finished.
- `./equin test plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents plugins/conversations/plugins/conversation-view/plugins/running-agents`
- `./equin build`, then open conv-1790156090-2opp on this worktree's deploy with the
  screenshot script: the band no longer counts the six teammates as working, and their
  report panes read "Finished".
