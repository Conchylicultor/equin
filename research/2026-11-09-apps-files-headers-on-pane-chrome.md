# Files: headers on the standard PaneChrome

## Context

Files now lays out as a Miller row (`2026-11-09-apps-files-preview-as-miller-pane.md`),
but its two panes skip `PaneChrome`, which the pane CLAUDE.md says every pane
must render ("no opt-out"):

- the folder pane draws `FileBrowser`'s own toolbar, a `<Bar tier="pane">` in `Listing`;
- the preview draws `PreviewPane`'s own `<Bar tier="pane">`.

Both date from the port of `proto-1790864772-0r54`, when Files was `FullPane`.
No decision about skipping `PaneChrome` was recorded. What skipping it costs:

- Double-clicking the header does not zoom the column.
- `filesFolderPane.Actions` / `filesPreviewPane.Actions` are declared slots
  that nothing renders.
- There is no standard title item, promote, ×, `⋯` overflow or reordering.
- The folder peek and the conversation Files pane show two stacked bars: their
  pane header, then the browser's own toolbar.
- `attachmentPreviewPane` has the same gap, because it renders `PreviewPane`.

Nothing caught this. `no-adhoc-pane-toolbar` / `no-adhoc-bar` fingerprint
hand-written class strings, and `<Bar tier="pane">` is the escape hatch that
passes both.

Goal: every Files pane renders `PaneChrome`. The browser and the preview put
their controls into the pane header through the sanctioned mechanism. Hosts that
embed them get the same header. One check stops new hand-drawn pane headers.

## Pattern: state above `PaneChrome`, items in the header slot

`PaneChrome` renders header items in the same React tree as its children. The
precedent is the conversation file-peek pane
(`conversations/…/code/plugins/file-pane/web/file-peek-pane.tsx` +
`components/file-peek-header.tsx`):

- a context provider wraps `<PaneChrome>` in every branch;
- the title is `title.component`, and other controls are `pane.Actions`
  contributions that read the context, throwing outside it;
- the body reads the same value.

Shared headers use `definePaneHeaderSlot()` + `Pane.define({ actions })` (pane
CLAUDE.md, "A header shared by several panes"). That way one set of
contributions serves every pane hosting the browser or the preview. Order (items
ahead of the title) is the slot's committed `.jsonc` layout, as the website
header does (`config/apps/website/shell/header.jsonc`).

## 1. Preview header

Plugin `apps/file-explorer/browser`. Files: `web/components/preview-pane.tsx`,
`web/components/file-browser.tsx`, `web/panes.tsx`, `web/index.ts`.

- **The preview's state**: `useFilePreview({ fs, path, name?, home, git })`
  returns `{ file, name, renderers (useFileRenderers), membership }`.
  `<FilePreviewProvider value>` publishes it, and `useFilePreviewHeader()`
  throws outside it.
- **Header pieces**, all reading the context:
  - `FilePreviewTitle`: icon + name + `PreviewMeta`. It is each preview pane's
    `title.component`; `title.useText` stays as it is.
  - `FilePreviewTabs`: `FileHeaderActions` + `FileTabs`, the latter only when
    there is a choice.
  - `OpenWithDefaultApp`: the same gating as today.
- **Close** is `PaneChrome`'s standard ×.
- **The shared slot**: `FilePreviewHeader = definePaneHeaderSlot()`, declared
  in browser's `slots`.
  - `filesPreviewPane` and `attachmentPreviewPane` both take
    `actions: FilePreviewHeader`.
  - Contributions: `FilePreviewHeader({ id: "tabs" | "open-with", component })`.
  - A layout `.jsonc` puts the title first, then a spacer, tabs, open-with.
- **The body** is the `Scroll` + files-document `Theme` + `FileContent`.
  `data-files-preview` stays on the body root, because the Files layout's
  sidebar-hiding rule keys on it.
- **Pane hosts** render `<FilePreviewProvider><PaneChrome pane=…><FilePreviewBody/></PaneChrome></FilePreviewProvider>`
  in every branch: loading and unavailable states keep the provider, as the file
  peek does. The hosts are `FilesPreview` (panes.tsx) and `AttachmentPreview`.
- **The browser's in-pane split** (folder peek, the conversation Files pane) is
  a region inside a pane, not a pane. It lays the same header components in a
  `Bar tier="subpane"` with its own close.
  - The split's close is an `IconButton` that runs `nav.fileTo(null)`.
- `PreviewPane` as a self-drawing component is deleted. Consumers get
  `FilePreviewProvider` / `FilePreviewBody` / the header pieces through the
  browser barrel.

## 2. Folder header

Plugin `apps/file-explorer/browser`, plus folder-peek, the conversation explorer
and plugin-view/file-tree.

- **Lift the toolbar state** out of `Listing` into a browser context above
  `PaneChrome`: `useFileBrowserState(props)` + `<FileBrowserProvider>`.
  - It holds: system, navigator (routed or local), `showHidden` / `lensShown`
    (the existing `useDraft` stores), the composed lens, `query` (reset when
    `dir` changes, as `Listing key={dir}` did), the up target, the path source
    and `pathTarget`.
  - The `ExplorerControlsSlot` dom-scope provider moves here too, so the header
    cell and the tree's portal share it.
  - Selection, keyboard shortcuts and the status bar stay in the body.
- **Header pieces**, reading the context:
  - `FileBrowserNav`: back / forward / up.
  - `FileBrowserPath`: the `PathBar`. It is the `title.component`, so it gets
    the yielding cell.
  - `FileBrowserFilter`: the `SearchInput`, with the same width rules as the
    mockup.
  - `FileBrowserToggles`: show-hidden, the lens toggles, and the
    `ExplorerControlsSlot` cell.
- **The shared slot**: `FileBrowserHeader = definePaneHeaderSlot()`.
  - Users: `filesFolderPane`, `folderPeekPane` and `convFileTreePane` via
    `actions: FileBrowserHeader`. Each sets `title.component: FileBrowserPath`
    and keeps its own `title.useText`.
  - Layout `.jsonc`: nav, then the title, then filter, then toggles.
  - First check nothing else contributes to `folderPeekPane.Actions` /
    `convFileTreePane.Actions`. If something does, move it onto the shared slot
    or keep those panes on their own slots, contributing the same components.
- **`FileBrowser`'s public API**:
  - `<FileBrowserProvider {...props}>` + `<FileBrowserBody/>` for a host that
    owns a pane header. The header pieces are exported for the contributions.
  - `<FileBrowser …/>` stays as the all-in-one for a host with no pane header
    (plugin-view's file-tree section, inside a bordered box). It lays the same
    pieces in a `Bar tier="subpane"`.
  - `atSurfaceEdge` goes: the leading sidebar toggle and the floating-bar safe
    area are `PaneChrome`'s, from `atSurfaceStart` / `atSurfaceEnd`.
  - `preview: "split" | "pane"` stays.
- **The header height** is Files' `chromePaneH` (3rem = the mockup's 48px). It is
  the same for folder-peek and the conversation pane, which wear the Files theme
  scope only inside the `FileBrowser` box. Their header takes the host app's
  height, which is acceptable.

## 3. The check

- **Rule** `pane/no-pane-header-bar` (lint, contributed by `primitives/pane`):
  `<Bar tier="pane">` is the pane header's own tier, so it is banned outside
  `primitives/pane`.
  - `PaneChrome` and its `FallbackChrome` mirror are both inside that plugin.
  - The other user, the bookmarks bar (`apps/browser/plugins/bookmarks`), is a
    secondary strip: move it to `tier="subpane"` if the look holds, else a
    sanctioned exemption in its `exempt/index.ts`.
  - This closes the escape hatch that let the Files headers pass
    `no-adhoc-pane-toolbar`.
- **Not in this change, filed as a task**: a runtime assert in `PaneBox` that
  every pane mounts `PaneChrome` (or `FallbackChrome`), with a declared opt-out
  (`chrome: { none: "<reason>" }`) for the intentionally chromeless panes.
  - Those panes are: the places map, prototype present, the website pages, the
    demo, and about 6 others that are simply missing it.
  - It touches about 15 panes in other apps.

## Execution

Run sequentially; both steps edit `file-browser.tsx` and `panes.tsx`:

1. Agent (Sonnet): the preview header (§1), then `./equin check type-check`.
2. Agent (Opus, load-bearing refactor): the folder header (§2), then type-check.
3. Agent (Sonnet): the lint rule (§3).
4. Me: build, verify, file the PaneBox-assert task.

## Verification

- `./equin check` (type-check, eslint with the new rule, plugins-doc /
  registry / reorder-config in sync), then `./equin build`.
- In the browser, on the Files folder and preview columns:
  - double-clicking the header zooms the column;
  - the ⋯ overflow appears on a narrow window;
  - × closes the preview (with the leave motion);
  - the sidebar toggle shows on the first column, and the floating-bar safe
    area on the last;
  - back / forward / up, the path bar and the filter work.
- The folder peek and the conversation Files pane show one header carrying
  the browser's controls.
- The attachment preview shows the standard header.
- e2e: `demo/e2e/file-explorer-in-demo.ts`, `file-explorer/plugins/git/e2e/git-verify.ts`,
  `attachment-preview/e2e/attach-and-open.ts`. Update selectors that named the
  old bars.
