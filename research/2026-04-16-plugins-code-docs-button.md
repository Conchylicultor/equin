# Replace `edited-files-button` with `docs-button`

## Context

The `code` meta plugin currently exposes two toolbar buttons:

- `edited-files-button` — opens a **middle pane** (over the terminal) listing every edited file in the worktree. Clicking a row opens that file in the **right pane** via `filePane({ path, status })`.
- `review` — opens a full-screen view to review every changed file.

Now that `review` covers the "browse all changes" use case end-to-end, the `edited-files-button` + middle-pane flow is redundant. We want to retire it and replace it with a more focused tool: a **docs button** that surfaces design docs (`.md` / `.mdx` files) edited in the conversation worktree.

The new docs button collapses the previous two-pane interaction (middle list → right viewer) into a single right pane with a stacked layout (list on top, viewer below), so the user no longer needs to bounce between panes.

## Design

**Behavior**

- Toolbar button labelled "Docs" (icon + count of `.md`/`.mdx` files in the diff).
- Disabled when the conversation has zero markdown files in its diff (mirrors `review`'s disabled-when-empty behavior).
- Click toggles a single right pane (`Conversation.OpenRightPane`).
- The right pane has two stacked sections:
  - **Top** — list of `.md`/`.mdx` files in the diff (reuses the row UI from the old `file-list` plugin, but selection is local state, not a separate pane).
  - **Bottom** — file viewer for the currently selected file (reuses `FilePaneView` rendering pipeline so the existing `markdown` / `diff` / `raw` renderer tabs all work).
- Default selection: **first markdown file alphabetically**.
- If the selected file disappears from the diff, fall back to the new first alphabetical entry.

**What goes away**

- Middle-pane file list (the pane displayed over the terminal). It has no other entry point once the button is removed.
- The standalone right-pane factory `filePane({ path, status })`, since rows no longer open files in a sibling pane.

**What stays**

- `FilePane.Renderer` slot and the `markdown` / `diff` / `raw` renderer plugins — reused by the docs viewer.
- `useEditedFiles(conversationId)` hook — used to source the file list.
- `EditedFile` / `EditedFileStatus` types in `code/shared/protocol.ts`.

## Files

### Delete

- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/edited-files-button/` — whole folder.
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-list/` — whole folder. The `FileRow` component and `editedFileListPane()` factory disappear with it.
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/views.tsx` — remove `filePane()` and `FILE_PANE_ID_PREFIX`. `file-pane` plugin remains (it defines the renderer slot the markdown/diff/raw plugins register against).

### Add

`plugins/conversations/plugins/conversation-view/plugins/code/plugins/docs-button/`:

- `package.json` — same shape as the sibling plugin packages.
- `web/index.ts` — registers `Code.ToolbarButton({ component: DocsButton })`.
- `web/views.tsx` — exports `docsRightPane()` returning a `RightPaneDescriptor` with stable id `code.docs-pane` and component `DocsPane`.
- `web/components/docs-button.tsx` — toolbar button. Uses `useEditedFiles(conversation.id)`, filters to `/\.mdx?$/`, shows count, disabled when count is 0, toggles `Conversation.OpenRightPane(docsRightPane())`. Uses `useRightPane()` to compute pressed state. Pattern mirrors `review-button.tsx` line-for-line.
- `web/components/docs-pane.tsx` — the stacked layout:
  - Header with title + close button (`Conversation.OpenRightPane(null)`).
  - Top section: scrollable list of `.md`/`.mdx` files. Each row is a button with selected/unselected styling; `onClick` updates local `selectedPath` state.
  - Bottom section: renders `<FilePaneView conversation={conversation} path={selectedPath} status={...} />`. (See "Header refactor" below.)
  - Local state initialized to `files[0].path` after sort; `useEffect` re-defaults if `selectedPath` is no longer in the list.

### Modify

- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/components/file-pane.tsx` — make the close button optional. Add an optional prop like `showHeader?: boolean` (default `true`) or split out a `<FilePaneRenderer>` body component so `docs-pane.tsx` can embed just the body + tabs without the duplicate close button.
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/index.ts` — drop any exports that referenced `views.tsx` if present.
- `package.json` of the parent `code` plugin (or wherever sub-plugins are loaded) — replace `edited-files-button` and `file-list` registrations with `docs-button`. Verify by running `./equin build`; the plugin loader will surface missing references.

### Plugin docs

- `docs/plugins.md` — under `code`, replace the `edited-files-button` and (implicit) `file-list` entries with `docs-button`.

## Reusable pieces (do not duplicate)

- `useEditedFiles` — `plugins/.../code/web/use-edited-files.ts`.
- `EditedFile`, `EditedFileStatus` types — `plugins/.../code/shared/protocol.ts`.
- `FilePane.Renderer` slot, `resolveRenderers` — `plugins/.../code/plugins/file-pane/web/slots.ts`.
- `FilePaneView` (after refactor to allow header-less mode) — `plugins/.../code/plugins/file-pane/web/components/file-pane.tsx`.
- Status-dot styling and row layout from the deleted `FileRow` — copy into `docs-pane.tsx` (small enough that a shared abstraction would be over-engineered for one caller).
- `Button` from `@/components/ui/button`, `useRightPane` / `useMiddlePane` / `Conversation` commands from `conversation-view/web/commands`.

## Verification

1. `./equin build` from the worktree root — must pass (catches missing imports from the deleted files and the registration changes).
2. Open `http://claude-1776361358.localhost:9000` and pick a conversation whose worktree has at least one edited `.md` file.
3. Toolbar shows a "Docs" button next to "Review" with the markdown-file count. Confirm:
   - Pressed state toggles when clicked.
   - Right pane shows the list at top and the first markdown file (alphabetical) rendered below.
   - Clicking a different markdown row swaps the viewer.
   - Switching renderer tabs (`Markdown` / `Raw` / `Diff`) still works inside the docs pane.
   - Close button collapses the whole pane.
4. Switch to a conversation whose worktree has no `.md` changes — button is rendered but disabled, no pane opens on click.
5. Confirm the old middle pane (file list over terminal) is gone everywhere — no toolbar entry triggers it.
6. Take a screenshot for visual confirmation:
   ```bash
   bunx playwright screenshot --wait-for-timeout 3000 --viewport-size "1280,800" \
     http://claude-1776361358.localhost:9000/c/<id> /tmp/docs-pane.png
   ```
