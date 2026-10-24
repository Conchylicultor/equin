# Unified file-peek pane

## Context

Two nearly identical panes exist for previewing files in a Miller column:

- **`convFilePeekPane`** (`file-pane/web/file-peek-pane.tsx`) — after `conversationPane`, segment `file/:worktree/:filePath*`
- **`taskFilePeekPane`** (`task-file-peek/web/panes.tsx`) — after `taskDetailPane`, segment `file/:filePath*` (hardcodes `worktree: "main"`)

Both render the same `FileContent` + `FileTabs` UI. Two React contexts bridge file-open actions across component boundaries:

- `FileOpenProvider`/`useFileOpen` — consumed only by `markdown-view.tsx`
- `TaskFileOpenProvider`/`useTaskFileOpen` — consumed only by `task-description.tsx`

Goal: one `filePeekPane` with `after: [conversationPane, taskDetailPane]`, callers pass only `{ worktree, filePath }`, no React contexts.

## Why this works

**Typing:** `Pane.define` defaults `ParentParams = {}`. The `open()` signature is `open(params: FullParams & Record<string, string>)`, so callers can pass extra ancestor keys for disambiguation but don't have to. With the unified pane, `FullParams = { worktree: string; filePath: string }` — that's the only required surface.

**Runtime:** `open()` step 2 (insertion) finds the rightmost valid position in the current chain where the `after` constraint is satisfied. If the chain has `conversationPane`, the pane inserts after it. If the chain has `taskDetailPane`, it inserts there. No ancestor params needed — the chain shape disambiguates.

**Parent params in the body:** The body currently calls `conversationPane.useParams()` to get `convId` (for `useEditedFiles` status badges). This throws when the pane is after `taskDetailPane`. Fix: read the match chain directly via `usePaneMatch()` to extract `convId` safely (returns `undefined` when absent).

## Implementation

### Step 1 — Rewrite `file-peek-pane.tsx` in place

**File:** `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/file-peek-pane.tsx`

- Rename `convFilePeekPane` → `filePeekPane`
- Change `after: [conversationPane]` → `after: [conversationPane, taskDetailPane]`
- Import `taskDetailPane` from `@plugins/tasks/plugins/task-detail/web`
- Replace `conversationPane.useParams()` with safe chain lookup:
  ```ts
  const match = usePaneMatch();
  const convEntry = match?.chain.find(e => e.pane === conversationPane._internal);
  const convId = convEntry?.params.convId as string | undefined;
  ```
- Change `useEditedFiles(convId)` → `useEditedFiles(convId ?? "")`
- Self-open calls drop `convId`/`taskId`: `filePeekPane.open({ worktree, filePath: ... })`
- Remove `<FileOpenProvider value={onFileOpen}>` wrapper
- Remove `FileOpenProvider` import
- Add `:line` suffix handling (already present, just preserve it)

### Step 2 — Update `file-pane/web/index.ts`

- Export `filePeekPane` instead of `convFilePeekPane`
- Remove `FileOpenProvider`, `useFileOpen` exports
- Register `filePeekPane` in contributions

### Step 3 — Delete `file-open-context.tsx`

**File:** `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/file-open-context.tsx`

Delete entirely.

### Step 4 — Update `markdown-view.tsx`

**File:** `plugins/.../file-pane/plugins/markdown/web/components/markdown-view.tsx`

- Remove `useFileOpen` import
- Import `filePeekPane` from parent barrel
- `MarkdownView` already receives `worktree` and `path` as props
- Replace context read with direct call:
  ```ts
  const onFileOpen = useCallback(
    (fp: string, ln?: number) =>
      filePeekPane.open({ worktree, filePath: ln != null ? `${fp}:${ln}` : fp }),
    [worktree],
  );
  ```

### Step 5 — Update `task-description.tsx`

**File:** `plugins/tasks/plugins/task-description/web/components/task-description.tsx`

- Remove `useTaskFileOpen` import and `taskFilePeekPane` import
- Import `filePeekPane` from `@plugins/.../file-pane/web`
- Replace override logic with direct call:
  ```ts
  const openFile = (path: string) =>
    filePeekPane.open({ worktree: "main", filePath: path });
  ```

### Step 6 — Remove `TaskFileOpenProvider` from context and tree

**File:** `plugins/tasks/plugins/task-detail/web/context.tsx`
- Delete `TaskFileOpenCtx`, `TaskFileOpenProvider`, `useTaskFileOpen`

**File:** `plugins/tasks/plugins/task-detail/web/index.ts`
- Remove `TaskFileOpenProvider`, `useTaskFileOpen` from exports

**File:** `plugins/tasks/plugins/task-detail/web/components/task-tree-detail.tsx`
- Remove `onFileOpen` prop from `TaskTreeDetail`
- Remove `<TaskFileOpenProvider value={onFileOpen}>` wrapper
- Remove `TaskFileOpenProvider` import

### Step 7 — Update callers that passed `onFileOpen` to `TaskTreeDetail`

**`plugins/.../tasks-panel/web/components/tasks-pane.tsx`** and **`plugins/.../side-task/web/components/side-task-body.tsx`**:
- Remove `onFileOpen` prop from `<TaskTreeDetail>` call

### Step 8 — Update all `convFilePeekPane.open()` call sites

All drop `convId`, rename import:

| File | Before | After |
|---|---|---|
| `assistant-text-row.tsx` | `convFilePeekPane.open({ convId: ..., worktree: ..., filePath: ... })` | `filePeekPane.open({ worktree: ..., filePath: ... })` |
| `tool-file-path.tsx` | same pattern | same change |
| `user-text-row.tsx` | same pattern | same change |
| `docs-pane.tsx` | same pattern + remove `<FileOpenProvider>` wrapper | same change + remove wrapper |

### Step 9 — Delete `task-file-peek` plugin

Delete entire directory: `plugins/tasks/plugins/task-file-peek/`

### Step 10 — Update pane ID

Change `id: "conv-file-peek"` → `id: "file-peek"`.

## Files modified

| File | Change |
|---|---|
| `plugins/.../file-pane/web/file-peek-pane.tsx` | Rewrite pane def + body |
| `plugins/.../file-pane/web/index.ts` | Update exports |
| `plugins/.../file-pane/web/file-open-context.tsx` | **Delete** |
| `plugins/.../file-pane/plugins/markdown/web/components/markdown-view.tsx` | Direct `filePeekPane.open()` |
| `plugins/tasks/plugins/task-description/web/components/task-description.tsx` | Direct `filePeekPane.open()` |
| `plugins/tasks/plugins/task-detail/web/context.tsx` | Remove TaskFileOpen context |
| `plugins/tasks/plugins/task-detail/web/index.ts` | Remove exports |
| `plugins/tasks/plugins/task-detail/web/components/task-tree-detail.tsx` | Remove onFileOpen prop |
| `plugins/.../tasks-panel/web/components/tasks-pane.tsx` | Remove onFileOpen prop |
| `plugins/.../side-task/web/components/side-task-body.tsx` | Remove onFileOpen prop |
| `plugins/.../assistant-text/web/components/assistant-text-row.tsx` | Rename + drop convId |
| `plugins/.../tool-call/web/components/tool-file-path.tsx` | Rename + drop convId |
| `plugins/.../user-text/web/components/user-text-row.tsx` | Rename + drop convId |
| `plugins/.../docs-button/web/components/docs-pane.tsx` | Rename + drop convId + remove FileOpenProvider |
| `plugins/tasks/plugins/task-file-peek/` | **Delete directory** |

## Verification

1. `./equin build` — must compile and deploy
2. Open a conversation → click a file path in assistant text → file-peek pane opens
3. Open a file-peek pane → click a markdown link inside → navigates to new file in same pane
4. Open `/tasks/:id` standalone → click file link in description → file-peek pane opens
5. Open conversation → toolbar Tasks panel → click file link in task description → file-peek opens in conversation chain
6. Open docs pane → click file link in markdown doc → file-peek opens
