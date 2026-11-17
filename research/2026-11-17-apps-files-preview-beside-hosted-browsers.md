# Files: hosted browsers preview the open file as a Miller column too

## Context

`89f63ebcfd` made the open file in Files a real Miller column (`files-preview`,
chained under `files-at`), so it slides in and out with the row's motion. Two
other hosts of the same browser kept the old in-pane `ResizablePanelGroup`
split (`FileBrowser`'s `preview: "split"`, `file-browser.tsx` `ReadyBody`):

- the conversation's Files pane (`conv-file-tree`, `files;dir;open`, agent manager);
- the folder peek (`folder-peek`, `folder/:dir/:open?;fs`, homed in Files, a companion).

They kept it only because they "have no pane for the preview":
`files-preview` declares `parent: files-at`, so it can only follow the Files
folder column. There was no other reason. The user picked the split in the
conversation pane and asked why it is not a standard pane.

Goal: in both hosts the open file is a pane of its own beside the browser.
It gets the Miller enter / swap / leave motion, the standard header (title,
renderer tabs, Open with default app, ×, Expand) and its own width, and the
listing never remounts.

## Design

### One shared "preview beside" pane, owned by the browser

Add one parentless pane to `apps/file-explorer/browser` (`web/panes.tsx`).
Every hosted browser pushes it beside itself:

```ts
export const filePreviewBesidePane = Pane.define({
  route: defineRoute({ id: "files-preview-beside", segment: "preview-file/:path;fs" }),
  app: fileExplorerApp,
  title: { useText: ({ path }) => baseName(path), component: FilePreviewTitle },
  actions: FilePreviewHeader,
  useResolve: false,
  companion: true,                       // like folder-peek / attachment-preview
  expand: { app: fileExplorerApp, useTarget: /* Files on the file: folder + preview */ },
  component: FilePreviewBeside,          // → FilePreviewPane(pane, fs, path)
});
```

- `:path` is the file's full display path (`~/…`), one encoded segment, the
  same spelling as `files-at`'s `:dir`. `;fs` is absent for the computer's
  disk, as in `files-at` and `folder-peek`.
- **Parentless, not chained per host.** The file's place is entirely in its
  own params, so it reads nothing from the column to its left. The
  conversation pane's `;dir` is absent by default (it means the checkout,
  known only after reading the conversation), so a chained child could not
  decode a relative `open`. One pane serves both hosts and any future one.
  Segments are global (`pane:segments-unique`), so per-host children would
  each need a new segment anyway.
- The body reuses `FilePreviewPane` (exported from the barrel; today it is
  only internal): Files' theme, the git lens, the renderer tabs.
- **Expand** = Files on that file, through `locationTarget` /
  `useOpenInFiles({ fs, dir: parentPath(path), open: path })`. When a renderer
  has its own Expand (Open in Sonata), `ReadyFilePreviewPane` still passes it
  and that one wins. Check `PaneChrome`'s `expand` prop: if an explicit
  `undefined` blanks the declared one, give `FilePreviewPane` an
  `expandFallback` instead.
- The Files app keeps its own `files-preview` (chained). That chain is what
  rebuilds `[folder, preview]` from scratch for Expand and the legacy
  forwards.

### One navigator for "preview in the column beside"

`FilesFolderBrowser` already computes the right logic inline: `location.open`
comes from `previewPane.useOpenedHere()`, opening a file is `openPane.to(preview,
…, { mode: "push" })` (append, or replace the open preview, so it swaps), and
closing is `store.close(preview, openedId, gesture)`, with the folder alone as
the href. Extract it into a private helper in `browser/web/panes.tsx` that is
generic over the preview pane and its params builder. Two callers use it:

- Files' folder column (`filesPreviewPane`, chained params), with behaviour unchanged;
- a new exported hook for hosted browsers:

```ts
export function useBesidePreviewNavigator(
  fs: BrowsableFileSystem,
  dir: string,
  go: (next: ExplorerLocation) => LinkTarget,   // folder moves: the host's swap
): ExplorerNavigator
```

It replaces `useLocationNavigator` in both hosts. `useLocationNavigator`
(open-file-as-a-param) then has no caller, so it is deleted together with
`LocationParams.open` / the `open` half of `locationParams`, if nothing else
uses them (grep first).

### Hosts

- **Conversation Files pane** (`conversations/conversation-view/explorer`):
  - The segment becomes `files;dir`. `;open` is dropped. An unknown keyed param
    is dropped on parse (`readKeyedParams`), so an old `;open=` URL opens the
    folder without the preview, and a saved route never breaks.
  - `RoutedExplorer` takes `useBesidePreviewNavigator("computer", dir, go)` and
    `<FileBrowserProvider … preview="pane">`.
  - `useConvLocation` returns only the folder.
  - The Expand target (`useOpenInFilesTarget`) reads the open file from
    `filePreviewBesidePane.useOpenedHere()` and no longer from `params.open`.
    The pane's expand hook runs inside its chrome, so `useOpenedHere` resolves
    against this instance.
  - The plugin's CLAUDE.md is updated.
- **Folder peek** (`file-explorer/folder-peek`):
  - The segment becomes `folder/:dir;fs`. `:open?` is dropped. An optional
    positional followed by a pushed pane's segment is exactly the ambiguity
    the pane docs warn about. Old `folder/<dir>/<file>` links are only in
    history (every link built today has `open: null`), so this is acceptable.
  - The host uses the same navigator, with `preview="pane"`. Its Expand reads
    the opened preview the same way.
- `FileBrowser`'s `preview: "split"` mode then has no pane host left. It stays
  for `<FileBrowser/>`, the all-in-one used by hosts with no pane header (grep
  callers). If none remain, delete `SplitPreview` and the split branch in a
  follow-up, not in this change.

### Docs

Update these:

- the browser CLAUDE.md;
- the explorer CLAUDE.md;
- the folder-peek and pane docs that mention "the in-pane split for folder-peek
  / conversation Files pane";
- the generated docs, via `./equin build`.

## Files

- `plugins/apps/plugins/file-explorer/plugins/browser/web/panes.tsx`: new pane,
  shared navigator helper, `useBesidePreviewNavigator`, Files' folder column
  moved onto the helper.
- `plugins/apps/plugins/file-explorer/plugins/browser/web/index.ts`: register
  the pane and export the hook (and `FilePreviewPane` only if needed outside).
- `plugins/conversations/plugins/conversation-view/plugins/explorer/web/{panes.tsx,components/conv-explorer-body.tsx,components/conv-location.ts}`
- `plugins/apps/plugins/file-explorer/plugins/folder-peek/web/panes.tsx`

## Verification

- `./equin check` (tsc, `pane:segments-unique`, boundaries, docs in sync).
- `./equin test plugins/apps/plugins/file-explorer plugins/conversations/plugins/conversation-view/plugins/explorer`
- `./equin build`, then with `browser_*` on the conversation's Files pane:
  - open a file: a preview column appears beside the listing;
  - open another: it swaps;
  - × and Esc close the column;
  - changing folder keeps the preview open;
  - Back / Forward walk the history;
  - Expand opens Files on that file;
  - a reload restores the row.
- Run the same checks on a folder peek.
- `register_before_after` on the conversation Files pane with a file open.
- Rerun the existing e2e scripts touching folder-peek / the explorer, if any
  (`rg -l "folder-peek|conv-file-tree" -g 'e2e/*.ts'`).
