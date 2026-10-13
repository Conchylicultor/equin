import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import {
  defineFieldExtensions,
  defineItemActions,
} from "@plugins/primitives/plugins/data-view/web";
import type { EntryRow, ExplorerLens } from "../core";

/**
 * A lens on the browser's folder: `useLens(dir)` (a hook, so a lens may read
 * the server) answers what it hides and what it knows of a file's git state.
 * `dir` is absolute.
 */
export interface ExplorerLensItem {
  /** Unique among lenses. */
  id: string;
  useLens: Hook<(dir: string) => ExplorerLens>;
}

/**
 * The seams `<FileBrowser/>` exposes. The browser names no contributor: a lens
 * or a field plugs in here, and every browser — the /files app, or one embedded
 * in another surface — composes them all.
 */
export const FileBrowserSlots = {
  /**
   * Extra fields of the tree DataView. A field with a `value` gets Sort and
   * Filter for free; a field extension is a component, so its `value` may
   * close over data it reads with hooks.
   */
  Fields: defineFieldExtensions<EntryRow>(),

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
