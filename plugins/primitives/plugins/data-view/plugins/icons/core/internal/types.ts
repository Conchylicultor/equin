import type { Ref } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import type { IconRef } from "@plugins/ui/plugins/icons/core";

/**
 * Per-view options for the icons view, threaded through
 * `DataViewProps.viewOptions.icons` and surfaced as the opaque
 * `DataViewRenderProps.options`.
 */
export interface IconsViewOptions<TRow> {
  /**
   * A ref for one row's WHOLE tile — the tile square and its name, the box
   * the user reads as "the app" — run as a hook once per rendered tile (so
   * the ref may come from a hook, e.g. a hint anchor registering the tile).
   * Called with the row; return the ref to attach. A host that only needs the
   * square itself overrides the leading field's `cell` instead.
   */
  useTileRef?: Hook<(row: TRow) => Ref<HTMLElement>>;
  /**
   * Lay the grid out as a menu's (the menu-bar panel's): exactly `columns`
   * cells sharing the view's width instead of fixed-width cells centred in
   * it, each cell a menu target — highlighted on hover rather than lifted —
   * with its name in the text colour at the compact caption rung, and its
   * item actions overhanging the icon's bottom-right corner, chipless (each
   * action draws its own round button). For a surface of known width; the
   * density prop is ignored.
   */
  menu?: { columns: number };
  /**
   * A tile after the last one that makes one more — a launcher's "New app":
   * drawn as an empty dashed outline around `icon`, with `label` under it, in
   * the same cell as every tile. It is no row, so search, sort, drag and the
   * row count never see it; it is hidden while nothing matches (the empty
   * state speaks then).
   */
  addTile?: { label: string; icon: IconRef; activation: Activation };
}
