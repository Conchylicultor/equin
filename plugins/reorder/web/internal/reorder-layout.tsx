import { createContext } from "react";

/**
 * Layout-specific decisions a layout owner (e.g. CollapsibleWrap) can inject
 * into the reorder middleware. When no provider is present the middleware picks
 * its own regime from the host's axis and width.
 *
 * Closed data, not a dnd-kit strategy: the apply side ships in every bundle and
 * imports no drag code; the layout editor maps `flow: "wrap"` to dnd-kit's 2-D
 * `rectSortingStrategy` so chips drag correctly across wrapped rows. The spacer
 * stays the same `flex-1` push element whether the row wraps or not.
 */
export interface ReorderLayout {
  /** The host wraps its row onto several lines (2-D drag). */
  flow: "wrap";
}

/**
 * Null everywhere except inside a layout owner's provider. The reorder
 * middleware reads it to pick the `host-wrap` regime.
 */
export const ReorderLayoutContext = createContext<ReorderLayout | null>(null);
