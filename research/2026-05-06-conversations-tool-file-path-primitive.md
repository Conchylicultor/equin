# Tool File Path Primitive — Shared Summary Chip for Edit & Write Renderers

## Context

The `edit` and `write` tool-call renderer plugins both show a file-path summary chip inside `ToolCallCard`. Right now they each have their own private implementation with diverged behaviour:

| | `EditSummary` (edit plugin) | `WriteSummaryHint` (write plugin) |
|---|---|---|
| Element | `<span>` — not clickable | `<button>` — opens file-peek pane |
| Path shown | Raw absolute `file_path` | `toRelativePath(filePath, attemptId)` — strips worktree prefix |
| Overflow | `max-w-[40ch] truncate` (clips right) | RTL trick — filename end always visible |
| Hover / tooltip | None | `hover:underline` + `title` tooltip |

**Goal:** Extract just the file-path chip into a shared export on the existing `tool-call/web` barrel so both renderers use the same component. Error rendering in each plugin is intentionally left alone.

---

## Implementation Plan

### 1. New file: `tool-call/web/components/tool-file-path.tsx`

Canonicalize `WriteSummaryHint` as the authoritative implementation (it is more feature-complete) and move the inline `toRelativePath` helper here:

```tsx
function toRelativePath(filePath: string, attemptId: string): string {
  const marker = `/${attemptId}/`;
  const idx = filePath.indexOf(marker);
  return idx >= 0 ? filePath.slice(idx + marker.length) : filePath;
}

interface ToolFilePathProps {
  filePath: string;   // absolute path from tool input
  attemptId: string;  // conversation worktree id — strips the prefix
  convId: string;     // opens the right file-peek pane
}

export function ToolFilePath({ filePath, attemptId, convId }: ToolFilePathProps) {
  const relativePath = toRelativePath(filePath, attemptId);
  const openFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    convFilePeekPane.open({ convId, worktree: attemptId, filePath });
  };
  return (
    <button
      onClick={openFile}
      className="w-max max-w-full overflow-hidden whitespace-nowrap font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      style={{ direction: "rtl", textOverflow: "ellipsis" }}
      title={relativePath}
    >
      <span style={{ direction: "ltr", unicodeBidi: "embed" }}>{relativePath}</span>
    </button>
  );
}

export { toRelativePath };
```

Imports needed: `convFilePeekPane` from `@plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web`.

### 2. Export from `tool-call/web/index.ts`

Add:
```ts
export { ToolFilePath, toRelativePath } from "./components/tool-file-path";
```

### 3. Update `edit` plugin

**`edit-view.tsx`** — replace `<EditSummary ... />` with:
```tsx
<ToolFilePath filePath={file_path} attemptId={conversation.attemptId} convId={conversation.id} />
```
Import `ToolFilePath` from `tool-call/web`.

**`multi-edit-view.tsx`** — same replacement. The `MultiEdit` input has a top-level `file_path` field, so this is straightforward.

**`edit-summary.tsx`** — delete (no longer referenced).

### 4. Update `write` plugin

**`write-tool-view.tsx`** — remove `WriteSummaryHint` function and inline `toRelativePath`; replace with:
```tsx
summary={<ToolFilePath filePath={file_path} attemptId={conversation.attemptId} convId={conversation.id} />}
```
Import `ToolFilePath` from `tool-call/web`.

---

## Files to Modify

| File | Action |
|---|---|
| `plugins/.../tool-call/web/components/tool-file-path.tsx` | **Create** |
| `plugins/.../tool-call/web/index.ts` | Add export |
| `plugins/.../tool-call/plugins/edit/web/components/edit-view.tsx` | Use `ToolFilePath` |
| `plugins/.../tool-call/plugins/edit/web/components/multi-edit-view.tsx` | Use `ToolFilePath` |
| `plugins/.../tool-call/plugins/edit/web/components/edit-summary.tsx` | **Delete** |
| `plugins/.../tool-call/plugins/write/web/components/write-tool-view.tsx` | Use `ToolFilePath`, remove `WriteSummaryHint` + `toRelativePath` |

Full path prefix: `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/`

---

## Verification

1. `./equin build` — must succeed with no type errors or plugin-boundary violations.
2. Open a conversation containing Edit, MultiEdit, and Write tool calls — all three show a clickable relative file path chip with RTL overflow.
3. Clicking the chip opens the file-peek pane; clicking the card header still toggles the detail (no double-toggle regression).
4. `./equin check --plugin-boundaries` — no new violations.
