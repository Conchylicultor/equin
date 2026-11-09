# Files: the preview as a Miller child pane

## Context

Opening a file in Files does not animate, although every other column-based app
gets the Miller enter / leave / swap motion (`layouts/miller` `ColumnMotion`).
The reasons:

- Files uses the `FullPane` layout.
- The preview is not a pane. It is the `;open` / `:open?` param of the folder pane,
  which `FileBrowserReady` draws as its own `ResizablePanelGroup` split.

Goal: the preview becomes a real child pane in a Miller row, so it gets the
shared motion. The listing must still never remount on open or close.

## Design

**One folder pane, one preview pane chained under it.**

- **`filesFolderPane`**: `browse/:dir;fs` (id `files-at`, the id the pane had at `/files/at/…`; not `at/…`, which the Demo app's `at/:url*` claims on a cold load).
  - It replaces the per-system `files-computer-at` / `files-browser-at` panes.
  - `;fs` names the file system; when it is absent the folder is on the computer's
    disk, as in `folder-peek`.
  - Merging is forced: two folder panes would each need a preview child, and two
    `preview/:open` children collide (`pane:segments-unique`).
  - Width 560.
- **`filesPreviewPane`**: `preview/:open` (id `files-preview`), with
  `parent: filesFolderRoute`. Width 600.
  - The URL reads `/files/browse/~%2FProjects;fs=browser/preview/README.md`.
  - `open` is encoded relative to the folder (`encodeOpenParam`), as before.
  - A root open of the preview builds `[folder, preview]` from the declared chain.
    That is what Expand ("Open in Files" from a file peek) and the legacy
    forwards need.
- **Opening a file** is a `push` from the folder pane: append, or replace the
  current preview. This gives Miller's enter / swap motion.
- **Closing** closes the preview instance: × in its header, Esc, or the file being
  deleted. This gives the leave motion. The folder slot is untouched, so the
  listing keeps its scroll and expansion.
- **Index pane** (`/files`): it redirects (replace) to the folder pane on `~` of
  the home system once that system is known. Every Files location is then one
  shape. The `;open` keyed param is dropped.
- **Legacy URLs**:
  - `/files/computer/at/<dir>[/<open>]` and `/files/browser/at/<dir>[/<open>]`
    become forwarding panes, keeping the old ids `files-computer-at` /
    `files-browser-at`. They do a root open with `replace: true`.
  - `/files/at/…` is dropped: loaded cold it already opened the Demo app,
    whose `at/:url*` claims it.
- **Layout**: `FileExplorerLayout` renders `<MillerColumns />` in place of
  `<FullPane />`. The sidebar-hiding rule keyed on `data-files-preview` stays: the
  preview pane still renders `PreviewPane`.

**FileBrowser** keeps the in-pane split for hosts that have no pane for the
preview (folder-peek, the conversation Files pane). A new `preview` prop chooses:

- `"split"` (default): today's behaviour.
- `"pane"`: the listing only. `nav.location.open` still marks the open row, and
  `nav.fileTo` opens or closes the preview pane.

In `"pane"` mode the listing's `endSafeArea` comes from `useReservesFloatingBar()`
(it is the surface end only while no preview is open).

**Navigator** (`useFilesNavigator`, in the folder pane):

- `location.open` comes from `filesPreviewPane.useOpenedHere()`.
- `fileTo(path)` is `openPane.to(filesPreviewPane, …, { mode: "push" })`.
- `fileTo(null)` closes the opened preview, and its `href` is the folder's own
  link.

`useExplorerLocation` (the Places sidebar) reads the folder entry plus the
preview entry. `useOpenInFiles` and `useExplorerFolderTarget` do a root open
of the preview when a file is given, otherwise of the folder.

## Files

- `plugins/apps/plugins/file-explorer/plugins/browser/web/panes.tsx`: the panes,
  navigators and links.
- `plugins/apps/plugins/file-explorer/plugins/browser/web/components/file-browser.tsx`:
  the `preview` prop.
- `plugins/apps/plugins/file-explorer/plugins/browser/web/index.ts`: exports and
  registrations.
- `plugins/apps/plugins/file-explorer/plugins/shell/web/components/file-explorer-layout.tsx`:
  switch to `MillerColumns`.
- Consumers of the removed exports: `places-sidebar.tsx`, `folder-peek`, the
  conversation `explorer`, and `internal/file-target.ts`.
- e2e scripts that build `/files/browse/<dir>/<open>` URLs.

## Accepted behaviour changes

- At ≤640px the preview no longer replaces the listing outright. Miller
  compresses the columns and scrolls the row to the new column, as it does in
  every other app.
- The listing / preview split ratio is now the column widths
  (560 / 600, the leaf fills), resizable by Miller's divider.

## Verification

- `./equin check`, then `./equin build`.
- In a browser, at `/files`:
  - the index redirects to `/files/browse/~`;
  - clicking a file slides the preview in;
  - clicking another file swaps it;
  - Esc and × slide it out;
  - Back / Forward walk the opens;
  - an old `/files/computer/at/<dir>/<file>` URL forwards.
- Run `file-explorer/e2e/explorer-verify.ts` and `git/e2e/git-verify.ts`.
