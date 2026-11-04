import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { SortableList } from "./internal/sortable-list";
export type { SortableListProps } from "./internal/sortable-list";
export { SortableItem } from "./internal/sortable-item";
export type {
  SortableItemProps,
  SortableItemState,
} from "./internal/sortable-item";
export {
  DeferredSortableHost,
  DeferredSortableList,
} from "./internal/deferred-sortable";
export type {
  DeferredSortableHostProps,
  DeferredSortableListProps,
} from "./internal/deferred-sortable";
export { useChromePointerSensor } from "./internal/chrome-pointer-sensor";
export { arrayMove, rectSortingStrategy } from "./internal/strategies";
export type { SortingStrategy } from "./internal/strategies";

export default {
  description:
    "Generic sortable list primitive with smooth displacement animations. Wraps @dnd-kit/sortable into SortableList + SortableItem components, its pointer sensor useChromePointerSensor (activates only on a press that is the handle's own — not one bubbled from a portaled popover, not one in text entry — and is the one every drag primitive mounts), plus DeferredSortableList / DeferredSortableHost for a list draggable only in a mode (no drag machinery mounted while disabled, items never remounted by the toggle; its items are deferred-item's DeferredSortableItem, which imports no dnd-kit).",
  contributions: [],
} satisfies PluginDefinition;
