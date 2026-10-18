import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  DeferredSortableItem,
  ItemBindingProvider,
  useItemBindingStore,
} from "./internal/binding";
export type {
  DeferredItemState,
  DeferredSortableItemProps,
  ItemBindingStore,
  ItemDrag,
} from "./internal/binding";

export default {
  description:
    "The drag-free half of a deferred sortable list: ItemBindingProvider (a per-list binding store) and DeferredSortableItem (a box that wears whatever drag props a sibling host publishes for its id, and is a plain box otherwise). Imports no @dnd-kit, so a surface that only renders the list at rest ships without it; sortable-list's DeferredSortableHost is the dnd-kit half that binds it.",
  contributions: [],
} satisfies PluginDefinition;
