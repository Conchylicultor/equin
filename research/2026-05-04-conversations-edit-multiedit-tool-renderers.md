# Edit & MultiEdit Tool Renderers

## Context

Phase 2 of the per-tool renderer rollout (see `2026-04-27-conversations-jsonl-per-tool-renderers.md`). Phase 1 is complete: the `tool-call` plugin exists with a working dispatcher, shared chrome, and `GenericToolView` fallback. Edit and MultiEdit are the most visible tool calls in coding agents — every file change produces one — so this is the highest-impact batch.

Today they fall through to `GenericToolView`, which dumps raw JSON (`{"file_path":"…","old_string":"…","new_string":"…"}`). Goal: replace with a split diff view that shows the actual change inline, with full syntax highlighting.

## Architecture

`DiffView` (in `file-pane/plugins/diff/`) has two distinct layers:

| Layer | Current owner | Edit/MultiEdit needs |
|---|---|---|
| **Data** | `useFileDiff` (server), `useDiffTokens` (server + shiki) | Generate diff from in-memory strings; run shiki on provided strings directly (no server fetch) |
| **Rendering** | `<Diff><Hunk>` from `react-diff-view` + `renderShikiToken` | Same — fully reusable |

The plan unifies at the rendering layer: extract a `DiffRenderer` from `DiffView`, then the Edit plugin provides its own data path (client-side diff generation + direct shiki) and calls `DiffRenderer`.

## Changes

### 1. Extract `DiffRenderer` from `DiffView`

**File**: `plugins/.../file-pane/plugins/diff/web/components/diff-view.tsx`

Pull the JSX render block (currently lines 270–333) into a standalone `DiffRenderer` component:

```tsx
export function DiffRenderer({
  files,
  hunks,
  tokens,
}: {
  files: FileData[];
  hunks: HunkData[] | null;
  tokens: DiffTokens | null;
}) {
  // the <div ref={containerRef}> block + copy/keyboard handlers, without fetch logic
}
```

`DiffView` becomes a thin wrapper: it runs `useFileDiff` + `useDiffTokens` + `expandLines`, then calls `<DiffRenderer files={files} hunks={effectiveHunks} tokens={tokens} />`.

Context line expansion (`expandLines`) stays in `DiffView` only — for in-memory Edit diffs there are no surrounding lines to expand, so `DiffRenderer` receives hunks directly and shows no skip separators.

**Export from `diff` plugin barrel** (`diff/web/index.ts`):

```ts
export { DiffRenderer } from "./components/diff-view";
export type { DiffTokens } from "./use-diff-tokens";
```

### 2. Add `diff` package for client-side unified diff generation

Add `"diff": "^7.0.0"` to the root `package.json` (and `"@types/diff": "^7.0.0"` as a dev dep).

Usage:
```ts
import { createTwoFilesPatch } from "diff";
const patch = createTwoFilesPatch("", "", oldText, newText, "", "", { context: 3 });
// parseDiff(patch) → FileData[] with HunkData[]
```

This generates a standard unified diff with `@@ -1,n +1,m @@` hunks (treating the strings as complete mini-files). Correct for our use case: `old_string`/`new_string` are exactly the content being shown.

### 3. `useInlineDiffData` hook (inside `edit` plugin, not exported)

```ts
function useInlineDiffData(
  oldText: string,
  newText: string,
  path: string,
): { files: FileData[]; hunks: HunkData[] | null; tokens: DiffTokens | null }
```

Steps:
1. `createTwoFilesPatch("", "", oldText, newText, "", "", { context: 3 })` → unified patch string
2. `parseDiff(patch)` → `files: FileData[]`, `hunks = files[0]?.hunks ?? null`
3. Shiki highlight `oldText` and `newText` using `getHighlighter(languageForPath(path))` — no server fetch needed since we have the strings
4. Build `DiffTokens` via the same `buildSideTokenMap` logic as `useDiffTokens` (either import helper from `diff` barrel if exported, or inline the ~30-line function)
5. Return `{ files, hunks, tokens }`

All of this is synchronous except the shiki highlight step (async, but already handles loading state in `DiffRenderer`).

### 4. Extend `ToolRendererContribution` slot shape

**File**: `tool-call/web/slots.ts`

Add two optional fields:
```ts
interface ToolRendererContribution {
  name?: string;
  pattern?: RegExp;
  component: ComponentType<ToolRendererProps>;
  summary?: ComponentType<ToolRendererProps>;   // injected after name badge in <summary>
  defaultOpen?: boolean;                         // card starts expanded
}
```

### 5. Update `tool-call-row.tsx`

- `resolveContribution` returns the full contribution object (not just `component`)
- `useState(contribution?.defaultOpen ?? false)` + `onToggle` handler on `<details>`
- Render `<Summary event={e} />` between the name badge and the spinner/error

Result chip (✓/✗) is added to the summary row — it appears right of the file path, before the auto-margin gap:
```tsx
{event.result && !event.result.isError && (
  <span className="text-[11px] text-green-600 dark:text-green-400">✓</span>
)}
{event.result?.isError && (
  <span className="text-[11px] text-destructive">✗</span>
)}
```

### 6. New `edit` plugin

**Path**: `plugins/.../tool-call/plugins/edit/`

```
edit/
├── package.json
└── web/
    ├── index.ts                 — two Renderer contributions
    └── components/
        ├── edit-summary.tsx     — shows file_path in the summary row
        ├── edit-view.tsx        — renderer for Edit
        ├── multi-edit-view.tsx  — renderer for MultiEdit
        └── inline-diff.tsx      — useInlineDiffData + <DiffRenderer> wrapper
```

#### `package.json`

```json
{
  "name": "@singularity/plugin-conversation-jsonl-viewer-tool-edit",
  "private": true,
  "type": "module"
}
```

No extra deps — uses root-level `diff` and `react-diff-view`.

#### `web/index.ts`

```ts
export default definePlugin({
  id: "conversation.jsonl-viewer.tool.edit",
  register({ slot }) {
    slot(JsonlViewerTool.Renderer({
      name: "Edit",
      component: EditView,
      summary: EditSummary,
      defaultOpen: true,
    }));
    slot(JsonlViewerTool.Renderer({
      name: "MultiEdit",
      component: MultiEditView,
      summary: EditSummary,
      defaultOpen: true,
    }));
  },
});
```

No public exports (all components are internal contributions).

#### `edit-summary.tsx`

```tsx
export function EditSummary({ event }: ToolRendererProps) {
  const fp = (event.input as { file_path?: string })?.file_path;
  if (!fp) return null;
  return (
    <span className="max-w-[40ch] truncate font-mono text-[11px] text-muted-foreground">
      {fp}
    </span>
  );
}
```

#### `inline-diff.tsx`

```tsx
// useInlineDiffData + a thin wrapper around DiffRenderer
export function InlineDiff({ oldText, newText, path }: {
  oldText: string;
  newText: string;
  path: string;
}) {
  const { files, hunks, tokens } = useInlineDiffData(oldText, newText, path);
  if (!hunks || files.length === 0) return null;
  return <DiffRenderer files={files} hunks={hunks} tokens={tokens} />;
}
```

Imports `DiffRenderer` from `@plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/plugins/diff/web` (the barrel).

#### `edit-view.tsx`

```tsx
type EditInput = { file_path: string; old_string: string; new_string: string };

export function EditView({ event }: ToolRendererProps) {
  const { file_path, old_string = "", new_string = "" } = event.input as EditInput;
  return (
    <div className="mt-2 space-y-2">
      <InlineDiff oldText={old_string} newText={new_string} path={file_path} />
      <ResultDetail result={event.result} />
    </div>
  );
}
```

#### `multi-edit-view.tsx`

```tsx
type MultiEditInput = { file_path: string; edits: { old_string: string; new_string: string }[] };

export function MultiEditView({ event }: ToolRendererProps) {
  const { file_path, edits = [] } = event.input as MultiEditInput;
  const multi = edits.length > 1;
  return (
    <div className="mt-2 space-y-3">
      {edits.map((edit, i) => (
        <div key={i}>
          {multi && (
            <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>Edit {i + 1} / {edits.length}</span>
              <hr className="flex-1 border-border/40" />
            </div>
          )}
          <InlineDiff oldText={edit.old_string} newText={edit.new_string} path={file_path} />
        </div>
      ))}
      <ResultDetail result={event.result} />
    </div>
  );
}
```

#### `ResultDetail` (inline helper)

```tsx
function ResultDetail({ result }: { result: ToolCallEvent["result"] }) {
  if (!result) return null;
  if (result.isError) {
    return (
      <div className="rounded bg-destructive/10 p-2 text-xs text-destructive whitespace-pre-wrap">
        {result.content || "Error"}
      </div>
    );
  }
  return null; // ✓ already shown in the summary row chip
}
```

Error message goes in the body; the ✓ chip lives in the summary row (always visible without expanding).

### 7. Register in `web/src/plugins.ts`

Add import and registration for `conversationJsonlViewerToolEditPlugin`.

## Visual result

**Collapsed (success):**
```
[Edit]  src/components/foo.tsx  ✓       2.4k  14:32
```

**Expanded (showing a 3-line edit with syntax highlighting):**
```
 1 │ import React from "react";    │  1 │ import React from "react";
 2 │ const x = 1;                  │  2 │ const x = 2;              ← green bg
 - │ const z = "old value";        │  + │ const z = "new value";    ← red/green
 3 │ export default function() {}  │  3 │ export default function() {}
```
*(Identical visual to the file-pane diff — same component, same CSS, same shiki tokens)*

**MultiEdit (3 edits):**
```
Edit 1 / 3  ─────────────────────────────────
[InlineDiff]
Edit 2 / 3  ─────────────────────────────────
[InlineDiff]
Edit 3 / 3  ─────────────────────────────────
[InlineDiff]
```

## Plugin boundary compliance

All cross-plugin imports go through barrels:
- `edit/web` → `@plugins/.../tool-call/web` ✓
- `edit/web` → `@plugins/.../tool-call/shared` ✓
- `edit/web` → `@plugins/.../file-pane/plugins/diff/web` ✓ (barrel; `DiffRenderer` must be exported there)

Run `./equin check --plugin-boundaries` to verify after implementation.

## Files modified

| File | Change |
|---|---|
| `root/package.json` | add `diff` + `@types/diff` |
| `file-pane/.../diff/web/components/diff-view.tsx` | extract `DiffRenderer`; `DiffView` calls it |
| `file-pane/.../diff/web/index.ts` | export `DiffRenderer`, `DiffTokens` |
| `tool-call/web/slots.ts` | add `summary?`, `defaultOpen?` to contribution |
| `tool-call/web/components/tool-call-row.tsx` | summary extension + controlled open + result chip |
| `web/src/plugins.ts` | register edit plugin |
| *(new)* `tool-call/plugins/edit/` | entire plugin |

## Verification

```bash
./equin build
```

1. Open a conversation with Edit calls — cards show file path in collapsed summary, ✓ chip when successful, expand by default with syntax-highlighted split diff.
2. Error result — ✗ chip in summary, error message in body.
3. MultiEdit — multiple diff sections with "Edit N / M" headers (only when > 1 edit).
4. Live conversation — Edit card appears open mid-run (no result chip), ✓ chip appears in summary without collapsing when done.
5. `DiffView` in the file-pane still works — verify in Code > Diff tab on any conversation.
6. Other tool cards (Bash, Read, etc.) unaffected by slot shape change.
7. `./equin check --plugin-boundaries` — no violations.
