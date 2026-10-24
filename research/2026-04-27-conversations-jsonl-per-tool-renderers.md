# JSONL viewer: per-tool renderers

## Context

The JSONL viewer renders Claude session logs as a flat stream of typed events. Today there are two generic event renderers — `assistant-tool-use` and `user-tool-result` — each of which dumps the raw JSON `input` / `content` into a `<pre>`. That works as a debug view but throws away every signal a reader actually wants:

- `Read` should show the file path as a clickable link, not `{"file_path": "..."}`.
- `Edit` should show a diff, not `{"old_string": "...", "new_string": "..."}`.
- `Bash` should show the command as a shell snippet and the result as terminal output.
- A tool call and its result are conceptually one operation — the user has to mentally pair them by `tool_use_id` today.

We want each tool to own *both* the call rendering and the result rendering, in a single visual block, as its own plugin. Built-in tools (`Read`, `Edit`, …) get bespoke renderers; MCP tools (`mcp__server__name`) get a shared umbrella renderer with optional per-tool overrides; unknown tools fall back to the current JSON dump.

The current resource pushes the full event array on every change, and the result event arrives in a *later* poll than the call event — so the architecture must support a tool call rendering with `result: undefined` ("running…") and then dynamically populating the result when it arrives, without remounting the card.

## Architecture overview

Three changes, in order:

1. **Server protocol**: replace the two events `assistant-tool-use` + `user-tool-result` with a single paired event `tool-call`. Pairing happens once, at parse time, by `tool_use_id`. The result is optional: `result?: { at, content, isError }`. Orphan results (no matching call) are emitted as a `tool-call` with `name: ""`, `input: null`, and the result populated — the unknown-tool fallback will render them.

2. **New slot `JsonlViewer.ToolRenderer`** (defined inside a new umbrella sub-plugin `tool-call/`). Contributions match by tool name, with three priority tiers:
   - **Exact name** — `{ name: "Read", component: ReadToolView }`.
   - **Pattern** — `{ pattern: /^mcp__/, component: McpToolView }`.
   - **Fallback** — built-in `GenericToolView` shows the current `pre`-formatted JSON.

   Dispatch order: exact → first matching pattern → fallback. Each tool plugin renders the *whole* paired card (call header + input section + result section), so visual layout is the plugin's choice.

3. **One plugin per tool** under `jsonl-viewer/plugins/tool-call/plugins/<tool>/`, each contributing to `JsonlViewer.ToolRenderer`. The two existing `assistant-tool-use` and `user-tool-result` sub-plugins are deleted.

### Live result population

The push resource re-emits the full event array whenever the JSONL file changes. To make a card transition from "running" → "completed" without remounting (preserves expand state, scroll position, focus):

- The flat list at `web/components/jsonl-pane.tsx` keys each row by event identity. For `tool-call`, that key must be the `toolUseId`, not the array index. (Other event kinds keep the array-index key — they're append-only.)
- Each per-tool renderer receives the paired event as a single prop and naturally re-renders when `event.result` flips from `undefined` to populated.

## Critical files

### Server (protocol + parser)

- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/shared/protocol.ts` — replace `assistant-tool-use` and `user-tool-result` variants with a single `tool-call` variant.
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/parse-jsonl.ts` — pair use+result by `toolUseId` during the pass; emit one `tool-call` per pair, plus orphan-result fallthroughs. Existing `extractText` helper handles result content.
- No changes to `jsonl-events-resource.ts` or `watch-jsonl.ts` — full re-emit on change is exactly what we need.

### Web (slot + dispatcher + umbrella plugin)

- **New** `jsonl-viewer/plugins/tool-call/web/slots.ts` — defines `JsonlViewer.ToolRenderer` slot with the exact/pattern/fallback contribution shape.
- **New** `jsonl-viewer/plugins/tool-call/web/index.ts` — registers an `EventRenderer` for `kind: "tool-call"` whose component is the dispatcher.
- **New** `jsonl-viewer/plugins/tool-call/web/components/tool-call-row.tsx` — dispatcher: looks up the right `ToolRenderer` by name, renders it inside a shared chrome (`<details>`-style card with name badge, timestamp, optional error styling).
- **New** `jsonl-viewer/plugins/tool-call/web/components/generic-tool-view.tsx` — fallback (current JSON dump for input + result).
- **New** `jsonl-viewer/plugins/tool-call/shared/index.ts` — re-exports `ToolRendererProps` (`{ event: ToolCallEvent }`) for per-tool plugins to consume without crossing barrels.
- `jsonl-viewer/web/components/jsonl-pane.tsx` — change the row `key` to `event.kind === "tool-call" ? event.toolUseId : i`.
- `web/src/plugins.ts` — remove `conversationJsonlViewerAssistantToolUsePlugin` and `conversationJsonlViewerUserToolResultPlugin`; add `conversationJsonlViewerToolCallPlugin` and the per-tool plugins.

### Per-tool plugins

Each plugin lives at `jsonl-viewer/plugins/tool-call/plugins/<tool>/` and follows the existing sub-plugin pattern (`package.json`, `web/index.ts`, `web/components/<tool>-view.tsx`). Each contributes one `JsonlViewer.ToolRenderer({ name | pattern, component })`.

### Removed

- `jsonl-viewer/plugins/assistant-tool-use/` (entire folder)
- `jsonl-viewer/plugins/user-tool-result/` (entire folder)
- Their entries in `web/src/plugins.ts`.

## Reused primitives

- `HighlightedCode` from `@plugins/syntax-highlight/web` — `Bash`, `Edit` snippet rendering, `Write` previews.
- `DiffView` at `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/plugins/diff/web/components/diff-view.tsx` — `Edit`, `MultiEdit`, `Write`-vs-HEAD diffs.
- `formatTime` at `jsonl-viewer/web/utils.ts` — header timestamps.
- `ReactMarkdown` + `MD_COMPONENTS` already in `assistant-text-row.tsx` — `WebFetch`/`WebSearch` result rendering (extract into a shared helper if reused twice).

A clickable file path that opens the conversation's worktree in the FilePane does *not* exist yet. For v1, render file paths as plain monospace text. A follow-up plan can add a `useOpenFile(worktree, path)` helper next to `Code` slots.

## Per-tool render sketches

Brief notes only — each plugin owns the details. All renderers receive `{ event: ToolCallEvent }` where `event.input` is the typed call args and `event.result` is `{ at, content, isError } | undefined`.

- **Read** — header: file path (mono); collapsed by default; result is the file content slice with line numbers.
- **Edit** / **MultiEdit** — header: file path; body: side-by-side diff of `old_string` → `new_string` (use `HighlightedCode` per side). Result: success / error chip.
- **Write** — header: file path; body: highlighted preview of new content (capped). Result: success / error chip.
- **Bash** — header: command in mono; body collapsed; result: stdout/stderr in a terminal-styled block, red border on `isError`.
- **Grep** — header: pattern + path; result: list of matches, file paths in mono.
- **Glob** — header: pattern; result: file list, mono.
- **Task** / **Agent** — header: subagent type + description; body: prompt (markdown). Result: agent's report (markdown).
- **WebFetch** — header: URL (link, `target=_blank`); result: rendered markdown.
- **WebSearch** — header: query; result: result list (title + URL).
- **TodoWrite** — body: rendered checklist; result: short confirmation.
- **NotebookEdit** — like Edit but with cell index in the header.
- **mcp__\*** (umbrella) — pattern `^mcp__`; header parses `mcp__<server>__<tool>` into "server / tool"; falls back to GenericToolView body. Specific MCP tools can override later by registering an exact-name plugin.
- **(unknown / fallback)** — `GenericToolView` reproduces today's behavior: pretty-printed JSON `input` and `content`.

## Phasing

1. **Protocol + parser + dispatcher + GenericToolView** — entire pipeline works end-to-end with the fallback view, no per-tool plugins yet. Existing `assistant-tool-use` / `user-tool-result` sub-plugins removed in this same step (otherwise they double-render or fight the new `tool-call` event).
2. **First batch of high-value tools** — `Bash`, `Read`, `Edit`. These cover the bulk of visible JSONL traffic and validate the slot shape against three different layouts (command/result, path/preview, diff).
3. **Remaining tools** — `Write`, `Grep`, `Glob`, `Task`, `WebFetch`, `WebSearch`, `TodoWrite`, `NotebookEdit`, `mcp__*` umbrella.

Each phase is independently shippable.

## Verification

After phase 1:

```bash
./equin build
```

- Open a conversation with recent tool activity at `http://<worktree>.localhost:9000/c/<id>`.
- Click the JSONL toolbar button.
- Confirm: every old `tool_use` + `tool_result` pair shows up as **one** card (not two) with name, timestamp, JSON input, JSON result.
- Open a card while the conversation is still running (or replay an old log via `watch-jsonl`'s 500ms poll). Confirm the card transitions from "running" to populated result without collapsing or remounting.
- Confirm the unknown-tool fallback matches the previous JSON dump visually so we don't regress the debug view.

After phases 2/3:

- Visit a conversation with each tool used and confirm its renderer matches the sketch (Bash → terminal block, Edit → diff, Read → path + preview, etc.).
- Trigger an MCP tool from inside Claude (e.g. `mcp__singularity__add_task`) and confirm the umbrella renderer parses the name correctly.
- Run `./equin check --plugin-boundaries` — no new violations (per-tool plugins only import from `@core`, the `tool-call` shared barrel, and `@plugins/syntax-highlight/web`).

## Out of scope

- Clickable file paths that open the FilePane (deferred — needs a `useOpenFile(worktree, path)` helper).
- Incremental updates over the wire (today's full re-emit is fine).
- Search/filter inside the JSONL pane (tracked separately).
- Persisting expand/collapse state across navigations.
