import type { ComponentType, ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { ReorderNode } from "@plugins/fields/plugins/reorder-tree/core";
import type {
  ReorderEntry,
  ReorderItemChromeProps,
} from "@plugins/reorder/plugins/area/web";
import type { ReorderLayout } from "./reorder-layout";
import type { ReorderState } from "./sorting";

// The seam between applying a slot layout (this plugin, a companion of
// slot-render: every bundle) and editing one (`reorder.edit-mode`, opt-in). The
// apply side renders the area's frame and owns the writes; an editor, when one
// ships, is mounted BESIDE the frame's items while edit mode is on and dresses
// them through these contracts — never as their ancestor, so toggling edit mode
// remounts no contribution.

/**
 * How an area in edit mode is laid out, picked from its host:
 *  - `host-wrap` — a layout owner (CollapsibleWrap) injected `ReorderLayoutContext` and wraps itself;
 *  - `passthrough` — vertical: rows already stack;
 *  - `editor-wrap` — horizontal and wide enough: the frame wraps the row onto extra lines;
 *  - `popover` — horizontal and too narrow: the row stays display-only and editing
 *    moves into a vertical popover.
 */
export type ReorderRegime =
  "host-wrap" | "passthrough" | "editor-wrap" | "popover";

/**
 * Every in-app write an area supports, each materializing a fresh `items` tree
 * into the slot's user config layer. Stable identities: they read the latest
 * state when they fire.
 */
export interface ReorderAreaWrites {
  hide: (key: string) => void;
  restore: (key: string) => void;
  drop: (draggedKey: string, overKey: string) => void;
  insert: (create: () => ReorderNode) => void;
  removeNode: (id: string) => void;
  patchNode: (renderId: string, partial: Record<string, unknown>) => void;
}

/** What the apply side hands the editor it mounts beside an area's items. */
export interface ReorderAreaEditorProps {
  regime: ReorderRegime;
  orientation: "horizontal" | "vertical";
  layout: ReorderLayout | null;
  /** The area's entries as the frame draws them. */
  entries: readonly ReorderEntry[];
  /** `popover` regime only: the same entries drawn editable, for the popover's own list. */
  editEntries: readonly ReorderEntry[] | null;
  state: ReorderState;
  renderItem: (contribution: Contribution) => ReactNode;
  writes: ReorderAreaWrites;
}

/** The one implementation of slot-layout editing, contributed to `ReorderSlots.AreaEditor`. */
export interface ReorderAreaEditor {
  /** Mounted beside an area's items while edit mode is on: the drag host, restore/insert, the popover. */
  Area: ComponentType<ReorderAreaEditorProps>;
  ItemChrome: ComponentType<ReorderItemChromeProps>;
}
