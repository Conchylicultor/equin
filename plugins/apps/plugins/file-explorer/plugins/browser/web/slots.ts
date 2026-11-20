import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import { definePaneHeaderSlot } from "@plugins/primitives/plugins/pane/web";
import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type { EntryRow, ExplorerFolder, ExplorerLens } from "../core";

/**
 * A lens on the browser's folder: `useLens(folder, listed)` (a hook, so a lens
 * may read the server) answers what it hides and what it knows of a file's git
 * state. `folder.dir` is absolute in `folder.fs`; a lens that knows only one
 * file system answers nothing for another. `listed` is every folder whose
 * entries the browser lists now (absolute: the folder and each expanded
 * subfolder; none for a file preview) — what a hide rule must answer for, so
 * a lens reads per listed folder, never the whole tree below the folder.
 */
export interface ExplorerLensItem {
  /** Unique among lenses. */
  id: string;
  useLens: Hook<
    (folder: ExplorerFolder, listed: readonly string[]) => ExplorerLens
  >;
}

/**
 * The seams `<FileBrowser/>` exposes. The browser names no contributor: a lens
 * or a field plugs in here, and every browser — the /files app, or one embedded
 * in another surface — composes them all.
 */
export const FileBrowserSlots = {
  /**
   * A tree row's hover actions (Extract here on an archive, Copy path). Which
   * stay inline and which sit behind the row's `⋯` is authored in this slot's
   * config, so it is one decision for every contributor.
   */
  RowActions: defineItemActions<EntryRow>(),

  /**
   * Lenses on the folder: each `hide` rule becomes a toolbar toggle (hidden by
   * default) whose entries the tree drops while it is off, and the first lens
   * answering `fileGit(path)` gives the previewed file its git context (a Diff
   * tab when it changed).
   */
  Lens: defineSlot<ExplorerLensItem>({
    docLabel: (p) => p.id,
  }),
};

/**
 * The header of a file preview pane — ONE pane header slot worn by every
 * preview pane (`filesPreviewPane`, the attachment preview): the file's title
 * first, then the renderer tabs and Open with default app. A pane borrows it
 * with `Pane.define({ actions: FilePreviewHeader })`; it is declared once, in
 * this plugin's `slots`.
 */
export const FilePreviewHeader = definePaneHeaderSlot();

/**
 * The header of a pane hosting a file browser — ONE pane header slot worn by
 * the Files folder column, the folder peek and the conversation's Files pane:
 * back / forward / up, then the path bar (each pane's `title.component`,
 * `FileBrowserPath`), the filter, and the toggles (show hidden, the lenses'
 * hide rules, the folder view's own controls). A pane borrows it with
 * `Pane.define({ actions: FileBrowserHeader })` and wraps its `PaneChrome` in
 * `FileBrowserProvider`; it is declared once, in this plugin's `slots`.
 */
export const FileBrowserHeader = definePaneHeaderSlot();
