import type { HTMLAttributes } from "react";
import type { SortableItemState } from "@plugins/primitives/plugins/sortable-list/web";

/**
 * dnd-kit's activator props, in the shape a `ControlPanel.Row` /
 * `ControlPanel.RuleRow` takes for its `handleProps`.
 *
 * `SortableItemState` types them as `Record<string, unknown>` (dnd-kit hands
 * back an open bag of listeners + aria attributes), which is not assignable to
 * the panel row's `HTMLAttributes<HTMLElement>`. The cast lives here, once, so
 * every reorderable panel list with a handle (the sort rule list) shares it —
 * and so the day the primitive types them properly there is
 * exactly one place to delete.
 */
export function dragHandleProps(
  state: SortableItemState,
): HTMLAttributes<HTMLElement> | undefined {
  return state.handleProps as HTMLAttributes<HTMLElement> | undefined;
}
