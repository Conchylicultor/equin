import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { SortableList } from "./internal/sortable-list";
export type { SortableListProps } from "./internal/sortable-list";
export { SortableItem } from "./internal/sortable-item";
export type {
  SortableItemProps,
  SortableItemState,
} from "./internal/sortable-item";
export {
  DeferredSortableList,
  DeferredSortableItem,
} from "./internal/deferred-sortable";
export type {
  DeferredSortableListProps,
  DeferredSortableItemProps,
} from "./internal/deferred-sortable";
export { arrayMove, rectSortingStrategy } from "./internal/strategies";
export type { SortingStrategy } from "./internal/strategies";

export default {
  description:
    "Generic sortable list primitive with smooth displacement animations. Wraps @dnd-kit/sortable into SortableList + SortableItem components, plus DeferredSortableList + DeferredSortableItem for a list draggable only in a mode (no drag machinery mounted while disabled, items never remounted by the toggle).",
  contributions: [],
} satisfies PluginDefinition;
