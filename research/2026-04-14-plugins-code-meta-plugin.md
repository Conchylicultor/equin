# Code meta plugin (child of conversation)

## Context

Agents working in a worktree edit many files. Today the conversation view shows
only the terminal — reviewing what the agent changed requires jumping to the
shell or an external editor. The Code plugin surfaces that information inline:
a counter of edited files in the toolbar, a togglable list of those files, and
a click-through file viewer with syntax highlighting, all inside the
conversation view.

This is the first "meta" child plugin under `conversation-view` that owns a
real content region (not just a toolbar button), so it also sets the pattern
for future panes (diff view, build logs, etc.).

## Requirements recap (from clarifying Qs)

- **Edited files source:** `git diff --name-only` against `main` +
  unstaged/untracked in the worktree.
- **Syntax highlighting:** Shiki (lazy-loaded).
- **Resizable split:** shadcn `resizable` primitive (wraps
  `react-resizable-panels`) — keeps styling consistent with the other
  primitives already in `web/src/components/ui/`.
- **Layout:** When viewer is open, the *whole middle area* between toolbar and
  terminal splits horizontally: file list left, file content right. Terminal
  unchanged below.

## Plugin location & structure

`code` is a **meta plugin**: it defines slots + shared state + server API, and
its UI is split across three sub-plugins that each contribute to one of its
slots. This mirrors how `conversation-view` hosts `vscode`/`status`/`open-app`.

```
plugins/conversations/plugins/conversation-view/plugins/code/
├── web/
│   ├── index.ts                  # Meta PluginDefinition: defines slots, registers middle-pane contribution into conversation-view, exports shared state hooks
│   ├── slots.ts                  # Code.ToolbarButton, Code.FileList, Code.Pane slots
│   ├── state.ts                  # zustand store: open/closed, selectedFile, splitSize — exported for sub-plugins
│   ├── use-edited-files.ts       # Shared TanStack Query hook
│   ├── use-file-content.ts       # Shared TanStack Query hook
│   └── components/
│       └── code-container.tsx    # Reads Code.* slot contributions, lays them out (resizable split inside middle pane)
├── server/
│   └── index.ts                  # Hono routes: list edited files, read file content
├── shared/
│   └── protocol.ts               # EditedFile type, zod schemas
└── plugins/
    ├── toolbar-button/
    │   └── web/
    │       ├── index.ts          # Contributes to Code.ToolbarButton (and via it, to Conversation.Toolbar)
    │       └── components/toolbar-button.tsx  # icon + counter; toggles panel via shared state
    ├── file-list/
    │   └── web/
    │       ├── index.ts          # Contributes to Code.FileList
    │       └── components/
    │           ├── edited-file-list.tsx
    │           └── file-row.tsx  # icon + greyed dir + bold filename
    └── file-pane/
        └── web/
            ├── index.ts          # Contributes to Code.Pane
            └── components/file-viewer.tsx  # Shiki-rendered code
```

### How the slots compose

- `Code.ToolbarButton` — rendered by the meta plugin *inside* its
  `Conversation.Toolbar` contribution wrapper. So `toolbar-button` sub-plugin
  ends up in the conversation toolbar, but it only depends on `Code.*` slots.
- `Code.FileList` — rendered in the left panel of the middle-pane split.
- `Code.Pane` — rendered in the right panel; receives `selectedFile` via
  contribution props (or reads shared state directly).

Splitting this way means each sub-plugin has a single responsibility and can
be swapped / extended independently (e.g. a future `diff-pane` sub-plugin
could contribute to `Code.Pane` alongside `file-pane`).

### Registration

All four plugin definitions (meta + 3 sub-plugins) register in
`/web/src/plugins.ts`. Order matters: meta first so its slots exist before
sub-plugins reference them — though in practice React handles that at render
time, so real ordering concern is just grouping for readability.

## Layout integration

Current `conversation-view.tsx` is `flex h-full flex-col` with two children:
toolbar row (lines 55–104) and terminal (lines 105–107). We need to insert a
third region **between** them whose presence is controlled by the Code plugin.

Approach: introduce a new slot `Conversation.MiddlePane` in
`plugins/conversations/plugins/conversation-view/web/slots.ts`:

```ts
export const MiddlePane = defineSlot<{ conversation: Conversation }>(
  'conversation.middle-pane',
);
```

`conversation-view.tsx` renders contributions of this slot between the toolbar
and terminal. If no contribution is active (panel closed), it renders nothing
and the terminal takes the full remaining height — identical to today.

The Code plugin's `MiddlePane` contribution returns `null` when the panel is
closed (state lives in its zustand store, toggled by the toolbar button).

This keeps `conversation-view` agnostic of the Code plugin and preserves the
existing terminal-full-height behavior when Code is off.

## Toolbar button (sub-plugin)

Lives in `plugins/code/plugins/toolbar-button/`. Contributes to
`Code.ToolbarButton`. The meta plugin's `Conversation.Toolbar` contribution
is a thin wrapper that renders all `Code.ToolbarButton` contributions — so
this sub-plugin ends up in the conversation toolbar without knowing about it.

- Icon: `FileDiff` from lucide-react (verify — already used elsewhere).
- Counter label: edited-files count (uses shared `use-edited-files` hook).
- onClick: toggles `isOpen` in the shared Code store.
- Active state styling when panel is open.

## Edited-files API (server)

New server plugin at `plugins/conversations/plugins/conversation-view/plugins/code/server/`.

Endpoints (registered via existing conversation plugin server plumbing — check
`plugins/conversations/server/` for the Hono router pattern):

- `GET /api/conversations/:id/edited-files`
  → `{ files: { path: string; status: 'modified'|'added'|'deleted'|'untracked' }[] }`
  Implementation: look up conversation by id → `worktreePath`. Run:
  - `git -C <worktree> diff --name-status main...HEAD` (committed divergence)
  - `git -C <worktree> status --porcelain` (unstaged + untracked)
  - Merge, dedupe by path, map status codes. Exclude deleted from viewer but
    keep in list (greyed out, not clickable).
- `GET /api/conversations/:id/file?path=<rel>`
  → `{ content: string; language: string }`
  Validates `path` is inside the worktree (resolve + ensure `startsWith(worktreePath)`),
  rejects otherwise (path-traversal guard). Detects language from extension.

Both use `Bun.spawn` / `Bun.file` — no new deps server-side.

Polling vs streaming: start with TanStack Query + `refetchInterval: 3000` while
panel is open. Upgrade to SSE later if it feels laggy (there's already an SSE
pattern in `plugins/conversations/shared/protocol.ts`).

The counter in the toolbar uses the same query so it stays live even when the
panel is closed — but with a longer interval (e.g. 10s) to avoid git churn.
Single query, two consumers via TanStack's cache.

## File list rendering

`<FileRow>`:

```
<FileIcon ext={...} />  <span class="text-muted-foreground">src/foo/bar/</span><span class="font-medium">baz.tsx</span>
```

File icon: use `lucide-react` generic `File`, or add `vscode-icons` style only
if time permits — out of scope for v1. One icon from lucide is fine.

Sorted: modified first, then added, then untracked, alpha within group.
Selected row highlighted; clicking selects it and opens the viewer pane.

## File viewer

Shiki integration:

1. Add `shiki` to `web/package.json`.
2. Use the **bundled-highlighter** entry with a small curated theme + language
   set (ts, tsx, js, jsx, go, json, md, css, sh) to keep bundle size down.
   Lazy-import inside `file-viewer.tsx` so it's only loaded when the panel
   opens: `const { codeToHtml } = await import('shiki/bundle/web')`.
3. Render via `dangerouslySetInnerHTML` on the `<pre>` Shiki returns. Shiki's
   output is trusted (it HTML-escapes input).
4. Theme: pick one matching our existing dark UI (e.g. `github-dark-default`
   or `vitesse-dark`).
5. Wrap in a scroll container; show path + copy button in a small header.

No editing — read-only. Line numbers via Shiki's `transformers`
(`@shikijs/transformers` has `transformerNotationHighlight` etc., but for line
numbers we can just use the `lineNumbers` option or add CSS counters).

## Resizable split

Add shadcn `resizable` primitive to `web/src/components/ui/resizable.tsx`
(copies from shadcn registry — wraps `react-resizable-panels`). Add
`react-resizable-panels` to `web/package.json`.

```
<ResizablePanelGroup direction="horizontal">
  <ResizablePanel defaultSize={30} minSize={20}><EditedFileList/></ResizablePanel>
  <ResizableHandle withHandle />
  <ResizablePanel defaultSize={70}><FileViewer/></ResizablePanel>
</ResizablePanelGroup>
```

Persist the split size in the zustand store (no need for server-side persistence
in v1).

## State (zustand)

Single store in `web/state.ts`:

```ts
{
  isOpen: boolean;
  selectedFile: string | null;
  splitSize: number; // percentage for the left panel
  toggle(): void;
  selectFile(path: string): void;
  setSplitSize(n: number): void;
}
```

Zustand is already used by other plugins — verify pattern in `vscode` /
`status` plugins and match it.

## Critical files to create / modify

Create — **meta plugin** (`plugins/…/conversation-view/plugins/code/`):
- `web/index.ts`, `web/slots.ts`, `web/state.ts`, `web/use-edited-files.ts`, `web/use-file-content.ts`
- `web/components/code-container.tsx`
- `server/index.ts`, `shared/protocol.ts`, `package.json`

Create — **sub-plugins** under `…/code/plugins/`:
- `toolbar-button/web/{index.ts,components/toolbar-button.tsx}` + `package.json`
- `file-list/web/{index.ts,components/edited-file-list.tsx,components/file-row.tsx}` + `package.json`
- `file-pane/web/{index.ts,components/file-viewer.tsx}` + `package.json`

Create — shared UI:
- `web/src/components/ui/resizable.tsx` (shadcn primitive)

Modify:
- `plugins/…/conversation-view/web/slots.ts` — add `MiddlePane` slot.
- `plugins/…/conversation-view/web/components/conversation-view.tsx` — render `MiddlePane.useContributions()` between toolbar and terminal.
- `web/src/plugins.ts` — register the 4 new plugin definitions (meta + 3 children).
- `web/package.json` — add `shiki`, `react-resizable-panels`.
- Conversation server plugin — mount the Code server sub-router.

## Verification

1. `./equin build` succeeds (no schema changes, so no migration).
2. Open `http://claude-1776140814.localhost:9000`, pick a conversation whose
   worktree has actual changes.
3. Toolbar shows the FileDiff icon with correct count (cross-check against
   `git -C <worktree> diff --name-only main...HEAD` + `git status --porcelain`
   in a terminal).
4. Click the button → panel appears between toolbar and terminal; terminal
   shrinks but stays visible.
5. List shows files with greyed directory + bold filename; clicking a file
   opens the viewer with Shiki-highlighted content.
6. Drag the resize handle — split adjusts smoothly.
7. Path-traversal guard: `curl .../file?path=../../etc/passwd` returns 400.
8. Close the panel → terminal regains full height; counter still live.
9. Edit a file in the worktree from a shell → within ~3s the list updates.

## Out of scope for v1

- Diff view (show + vs - lines). Plan to add as a viewer mode later.
- Editing files from the viewer.
- File tree (flat list is sufficient given scope of agent changes).
- Per-conversation persisted split size / open state.
