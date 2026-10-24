# Extract breadcrumb primitive plugin

## Context

The `FilePathLabel` component in the file-pane plugin renders file paths as `dir/ + basename` with a copy button. It lives deep inside the conversation-view plugin tree but is imported by the task-file-peek plugin too — a cross-plugin dependency on an internal component. The user wants it extracted into a proper primitive with per-segment interactivity: each folder in the path should be a clickable element that fires a callback, so consumers can wire navigation.

## Approach

Create `plugins/primitives/plugins/breadcrumb/` as a new UI primitive. It replaces `FilePathLabel` everywhere.

### New plugin structure

```
plugins/primitives/plugins/breadcrumb/
  CLAUDE.md
  web/
    index.ts                       # barrel + PluginDefinition default
    internal/
      breadcrumb.tsx               # <Breadcrumb> component
```

### Component API

```tsx
interface BreadcrumbProps {
  path: string;
  onNavigate?: (dirPath: string) => void;
}
```

- Splits `path` on `/` into segments.
- Each directory segment renders as a `<button>` (when `onNavigate` provided) or `<span>` (when not), styled muted with hover highlight.
- `/` separators rendered between segments in even more muted text.
- The last segment (filename) renders in `font-medium` — not clickable, it's the current item.
- A copy-to-clipboard ghost button at the end (preserved from current `FilePathLabel`).
- The outer container keeps `flex min-w-0 items-baseline gap-0.5` for truncation in tight pane headers.

When a segment is clicked, `onNavigate` receives the full path up to and including that segment:
- Path: `plugins/deploy/web/index.ts`
- Click `plugins` → `onNavigate("plugins")`
- Click `deploy` → `onNavigate("plugins/deploy")`
- Click `web` → `onNavigate("plugins/deploy/web")`

### Consumer migration

All three current `FilePathLabel` usage sites switch to `<Breadcrumb>`:

1. **`file-pane/web/file-peek-pane.tsx`** (conv-file-peek pane chrome title) — replace `<FilePathLabel path={filePath} />` with `<Breadcrumb path={filePath} />`. No `onNavigate` wired initially.

2. **`file-pane/web/components/file-pane.tsx`** (embedded `FilePaneView` header) — same replacement. No `onNavigate` initially.

3. **`tasks/plugins/task-file-peek/web/panes.tsx`** (task-file-peek pane chrome title) — same replacement. Import switches from `@plugins/.../file-pane/web` to `@plugins/primitives/plugins/breadcrumb/web`.

### Cleanup

- Remove `FilePathLabel` from `file-pane/web/components/file-path-label.tsx`.
- Remove the `export { FilePathLabel }` line from `file-pane/web/index.ts`.
- Update `file-pane/CLAUDE.md` and create `breadcrumb/CLAUDE.md`.

## Files to modify

| Action | File |
|--------|------|
| **Create** | `plugins/primitives/plugins/breadcrumb/web/index.ts` |
| **Create** | `plugins/primitives/plugins/breadcrumb/web/internal/breadcrumb.tsx` |
| **Create** | `plugins/primitives/plugins/breadcrumb/CLAUDE.md` |
| **Edit** | `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/file-peek-pane.tsx` — swap import |
| **Edit** | `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/components/file-pane.tsx` — swap import |
| **Edit** | `plugins/tasks/plugins/task-file-peek/web/panes.tsx` — swap import |
| **Edit** | `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/index.ts` — remove FilePathLabel export |
| **Delete** | `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/components/file-path-label.tsx` |

## Reuse

- Copy button pattern: lifted directly from current `FilePathLabel` (same `useState`/`useCallback` + `MdContentCopy`/`MdCheck` icons).
- Plugin structure: mirrors `plugins/primitives/plugins/relative-time/` (barrel + `internal/` + `PluginDefinition` with `contributions: []`).
- Styling: `@/components/ui/button` for the ghost copy button, Tailwind for segments.

## Verification

1. `./equin build` — must succeed (frontend + server).
2. `./equin check` — must pass (plugin boundaries, barrel purity, eslint).
3. Visual: open a conversation with file changes, click a file link → the file-peek pane header should show the path with each folder segment as a distinct element. Hover over a segment — no click behavior yet (no `onNavigate` wired), but segments should be visually distinct.
4. Copy button still works — click it, paste, verify the full path was copied.
