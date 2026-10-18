# File explorer: multi-row selection, drag to move, drag to pin

## Context

In the Files tree (`/files/at/~`), pressing and dragging across rows selects
**text**, because rows carry no `user-select: none` and nothing claims the
gesture. The user wants Finder-class behaviour:

1. **Row selection.** Click selects one row, Cmd/Ctrl-click toggles a row,
   Shift-click selects a range, Cmd+A selects all, and Shift+↑/↓ extends the
   selection.
2. **Drag to move.** Dropping the dragged rows on a folder row moves them on
   disk. A collapsed folder springs open after you hover it for a moment.
3. **Drag to pin.** Dropping rows on the Places sidebar's **Favorites** pins them.

What the exploration found:

- **Single selection only.** DataView has `selectedRowId: string` and nothing
  else. There is no modifier handling in `tree/web/internal/tree-row-gestures.ts`,
  and `useTreeKeyboard` ignores Shift and Cmd. `primitives/multi-select` has a
  checkbox-only reducer with anchor, range and select-all.
- **Row drag is reorder-only.** It uses dnd-kit (`rank-reorder`), its
  `DndContext` is scoped inside the nested table, it drags one id at a time, and
  any sort switches it off. The file tree always has the pinned "folders" sort,
  so drag is off there. There is no hover auto-expand.
- **host-fs cannot move files.** It has no move, rename or delete endpoint.
  `hostFsExtract` (`plugins/infra/plugins/host-fs/server/internal/extract.ts`) is
  the template for a mutating endpoint: Origin check, `resolveHostPath`,
  `classifyFsError`, and `freePath` for "name 2" collisions.
- **Favorites are fixed in code.** They are static `FileExplorer.Places`
  contributions (`places/web/internal/places.ts`); nothing persists a user pin.

## Design

### 1. DataView row selection: a set, not a single id (`primitives/data-view`, `primitives/tree`)

This is the clean seam. Every DataView consumer gets Finder-style selection;
the file explorer is just the first to opt in.

- **New prop `DataViewProps.rowSelection?: RowSelectionConfig`** in
  `data-view/core/internal/types.ts`. It is controlled by the consumer and is a
  separate field from the checkbox `selection`:
  ```ts
  interface RowSelectionConfig {
    selected: ReadonlySet<string>;  // row ids
    anchor: string | null;          // range origin, the "primary" row
    onChange(next: { selected: ReadonlySet<string>; anchor: string | null }): void;
  }
  ```
  - `selectedRowId` stays as the primary (focused/opened) row. When
    `rowSelection` is set, `aria-selected` and the highlight come from the set
    (`aria-multiselectable` on the grid).
- **Pure reducer in `tree/core`**: `nextRowSelection(state, gesture, orderedIds)`.
  - Gestures: `click`, `toggle` (Cmd/Ctrl), `range` (Shift), `all`, and
    `extend(±1)` (Shift+arrow).
  - Ranges run over the painted order (`model.orderedIds`), so collapsed
    children are skipped.
  - The range and anchor logic is lifted out of `multi-select-context.tsx`, and
    that context now calls it, so there is one implementation, not two.
  - Unit-tested as a `*.test.ts` file beside it.
- **Gestures**
  - `treeRowGestures` gains an optional `onModifiedSelect(e)` path: with
    Shift or Cmd/Ctrl held, the click selects instead of following the row's
    link.
  - Where a consumer opts into `rowSelection`, Cmd-click means toggle, not
    open in a new tab, which matches Finder. Middle-click still opens a new tab.
  - `useTreeKeyboard` handles Shift+↑/↓ and Cmd/Ctrl+A when `rowSelection` is
    present. Escape clears the set, after the explorer's own close-preview
    handling.
  - Wiring happens in `nested-table-view.tsx` `useRowDecoration`, the call site
    that has `model.orderedIds`.
- **`select-none` on tree/table rows.** This fixes the reported text-select bug
  on its own, for every DataView. Inline editing inputs keep normal text
  selection, so the class goes on the row chrome, not on the inputs.

### 2. DataView native row drag and row drop (`primitives/data-view`, `primitives/tree`)

This uses native HTML5 drag-and-drop, not dnd-kit:

- **It is not reordering.** Moving a file re-parents it; it does not rank it.
- **It must cross the boundary between plugins** (browser to the Places
  sidebar, two separate DataViews in separate sub-plugins). The `dataTransfer`
  MIME type is the contract, so no shared context needs hoisting.
- **It works under the pinned sort.** It does not touch the
  sort-suspends-reorder rule.
- **It opens a path to OS drag-out later** (`text/uri-list`).

New props:

```ts
rowDrag?: {
  // Rows being dragged: the selection if the grabbed row is in it, else just that row.
  write(rows: TRow[], dt: DataTransfer): void;
};
rowDrop?: {
  accepts(row: TRow, types: readonly string[]): boolean; // e.g. a folder row + our MIME
  onDrop(row: TRow, dt: DataTransfer): void | Promise<void>;
  springOpenMs?: number;                                  // default 700 (Finder/VS Code range)
};
```

- **Rows.**
  - Rows become `draggable` when `rowDrag` is set.
  - The drag image counts the rows ("3 items") once more than one is dragged.
  - A row that accepts the drop shows the existing `ring-primary/40` child-drop
    highlight. A row that does not accept it shows nothing and sets
    `dropEffect: none`.
- **Spring-loaded folders.** Hovering an accepting row that is collapsed and
  has lazy children for `springOpenMs` calls `setExpanded`, which loads the
  folder as normal.
  - Leaving the row cancels the timer.
  - Following modern practice, folders that spring open during a drag
    **collapse again** when the drag ends without a drop inside them. VS Code
    and Finder both do this.
  - Implemented in a small `useSpringOpen` hook in `tree/web`. It is timer
    based, not polling: one `setTimeout` per hover, cleared on `dragleave`.
- **Edge auto-scroll** of the tree's scroll container during a drag, using
  the browser's native behaviour plus a small edge zone if needed.
- **Drop on empty space.** A `rowDrop.onDropBackground?` for the listing's
  empty area moves the rows into the current folder.

### 3. Shared drag payload (`infra/host-fs/core`)

- MIME constant `HOST_PATHS_MIME = "application/x-singularity-host-paths+json"`.
- `writeHostPaths(dt, paths)` and `readHostPaths(dt)`, decoded with zod.
- They live in host-fs core because the browser (source) and places (target)
  both import it. Neither imports the other.

### 4. Move endpoint (`infra/host-fs`)

- **`hostFsMove`**: `POST /api/host-fs/move`, body
  `{ sources: string[], destDir: string }`, implemented like `handleExtract`.
- **Returns one result per source:**
  `moved{to} | exists | into-self | missing | denied | archive | same-dir`.
- **Refusals:**
  - archive-virtual sources and destinations (`locateHostPath`);
  - a folder dropped into itself or a descendant;
  - a source that already sits in `destDir` (a no-op).
- **Collision: ask, in two phases.** The body gains
  `resolutions?: Record<source, "replace" | "keep-both" | "skip">`.
  - **Phase 1.** A source that collides and has no resolution comes back as
    `exists{to}`. Nothing is overwritten, and the sources that did not collide
    move straight away.
  - **Dialog.** The client then opens a `ConflictDialog` for each `exists`:
    "“a.txt” already exists in “Docs”", with the buttons **Replace**,
    **Keep both** and **Skip**, an "Apply to all N remaining" checkbox, and
    Cancel, which skips the rest.
  - **Phase 2.** The client re-POSTs only those sources, with their
    resolutions.
  - **Keep both** uses the shared `freePath`.
  - **Replace** removes the destination with `fs.rm`, then renames. It refuses
    when the destination is an ancestor of the source.
  - **Which dialog primitive.** The dialog uses the repo's existing dialog
    primitive under `primitives/overlay`; I'll confirm the exact one during
    implementation.
- **`EXDEV`** (moving across volumes) falls back to `fs.cp` with recursive
  copy, then `fs.rm`.
- **Client:** `useEndpointMutation(hostFsMove, { invalidates: [hostFsList, hostFsPeek, hostFsStat] })`.
  - One summary toast.
  - Moved rows leave the selection.
- **No undo** in v1. An undo toast that moves the files back is easy to add
  later and is listed as a follow-up.

### 5. File explorer wiring

- **`browser/web/components/file-browser.tsx`**
  - `Listing` holds `{selected:Set, anchor}`; `selected` (single) becomes the
    anchor. A plain click keeps today's behaviour: it selects the row and
    previews a file.
  - A modifier click changes only the set; the preview follows the anchor.
- **`file-tree.tsx`**
  - Passes `rowSelection`.
  - `rowDrag` writes the selected rows' absolute paths.
  - `rowDrop` accepts browsable, non-archive folder rows carrying
    `HOST_PATHS_MIME`, and calls the move mutation. `onDropBackground` moves
    into `dir`.
- **Places (`places/`)**
  - **New config** `defineConfig("file-explorer.places", { pinned: listField({ path }) })`,
    written with `useSetConfig`. It is synced, user-owned, and editable in
    Settings → Config.
  - **New `FileExplorer.Places` source `pinned`** in group `favorites`, which
    lists them after the built-ins.
  - **Sidebar `rowDrop`** accepts `HOST_PATHS_MIME` on the Favorites section's
    rows and on the empty space under the section, appends new paths, and drops
    duplicates.
  - **Pinned rows** get an "Remove from Favorites" item action.
  - **Pinned files are allowed** (Finder allows them). Activating one opens its
    parent folder with the file previewed (`/files/at/<parent>/<file>`).
- **The ⋯ row menu** gains "Add to Favorites", so pinning does not require a
  drag.

## Critical files

- `plugins/primitives/plugins/data-view/core/internal/types.ts`: the
  `rowSelection`, `rowDrag` and `rowDrop` props.
- `plugins/primitives/plugins/data-view/plugins/table/web/components/nested-table-view.tsx`:
  `useRowDecoration` wiring and `select-none`.
- `plugins/primitives/plugins/tree/web/internal/{tree-row-gestures.ts,use-tree-keyboard.ts}`,
  plus a new `use-spring-open.ts`, and `tree/core` with the selection reducer
  and its test.
- `plugins/primitives/plugins/multi-select/web/internal/multi-select-context.tsx`:
  reuses the reducer.
- The flat list view (`data-view/plugins/list`) honours `rowDrop` so the Places
  sidebar can accept drops (rows plus the section body).
- `plugins/infra/plugins/host-fs/{core/internal/endpoints.ts,server/internal/move.ts,server/index.ts}`,
  plus a shared `freePath`.
- `plugins/apps/plugins/file-explorer/plugins/browser/web/components/{file-browser.tsx,file-tree.tsx,row-actions.tsx}`.
- `plugins/apps/plugins/file-explorer/plugins/places/web/{internal/places.ts,components/places-sidebar.tsx}`
  and the new config.
- The DataView and tree `CLAUDE.md` sections documenting the new props.

## Verification

- **Unit tests:** `./singularity test plugins/primitives/plugins/tree`
  (selection reducer: toggle, range across collapsed nodes, extend, all) and
  `plugins/infra/plugins/host-fs` (move: into-self refusal, exists, same-dir,
  EXDEV fallback via a tmp dir).
- **Build and checks:** `./singularity build`, then `./singularity check`.
- **E2E script** `file-explorer/plugins/browser/e2e/select-and-move.ts`. It
  works in a tmp folder it creates under `~` and removes afterwards.
  - Drag across rows: no text selection.
  - Cmd-click two rows, Shift-click a range, Cmd+A: `aria-selected` counts.
  - Drag two files over a collapsed folder: it expands after about 700 ms.
    Drop: the files are listed inside it and gone from the source.
  - Drag a folder onto its own child: refused.
  - Move onto a name that already exists: the dialog appears, and each of
    Replace, Keep both ("a 2.txt") and Skip gives the expected files on disk.
  - Drag a row onto Favorites: it appears and survives a reload. "Remove from
    Favorites" removes it.
- **Screenshots** with `screenshot.ts` to check the highlight states in light
  and dark.

## Follow-ups (not in v1)

- An undo toast for a move.
- Option-drag to copy.
- Drag out to the OS (`text/uri-list`).
- Cut/paste (Cmd+X / Cmd+V) to move.
- Drag reorder within Favorites.
