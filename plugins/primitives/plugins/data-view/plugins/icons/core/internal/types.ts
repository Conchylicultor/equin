import type { Ref } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

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
}
