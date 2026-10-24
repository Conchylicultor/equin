# JSONL viewer: Bash tool renderer

## Context

Phase 1 of `2026-04-27-conversations-jsonl-per-tool-renderers.md` is complete: the `tool-call` event, the `JsonlViewerTool.Renderer` slot, and the `GenericToolView` fallback all exist and work. Phase 2 starts with `Bash` — the most frequently seen tool in any Claude Code session.

**Problem:** `GenericToolView` dumps the full input object as JSON (`{"command":"…","description":"…"}`) and the result as an untyped text blob. ANSI escape codes litter the output. There is no visual difference between a successful run and an error.

**Goal:** A dedicated `bash` sub-plugin that renders the command as a syntax-highlighted shell snippet, shows the description as a context label, and outputs a clean terminal-style result block with clear error styling.

---

## UX / UI design

The `BashToolView` component renders only the **body** (below the `<summary>` header). The outer `ToolCallRow` already handles the tool-name badge, animated running dots, error badge, timestamp, and token badge — none of that is our concern.

### Normal result

```
  List all TypeScript files in the plugin directory        ← description (text-[11px] text-muted-foreground)
  ┌─────────────────────────────────────────────────────┐
  │ rg --files -g "*.ts" plugins/foo/bar                │  ← HighlightedCode, lang="bash", bg-muted
  └─────────────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────────────┐
  │ plugins/foo/bar/web/index.ts                        │  ← <pre> bg-muted/60, max-h-96 scroll
  │ plugins/foo/bar/shared/index.ts                     │
  └─────────────────────────────────────────────────────┘
```

### Error result

```
  ┌─────────────────────────────────────────────────────┐
  │ ls -la /nonexistent                                 │
  └─────────────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────────────┐  ← bg-destructive/10 text-destructive
  │ ls: /nonexistent: No such file or directory         │
  └─────────────────────────────────────────────────────┘
```
(The outer `ToolCallRow` summary also gains a red border and "error" badge automatically.)

### Running (no result yet)

```
  ┌─────────────────────────────────────────────────────┐
  │ bun run build                                       │
  └─────────────────────────────────────────────────────┘
                                                          ← no output block rendered
```

### No description, empty output

```
  ┌─────────────────────────────────────────────────────┐
  │ ls -la                                              │
  └─────────────────────────────────────────────────────┘
  (no output)                                            ← italic muted placeholder
```

---

## Files to create

### `plugins/bash/package.json`

Full path: `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/bash/package.json`

```json
{
  "name": "@singularity/plugin-conversations-conversation-view-jsonl-viewer-tool-call-bash",
  "private": true,
  "version": "0.0.1"
}
```

### `plugins/bash/web/index.ts`

```ts
import type { PluginDefinition } from "@core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { BashToolView } from "./components/bash-tool-view";

export default {
  id: "conversation-jsonl-viewer-tool-call-bash",
  name: "JSONL Viewer: Bash tool renderer",
  description:
    "Renders Bash tool calls with a syntax-highlighted command, optional description label, and ANSI-stripped output.",
  contributions: [
    JsonlViewerTool.Renderer({ name: "Bash", component: BashToolView }),
  ],
} satisfies PluginDefinition;
```

`JsonlViewerTool` is imported from the parent plugin's **web** barrel (not `shared`) — that's the correct source as confirmed by `tool-call/web/index.ts` line 6.

### `plugins/bash/web/components/bash-tool-view.tsx`

```tsx
import { HighlightedCode } from "@plugins/primitives/plugins/syntax-highlight/web";
import type { ToolRendererProps } from "../../../../shared";

interface BashInput {
  command: string;
  description?: string;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[mGKHF]/g, "")  // SGR + common cursor codes
    .replace(/\x1b\][^\x07]*\x07/g, "");    // OSC sequences (e.g. terminal title)
}

export function BashToolView({ event }: ToolRendererProps) {
  const input = event.input as BashInput;
  const result = event.result;

  return (
    <>
      {input.description && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {input.description}
        </p>
      )}

      <HighlightedCode code={input.command} lang="bash" />

      {result && (
        <pre
          className={`max-h-96 overflow-auto whitespace-pre-wrap break-words rounded p-2 font-mono text-xs leading-5 ${
            result.isError
              ? "bg-destructive/10 text-destructive"
              : "bg-muted/60"
          }`}
        >
          {result.content ? stripAnsi(result.content) : (
            <span className="italic text-muted-foreground">(no output)</span>
          )}
        </pre>
      )}
    </>
  );
}
```

**Class decisions:**
- `mt-2 text-[11px] text-muted-foreground` — matches the tool name badge size; muted so it doesn't compete with the command.
- `HighlightedCode` with `lang="bash"` — shiki provides token-level bash grammar coloring, automatic dark/light switching, and a graceful plain-`<pre>` fallback while the highlighter loads asynchronously. The component wraps its own `<pre>` with `bg-muted`, `rounded`, `p-3`, `font-mono`, `text-xs`.
- Output `<pre>`: `max-h-96 overflow-auto` — caps tall outputs at ~384px with scrollbar; `whitespace-pre-wrap break-words` — preserves newlines, prevents horizontal overflow; `font-mono text-xs leading-5` — terminal-like density.
- `bg-destructive/10 text-destructive` — exactly matches `GenericToolView`'s error style, keeping the error palette consistent across all tool renderers.
- `bg-muted/60` — matches `GenericToolView`'s normal output style.
- `timeout` and `run_in_background` are intentionally omitted — not useful to display in a transcript reader.

**Import path for `ToolRendererProps`:** `"../../../../shared"` — four `../` steps from `components/` → `web/` → `bash/` → `plugins/` → `tool-call/` → `shared/`. Matches the relative-import convention used by `generic-tool-view.tsx`.

**ANSI stripping:** Two regex passes cover the vast majority of sequences emitted by shell commands and by Claude Code's own output:
1. `\x1b\[[0-9;]*[mGKHF]` — SGR (colors, bold, reset) and common cursor controls.
2. `\x1b\][^\x07]*\x07` — OSC (terminal title changes and similar).

---

## Files to edit

**`web/src/plugins.generated.ts`** — do not edit manually. After creating the three files above, run `./equin build`. The generator discovers every `web/index.ts` under `plugins/` and regenerates this file automatically. The expected diff is a new import and a new array entry directly after `conversationsConversationViewJsonlViewerToolCallPlugin`.

---

## Verification

1. **Build:** `./equin build` — must complete without TypeScript errors and the new plugin must appear in `plugins.generated.ts`.

2. **Normal output** — open a conversation with completed Bash calls. Expand one:
   - Description label visible above the code block (if present in the event).
   - Command is syntax-highlighted bash (keywords, flags colored).
   - Output block is `bg-muted/60`, scrollable for long results.
   - `(no output)` shown for empty `content`.

3. **Error output** — find a Bash call where the command failed (`result.isError === true`):
   - Output block is red-tinted (`bg-destructive/10 text-destructive`).
   - Outer `ToolCallRow` summary independently shows red border + "error" badge.

4. **Running state** — observe a live conversation mid-run:
   - Bash cards without a result show only the command (and description). No output block.
   - Outer `ToolCallRow` shows animated dots. When the result arrives the output block appears without remounting the card (expand state is preserved).

5. **Dark mode** — toggle theme. The `HighlightedCode` block should switch between github-light and github-dark themes instantly.

6. **Fallback intact** — other tool names (e.g. `Read`, `Write`) still render via `GenericToolView`. The `name: "Bash"` exact match only intercepts the Bash tool.

7. **Long output** — a command with many lines of output should scroll within the `max-h-96` container without causing layout overflow.
