# Compaction divider in the transcript

## Context

When Claude Code compacts a conversation, the transcript shows it as several unrelated rows
(screenshot in conv-1791818418-k72458): a `System · compact boundary  Conversation compacted`
line, the whole compact summary as a giant user message with raw `##` / `**` markdown, then one
row per re-read file (`Attached file · 11 lines <path>`, and `attachment:compact_file_reference`
rendered by the unknown-attachment fallback). It reads as noise and as if the user had written the
summary.

The prototype proto-1791886400-1sxtk3 (`compaction=divider`) settled the design: **one thin rule**
— `Context compacted · 211k → 8k` — folding the summary (rendered as markdown) and the re-read
files (as file chips) behind it. The user approved it.

## What the JSONL says

One compaction is a contiguous run of lines:

1. `type: "system", subtype: "compact_boundary", content: "Conversation compacted"`, with
   `compactMetadata: { trigger: "auto" | "manual", preTokens, postTokens, durationMs, … }`.
2. `type: "user", isCompactSummary: true` — the summary text (starts with the harness preamble
   "This session is being continued from a previous conversation… Summary:").
3. `type: "attachment"` lines: `file` (re-read with content) and `compact_file_reference`
   (path only), interleaved with context attachments (`invoked_skills`, `deferred_tools_delta`,
   `environment`, …) that already have their own renderers.

## Design

The fold is a **parser** fact, not a rendering trick: the three line kinds are one event, so the
parser emits one event, and nothing downstream ever sees the summary as a user message.

1. **`transcript-watcher/core/protocol.ts`** — new `JsonlEvent` arm `kind: "compaction"`:
   `{ at, trigger?, preTokens?, postTokens?, summary?, files: { path, displayPath?, lines? }[] }`.
2. **`transcript-watcher/server/internal/parse-jsonl.ts`**
   - `system` + `subtype === "compact_boundary"` → push a `compaction` event (metadata parsed with
     zod at the boundary) and open an *absorbing window*.
   - `user` line with `isCompactSummary: true` → becomes the latest compaction's `summary`
     (preamble stripped). A summary with no preceding boundary still produces a compaction event —
     never a user-text row.
   - while the window is open, `file` / `compact_file_reference` attachments join `files`; other
     attachment subtypes pass through as before; any non-attachment line closes the window.
   - tests in `parse-jsonl.test.ts`.
3. **New renderer plugin `conversation-view/jsonl-viewer/plugins/compaction`** —
   `JsonlViewer.EventRenderer({ match: "compaction" })` → `CompactionRow`:
   - trigger: a full-width button — hairline, history icon, `Context compacted · 211k → 8k`
     (`formatTokenCount`), chevron, hairline. Muted caption text, sentence case (jsonl-viewer rules).
   - content (`Collapsible`, closed by default): the summary through `Markdown`, then
     `Re-read after compacting` + one `FilePath` chip per file.
   - hairlines are the plain `Separator` primitive (the labelled one is `role=separator`, which
     cannot hold an interactive trigger).

`compact_boundary` no longer reaches `SystemRow`; nothing else in the repo matches on it.

Follow-up: harness context re-injected after the compaction folds into this divider too — see `2026-10-14-conversations-context-fold.md`.

## Verification

- `./singularity test plugins/conversations/plugins/transcript-watcher` (parser cases: boundary +
  summary + files fold into one event; context attachments pass through; summary without boundary).
- `./singularity build`, then screenshot a compacted conversation (e.g. the one from
  conv-1791818418-k72458) folded and unfolded with `screenshot.ts --click "Context compacted"`.
