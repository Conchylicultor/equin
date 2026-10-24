# Write Tool Renderer

## Context

The JSONL viewer currently renders all tool calls — including `Write` — as raw JSON `<pre>` dumps via `GenericToolView`. The per-tool dispatch slot (`JsonlViewerTool.Renderer`) is wired up but has zero registered renderers. The first concrete per-tool renderer to build is for `Write`, which writes a file. Its input always contains the full file content (`{ file_path, content }`), making it ideal for a syntax-highlighted preview.

The previous design phase (phase 1) shipped the paired `tool-call` event pipeline and the `GenericToolView` fallback. This plan is the first entry in phase 2: adding targeted renderers.

---

## UX Design

### What users want to know at a glance
1. **Which file** was written (path / filename)
2. **What content** was written (syntax-highlighted preview)
3. **Did it succeed** (errors surfaced immediately; success is implicit)

### Two-level information density

**Collapsed card** (summary line — always visible):
```
▶ Write   write-tool-view.tsx   12:34
```
The filename is enough context to scan a long conversation without expanding every card.

**Expanded card** (body — on click):
```
▶ Write   write-tool-view.tsx   12:34
  ─────────────────────────────────────────────────────
  📄 plugins/.../tool-call/plugins/write/web/components/write-tool-view.tsx

  ┌────────────────────────────────────────────────────┐
  │ import { definePlugin } from "@plugin-core/web"   │  ← syntax-highlighted
  │ import { JsonlViewerTool } from "../../slots"     │     max-h-[300px]
  │ ...                                               │     overflow-auto
  └────────────────────────────────────────────────────┘
  24 lines                                  [only on hover/always tiny]

  ✗ ENOENT: no such file or directory       ← only on error; success is silent
```

---

## Implementation

### 1. Extend the slot schema — add `summary` callback

**File:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web/slots.ts`

Add an optional `summary` field to `ToolRendererContribution`:

```ts
import type { ReactNode } from "react";
import type { ToolCallEvent } from "../shared";

export interface ToolRendererContribution {
  name?: string;
  pattern?: RegExp;
  component: ComponentType<ToolRendererProps>;
  summary?: (event: ToolCallEvent) => ReactNode;  // ← NEW
}
```

This callback lets any per-tool plugin inject a short hint into the `<summary>` line — filename for Write/Read, truncated command for Bash, hunk count for Edit, etc. `GenericToolView` contributions (no `summary`) keep the current appearance.

### 2. Render `summary` in `ToolCallRow`

**File:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web/components/tool-call-row.tsx`

After the name chip and before the running-dots / error label, render:

```tsx
{contribution?.summary?.(event) && (
  <span className="truncate font-mono text-xs text-muted-foreground">
    {contribution.summary(event)}
  </span>
)}
```

Resolve the contribution before rendering (currently `resolveRenderer` returns only the component — change it to return the full `ToolRendererContribution | undefined` so `summary` is accessible).

### 3. New `write` sub-plugin

**Location:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/write/`

```
write/
├── web/
│   ├── index.ts
│   └── components/
│       └── write-tool-view.tsx
├── package.json
└── CLAUDE.md
```

**`web/index.ts`**

```ts
import { definePlugin } from "@plugin-core/web";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { WriteToolView } from "./components/write-tool-view";

export default definePlugin({
  id: "conversation.jsonl-viewer.tool-write",
  web: () => [
    JsonlViewerTool.Renderer({
      name: "Write",
      summary: (event) => {
        const { file_path } = event.input as { file_path: string; content: string };
        return file_path.split("/").pop() ?? file_path;
      },
      component: WriteToolView,
    }),
  ],
});
```

**`web/components/write-tool-view.tsx`**

```tsx
import { FileText } from "lucide-react";
import {
  HighlightedCode,
  languageForPath,
} from "@plugins/primitives/syntax-highlight/web";
import type { ToolRendererProps } from "@plugins/conversations/.../tool-call/shared";

export function WriteToolView({ event }: ToolRendererProps) {
  const { file_path, content } = event.input as {
    file_path: string;
    content: string;
  };

  const lastSlash = file_path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? file_path.slice(0, lastSlash + 1) : "";
  const filename = lastSlash >= 0 ? file_path.slice(lastSlash + 1) : file_path;
  const lineCount = content.split("\n").length;

  return (
    <div className="mt-2 space-y-2">
      {/* Full path */}
      <div className="flex items-center gap-1.5">
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-xs font-mono">
          <span className="text-muted-foreground">{dir}</span>
          <span className="font-medium text-foreground">{filename}</span>
        </span>
      </div>

      {/* Syntax-highlighted content */}
      <div className="relative">
        <HighlightedCode
          code={content}
          lang={languageForPath(file_path)}
          className="max-h-[300px] overflow-auto rounded bg-muted/60 p-2 text-xs"
        />
        <span className="absolute bottom-1.5 right-2 select-none text-[10px] text-muted-foreground/60 tabular-nums">
          {lineCount} {lineCount === 1 ? "line" : "lines"}
        </span>
      </div>

      {/* Error result only — success is implicit */}
      {event.result?.isError && (
        <p className="text-xs text-destructive">{event.result.content}</p>
      )}
    </div>
  );
}
```

### 4. Register `write` in the `tool-call` umbrella

**File:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web/index.ts`

Add `writePlugin` (imported from `./plugins/write/web`) to the `plugins` array of `definePlugin`.

---

## Critical files

| File | Change |
|------|--------|
| `…/tool-call/web/slots.ts` | Add `summary?` field to `ToolRendererContribution` |
| `…/tool-call/web/components/tool-call-row.tsx` | Render `summary?.(event)` in `<summary>` |
| `…/tool-call/web/index.ts` | Add `write` to plugins array |
| `…/tool-call/plugins/write/web/index.ts` | **New** — plugin definition + slot contribution |
| `…/tool-call/plugins/write/web/components/write-tool-view.tsx` | **New** — body component |
| `…/tool-call/plugins/write/package.json` | **New** — bun workspace package |
| `…/tool-call/plugins/write/CLAUDE.md` | **New** — plugin docs |

---

## Verification

1. `./equin build` — build must pass with no type errors
2. Open any conversation where the agent used the Write tool
3. **Collapsed card:** should show `Write  <filename>  <time>` — filename visible without expanding
4. **Expanded card:** should show full path + syntax-highlighted content + line count badge
5. Trigger an error case (e.g. path permission error): should show destructive error text in body
6. Compare a large file (>300px height): content block should scroll inside its fixed height
7. `GenericToolView` for non-Write tools should be unchanged
