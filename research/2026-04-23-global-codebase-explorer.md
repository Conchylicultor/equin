# Mini Codebase Explorer

## Context

The app currently has two narrow file views inside a conversation (edited markdown via `docs-button`, worktree changes via `review`) but no way to browse the whole codebase. This feature adds a general-purpose file explorer with two entry points:

- **Conversation toolbar** — browse the conversation's worktree.
- **Shell sidebar** — browse the main worktree.

Clicking a file opens it in a VSCode-style 2-column layout (tree left, file viewer right) that reuses the existing `FilePane.Renderer` tabs (Raw / Markdown / Image / Diff).

To avoid duplicating the three existing file-reading endpoints, this change **refactors the `code` plugin's HTTP routes from conversation-scoped to worktree-scoped**. `editedFilesResource` stays conversation-scoped (it's intrinsically about "what this conversation changed") and is not touched.

## High-level architecture

```
                       ┌────────────────────────────────────┐
Conversation toolbar ──▶│  plugins/code-explorer/            │
                        │                                    │
Shell sidebar ─────────▶│  - Shell.Sidebar contribution      │
                        │  - Code.ToolbarButton contribution │
                        │  - globalFileTreePane              │
                        │  - convFileTreePane                │
                        │  - Shared <FileTreeView/>          │
                        │  - Server: /api/code/:worktree/*   │
                        └────────────────────────────────────┘
                                       │
                                       ▼
                         resolveWorktreePath(id)
                           id === "main" → mainRoot
                           else          → getAttempt(id)?.worktreePath ?? 404
```

One new plugin at the top level (`plugins/code-explorer/`). It contributes to both slots and owns all new server endpoints.

**Worktree identifier.** `:worktree` in URLs is either the reserved sentinel `"main"` (main worktree) or an **attempt id** from `_attempts`. The resolver looks up `worktreePath` in the DB rather than constructing paths from disk — the DB is authoritative (an attempt's `worktreePath` could in principle change; the `.claude/worktrees/<id>` layout is an implementation detail). The conversation toolbar button passes `conversation.attemptId`, not `conversation.id`.

## Endpoint shape (new)

All live in `plugins/code-explorer/server/`.

| Route | Query | Response | Notes |
|---|---|---|---|
| `GET /api/code/:worktree/tree` | – | `{ files: string[] }` | `git ls-files --cached --others --exclude-standard`, sorted |
| `GET /api/code/:worktree/file` | `path`, optional `ref="HEAD"\|"main"` | `{ content: string }` | Same semantics as old `/api/conversations/:id/file` |
| `GET /api/code/:worktree/diff` | `path`, optional `base="HEAD"\|"main"` | `{ diff: string }` | Same as old `/api/conversations/:id/diff` |
| `GET /api/code/:worktree/image` | `path`, optional `ref` | raw bytes + `Content-Type: image/*` | Same as old `/api/conversations/:id/image` |

**`resolveWorktreePath(id)`** (new helper — lives in the plugin: `plugins/code-explorer/server/internal/resolve-worktree-path.ts`, since it depends on `@plugins/tasks-core/server`):
- `id === "main"` → `await ensureMainWorktreeRoot()` (from `server/src/worktree.ts`)
- else → `(await getAttempt(id))?.worktreePath ?? null` — handler returns 404 on null.

**Reserved name `"main"`** is used in URLs to refer to the main worktree. All other values are treated as attempt ids; the DB is the source of truth for the filesystem path.

**Deleted** (replaced by the above):
- `GET /api/conversations/:id/file`
- `GET /api/conversations/:id/diff`
- `GET /api/conversations/:id/image`

Verified no other consumers: `grep "/api/conversations/.*\\(file\\|diff\\|image\\)"` returns only the four renderer plugins being updated.

## Slot and type changes

### `FilePane.Renderer` component props

`plugins/.../code/plugins/file-pane/web/slots.ts` — line 16:

```diff
-  component: ComponentType<{ conversationId: string; path: string }>;
+  component: ComponentType<{ worktree: string; path: string }>;
```

### `FilePaneView` props

`plugins/.../code/plugins/file-pane/web/components/file-pane.tsx` — props shape today is `{ conversation: ConversationRecord; path: string; status: EditedFileStatus }`. Change to `{ worktree: string; path: string; status: EditedFileStatus }`. Only caller is `docs-pane.tsx` (`ReviewView` calls `DiffView` directly, not `FilePaneView`).

### `EditedFileStatus` — add `"clean"`

`plugins/.../code/shared/protocol.ts`:

```diff
-export type EditedFileStatus = "modified" | "added" | "deleted" | "untracked";
+export type EditedFileStatus = "modified" | "added" | "deleted" | "untracked" | "clean";
```

Reason: the tree explorer doesn't know whether a listed file has pending changes (finding out would require a second `git status` call per tree load). Passing `"clean"` is accurate and lets the diff renderer return `false` so only Raw/Markdown/Image show up for unchanged files. `supportsDiff` in `.../diff/web/internal/supports.ts` already enumerates statuses explicitly, so adding `"clean"` leaves it returning `false` by the existing fallthrough. No change to `editedFilesResource` — it never emits `"clean"`.

## Pane definitions

### `globalFileTreePane` (top-level)

```ts
// plugins/code-explorer/web/panes.tsx
export const globalFileTreePane = Pane.define({
  id: "global-file-tree",
  path: "/code/:worktree/:path*",
  component: GlobalFileTreeBody,
});
```

URLs:
- `/code/main/` — main worktree, no file selected
- `/code/main/plugins/shell/web/slots.ts` — main worktree, file selected
- `/code/<attempt-id>/src/...` — agent worktree (resolved via DB)

### `convFileTreePane` (conversation-scoped)

```ts
// plugins/code-explorer/web/panes.tsx
export const convFileTreePane = Pane.define({
  id: "conv-file-tree",
  parent: conversationPane,
  path: "files/:path*",
  component: ConvFileTreeBody,
});
markMainPane(convFileTreePane);
```

Full URL: `/c/:convId/files[/:path*]`. `markMainPane` makes the 2-column explorer take over the conversation's main area (same pattern as `convReviewPane`).

`ConvFileTreeBody` reads the conversation from `conversationPane.useData()`, `path` from `convFileTreePane.useParams()`, and renders `<FileTreeView worktree={conversation.attemptId} selectedPath={path ?? ""} onSelect={p => convFileTreePane.open({ convId: conversation.id, path: p })} />`.

`GlobalFileTreeBody` does the same, sourcing `worktree` and `path` from `globalFileTreePane.useParams()`.

## Shared `<FileTreeView/>` component

Home: `plugins/code-explorer/web/components/file-tree-view.tsx`.

```tsx
interface FileTreeViewProps {
  worktree: string;
  selectedPath: string;
  onSelect: (path: string) => void;
}
```

Layout:
- `ResizablePanelGroup` (horizontal) with `ResizablePanel` left (~25%, min ~15%) holding `<FileTree/>` and right (~75%) holding `<FilePaneView worktree={worktree} path={selectedPath} status="clean" />` when a file is selected, else an empty-state message. Uses `@/components/ui/resizable` (already used by tasks layout).

`<FileTree/>` internals (`plugins/code-explorer/web/components/file-tree.tsx`):
- Fetch `GET /api/code/${worktree}/tree` in a `useEffect` keyed on `worktree`.
- Build an in-memory trie from the flat path list (no dependency on `@plugins/tree` — its `TreeList` is CRUD-oriented and doesn't fit a read-only file tree).
- Render depth-first: folders first, then files, alpha-sorted within each parent. Icons: `MdChevronRight`/`MdExpandMore` + `MdFolder`/`MdFolderOpen` + `MdInsertDriveFile` (react-icons/md, already the project convention).
- Expand state: `useState<Set<string>>`, seeded with ancestor folders of `selectedPath`.
- Selection: `bg-accent` on the row matching `selectedPath`; clicking fires `onSelect(path)`.

No virtualization — typical repos (a few thousand entries) render fine.

## File-by-file changes

### Server: new plugin

1. **CREATE** `plugins/code-explorer/package.json` — `@singularity/plugin-code-explorer` workspace package.
2. **CREATE** `plugins/code-explorer/server/index.ts` — `ServerPluginDefinition` wiring the four routes below.
3. **CREATE** `plugins/code-explorer/server/internal/resolve-worktree-path.ts` — `resolveWorktreePath(id)`: `"main"` → `ensureMainWorktreeRoot()`; else → `getAttempt(id)?.worktreePath ?? null`.
4. **CREATE** `plugins/code-explorer/server/internal/tree-handler.ts` — `git ls-files --cached --others --exclude-standard` via `Bun.spawn(["/usr/bin/git", "-C", wt, ...])` (pattern from `get-edited-files.ts`).
5. **CREATE** `plugins/code-explorer/server/internal/file-content-handler.ts` — port of existing `handleFileContent`, using `resolveWorktreePath` instead of `getConversation`.
6. **CREATE** `plugins/code-explorer/server/internal/file-diff-handler.ts` — port of `handleFileDiff`.
7. **CREATE** `plugins/code-explorer/server/internal/image-handler.ts` — port of `handleImageContent`.
8. **CREATE** `plugins/code-explorer/server/internal/resolve-ref.ts` — extract the `resolveRef` helper currently duplicated across file-content and image handlers (merge-base logic for `ref="main"`).
9. **MODIFY** `server/src/plugins.ts` — register `codeExplorerPlugin` (after `tasksCorePlugin`, since it depends on `getAttempt`).

### Server: remove old routes

10. **MODIFY** `plugins/.../code/server/index.ts` — drop the three `httpRoutes` entries; keep `resources: [editedFilesResource]`.
11. **DELETE** `plugins/.../code/server/internal/file-content-handler.ts`.
12. **DELETE** `plugins/.../code/server/internal/file-diff-handler.ts`.
13. **DELETE** `plugins/.../code/server/internal/image-handler.ts`.
    (`get-file-content.ts`, `get-file-diff.ts`, `get-edited-files.ts`, `watch-edited-files.ts`, `edited-files-resource.ts` are all untouched.)

### Client: FilePane slot + renderer prop renames + URL updates

14. **MODIFY** `plugins/.../code/plugins/file-pane/web/slots.ts` — component prop `conversationId → worktree` (slot type).
15. **MODIFY** `plugins/.../code/plugins/file-pane/web/components/file-pane.tsx` — prop `conversation → worktree: string`; pass `worktree` to the rendered component.
16. **MODIFY** `plugins/.../code/plugins/file-pane/plugins/raw/web/components/raw-view.tsx` — prop rename.
17. **MODIFY** `plugins/.../code/plugins/file-pane/plugins/raw/web/use-file-content.ts` (or `.../file-pane/web/use-file-content.ts` depending on where the hook lives) — param + URL `/api/code/${worktree}/file?...`.
18. **MODIFY** `plugins/.../code/plugins/file-pane/plugins/markdown/web/components/markdown-view.tsx` — prop rename.
19. **MODIFY** `plugins/.../code/plugins/file-pane/plugins/image/web/components/image-view.tsx` — prop rename + URL `/api/code/${worktree}/image?...`.
20. **MODIFY** `plugins/.../code/plugins/file-pane/plugins/diff/web/use-file-diff.ts` — param rename + URL.
21. **MODIFY** `plugins/.../code/plugins/file-pane/plugins/diff/web/use-diff-tokens.ts` — param rename + URLs (fetches HEAD/main baselines).
22. **MODIFY** `plugins/.../code/plugins/file-pane/plugins/diff/web/components/diff-view.tsx` — prop + inline fetch URLs.
23. **MODIFY** `plugins/.../code/plugins/file-pane/plugins/diff/web/components/image-diff-view.tsx` — prop + `imageUrl()` helper.
24. **MODIFY** `plugins/.../code/plugins/file-pane/plugins/diff/web/internal/diff-or-image-view.tsx` — forwarded props type.

(Rely on TypeScript: the `FileRendererContribution.component` type change will surface any missed spot.)

### Client: existing FilePaneView / DiffView callers

25. **MODIFY** `plugins/.../code/plugins/docs-button/web/components/docs-pane.tsx` — `<FilePaneView conversation={conversation}...>` → `<FilePaneView worktree={conversation.attemptId}...>`.
26. **MODIFY** `plugins/.../code/plugins/review/web/components/review-view.tsx` — line 95 `conversationId={conversation.id}` → `worktree={conversation.attemptId}`.
27. **MODIFY** `plugins/.../code/plugins/review/web/components/review-file-row.tsx` — prop `conversationId → worktree`; the `<DiffView>` call updates accordingly.

### Client: status enum

28. **MODIFY** `plugins/.../code/shared/protocol.ts` — add `"clean"` to `EditedFileStatus`.

### Client: new plugin

29. **CREATE** `plugins/code-explorer/web/panes.tsx` — defines both `globalFileTreePane` and `convFileTreePane`; calls `markMainPane(convFileTreePane)`.
30. **CREATE** `plugins/code-explorer/web/components/file-tree-view.tsx` — shared 2-column layout + empty state.
31. **CREATE** `plugins/code-explorer/web/components/file-tree.tsx` — trie-based renderer with expand/collapse and selection.
32. **CREATE** `plugins/code-explorer/web/components/sidebar-button.tsx` (or inline in `index.ts`) — calls `globalFileTreePane.open({ worktree: "main", path: "" })`.
33. **CREATE** `plugins/code-explorer/web/components/conv-tree-button.tsx` — `Code.ToolbarButton` icon button; calls `convFileTreePane.open({ convId: conversation.id, path: "" })`. Uses `conversationPane.useData()` to get the conversation.
34. **CREATE** `plugins/code-explorer/web/components/global-file-tree-body.tsx` and `conv-file-tree-body.tsx` — thin shells reading params from their respective panes and mounting `<FileTreeView/>`.
35. **CREATE** `plugins/code-explorer/web/index.ts` — `PluginDefinition` contributing `Shell.Sidebar` (icon: `MdFolderOpen`, title: "Explorer", `onClick: () => globalFileTreePane.open({ worktree: "main", path: "" })`, group: `"System"`) and `Code.ToolbarButton` (component: `ConvTreeButton`).
36. **MODIFY** `web/src/plugins.ts` — register `codeExplorerPlugin`.

### Plugin list documentation

37. **MODIFY** `docs/plugins.md` — add the new `code-explorer` entry (its contributions, exports, endpoints).

## Critical files to read first during implementation

- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/slots.ts` — slot definition (type change).
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/components/file-pane.tsx` — FilePaneView signature.
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/web/panes.tsx` — reference for `markMainPane`.
- `plugins/tasks/web/index.ts` — sidebar button pattern (`Shell.Sidebar({ onClick: () => pane.open({}) })`).
- `server/src/worktree.ts` — existing `ensureMainWorktreeRoot` (referenced by `resolveWorktreePath` for the `"main"` case).
- `plugins/tasks-core/server/internal/queries/attempts.ts` — existing `getAttempt(id)` used by `resolveWorktreePath`.
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/get-edited-files.ts` — canonical `Bun.spawn` git helper pattern.

## Verification

1. `./equin build` — zero type errors (the `FileRendererContribution` signature change will catch any missed rename).
2. **Regression — existing views:**
   - Open a conversation with edits → click Docs → select a `.md` file → Markdown tab renders (confirms `/api/code/:worktree/file` is reached).
   - Click Review → expand a modified file row → diff renders (`/api/code/:worktree/diff`).
   - Inspect Network tab: requests go to `/api/code/<attemptId>/...`, no requests to the deleted `/api/conversations/:id/file|diff|image`.
3. **Conversation tree (new):**
   - Open the new toolbar button → URL becomes `/c/<convId>/files`.
   - Tree populates from `git ls-files`; expand a folder; click a `.ts` file → URL `/c/<convId>/files/src/...`; Raw tab renders. Click Diff tab → hidden if file is clean (the "clean" status correctly gates out the diff renderer).
   - Reload at the deep URL → explorer reopens with the file selected.
4. **Global explorer (new):**
   - Click "Explorer" sidebar entry → URL `/code/main/`; files reflect the main worktree.
   - Click a file → URL `/code/main/plugins/shell/web/slots.ts`; viewer renders.
   - Navigate to `/code/<attempt-id>/` of an existing attempt → that worktree's files appear (DB lookup).
   - `curl http://<namespace>.localhost:9000/api/code/main/tree` → JSON list. `curl http://.../api/code/nonexistent-id/tree` → 404.
5. Deploy and exercise under the normal gateway URLs at `http://<worktree>.localhost:9000`.
