import type React from "react";

import { symbol } from "@plugins/ui/plugins/icons/core";

export const dragIndicatorIcon = symbol("drag-indicator");

/**
 * dnd-kit listeners/attributes (and an activator `ref`) for a row's drag
 * handle — the one shape every member that can hang a handle takes, so a
 * sortable list hands `Row`, `Setting` and `Group` the same bag.
 */
export type ControlPanelHandleProps = React.HTMLAttributes<HTMLElement> & {
  ref?: React.Ref<HTMLElement>;
};

/**
 * The hover-reveal recipe for the drag handle. Opacity and pointer-events are
 * coupled in both directions, so a hidden handle is never a live hit-target
 * sitting invisibly over the row's left edge. Keyed on `group/cp-row`, which
 * every row box that can hang a handle carries.
 */
export const HANDLE_REVEAL =
  "opacity-0 pointer-events-none " +
  "group-hover/cp-row:opacity-100 group-hover/cp-row:pointer-events-auto " +
  "group-focus-within/cp-row:opacity-100 group-focus-within/cp-row:pointer-events-auto";
