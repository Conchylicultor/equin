# Transcript branch filter: drop only proven rewinds

## Context

Claude Code transcripts form a forest of lines linked by `uuid` / `parentUuid`. Today
`activeLineUuids` (`plugins/conversations/plugins/transcript-watcher/core/branch-filter.ts`)
keeps, for each tree, only the single path from the newest line back to the root. Everything
else is treated as an abandoned rewind branch.

That is wrong. Claude Code makes two kinds of branches:

- **Rewinds.** The user resubmits a turn. The new prompt is appended as a **sibling of the
  old prompt** (same `parentUuid`), and the old prompt's subtree is abandoned.
- **Side leaves.** A line hangs off a live node while the conversation carries on from a
  sibling. Examples: parallel tool calls (each `tool_result` is a child of its own `tool_use`
  line), hook attachments, API-error text, `turn_duration` after an interrupt.

The filter drops every side leaf. The user-visible bug: in conv-1790510418-tup0 (session
`0a0041b3…`, lines 651–679), 12 parallel `add_task` calls were made and only the last result
survived. The other cards show "running" (`•••`) with no task link. It is worse than lost
results. When results come back out of order, a whole parallel `tool_use` line is off the
path and the **call itself** vanishes (this session, lines 193–196).

This has already been patched once for one line type: the `attachment` rescue in
`parse-jsonl.ts:377-391`. A second patch for `tool_result` would leave the next side-leaf
shape to be lost silently too.

### Measured on real data

The comparison covered 565 local transcripts (175k uuid lines), running the current rule
against the proposed one. Script: session scratchpad `scan.py`.

- **Every** real rewind (15) is two or more `user`-prompt siblings. No other sibling pattern
  involves a prompt.
- In every case, the file-order-latest prompt sibling is the one the current filter keeps.
- The proposed rule drops **0** lines the current one keeps.
- It restores **4,040** lines: 1,732 `tool_result`, 295 `tool_use` (whole calls), 1,519
  `hook_success`, 221 `hook_additional_context`, 158 `bash_output_audience_note`, 79
  `hook_non_blocking_error`, plus a few `turn_duration`, meta, API-error text and
  permission lines.

## Design

**Keep every line; drop a subtree only when it has been proven rewound.**

- For each parent node, look at its children that are user prompts, as decided by
  `userPromptText` (`transcript-watcher/core/user-prompt.ts`). This is the same predicate a
  rewind cut point uses, so the two definitions cannot drift.
- If there are two or more, every prompt child except the file-order-latest one is
  **superseded**.
- Drop the superseded prompts and all their descendants (DFS over a children map, with a
  visited set as the cycle guard).
- Everything else is kept. That includes disjoint roots (resume / compaction / fresh chain
  sessions), which need no special case any more.

A chain's midpoint fork (ancestor `a2` and fork `b1` as prompt siblings under `u2`) is still
dropped by the same rule. The existing test keeps passing with no special case.

**Failure direction.** An unknown side-leaf shape is now shown, not silently lost. An unknown
rewind shape (one not starting at a prompt; none observed) would show as duplicated content,
which is visible and debuggable.

The API keeps its name and return type (`activeLineUuids(lines): Set<string>`), so all three
callers are unchanged. The parameter widens from `{uuid, parentUuid}` to
`Record<string, unknown>` because it now reads prompt-ness. Every caller already passes full
line objects.

## Changes

1. **`transcript-watcher/core/branch-filter.ts`**: rewrite `activeLineUuids` as above.
   Replace the header comment: it should describe the two branch kinds and the
   "drop only proven rewinds" rule with its failure direction. Drop `findRoot`,
   `leafOfRoot` and the leaf-path walk.
2. **`transcript-watcher/server/internal/parse-jsonl.ts`**: remove the workaround.
   - Delete `rescuedAttachmentUuids` and the rescue branch (377-391). The skip becomes a
     plain `if (uuid && !keptUuids.has(uuid)) continue;`.
   - Update the `buildEvents` comment (~296).
   - Update the `mergeChainLines` CAVEAT (~233-237): the fork remainder is dropped because
     it is a superseded prompt branch.
3. **`conversations/server/internal/claude-transcript.ts:52-53`**: reword the doc comment
   (no "leaf→root path").
4. **`conversations/server/internal/transcript-cut.ts:200-206`**: reword the comment. The
   CLI still resumes from the file-order-latest leaf, so the `divergesThroughATurn` drop
   stays. The viewer no longer uses that rule, though; it uses latest prompt sibling.
   No logic change. Side effect: loss accounting now also sees launches in formerly dropped
   parallel `tool_use` lines, which is more correct.

## Tests

- **`core/branch-filter.test.ts`**: rewrite it with prompt-shaped fixtures (a `user` line
  with string content vs an `assistant` / `tool_result` / `attachment` line). Cases:
  - Linear chain.
  - Rewind drops the superseded prompt subtree (including a longer abandoned branch).
  - Parallel batch: all `tool_use` and `tool_result` side leaves kept, including
    out-of-order results.
  - Hook attachment chain off a live node kept.
  - Side leaves inside an abandoned subtree stay dropped.
  - Disjoint roots kept; a rewind inside a later segment prunes only it.
  - Nested rewinds.
  - Dangling parent.
  - Cycle terminates.
  - Uuid-less lines excluded.
  - Non-prompt `user` siblings (interrupt sentinel, meta, tool_result) never supersede.
- **`server/internal/parse-jsonl.test.ts`**:
  - Replace the "off-spine attachment rescue" describe with "side leaves". Include a
    parallel-batch fixture shaped like lines 651–679, asserting each `tool-call` event
    carries its `result`, plus the out-of-order case (193–196), asserting both calls are
    emitted with results.
  - Keep the "attachment under an abandoned rewind stays dropped" cases, rebuilt on real
    rewind shapes.
  - Fix comment ~343. The midpoint-fork test is unchanged.
- **`conversations/server/internal/claude-transcript.test.ts:172`**: the fixture uses an
  assistant-vs-assistant sibling, a shape never observed. Rebuild it as a prompt-sibling
  rewind and keep the same assertion.
- **`transcript-cut.test.ts`**: should pass unchanged. Run it to confirm.

## Verification

1. `./equin test plugins/conversations/plugins/transcript-watcher`,
   `./equin test plugins/conversations/server` (claude-transcript, transcript-cut).
2. `./equin build` (background, as a subagent `./equin await`).
3. Open the deployed worktree's conversation view for conv-1790510418-tup0. Its transcript
   file is global, so any namespace renders it. Screenshot with the e2e `screenshot.ts`
   (`--path /agents/c/conv-1790510418-tup0`). Every `add_task` card should show a task link
   chip and no `•••`.
4. Spot-check a conversation that had a native `/rewind` (e.g. session `5e2ae526…`). Only the
   resubmitted branch should render.
