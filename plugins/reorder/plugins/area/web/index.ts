import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { ReorderAreaContext } from "./internal/area";
export type {
  ReorderAreaCtxValue,
  ReorderEntry,
  ReorderItemChromeClasses,
  ReorderItemChromeProps,
  ReorderItemEntry,
  ReorderNodeEntry,
} from "./internal/area";
export { ReorderItemBox } from "./internal/item-box";
export type { ReorderItemBoxProps } from "./internal/item-box";

export default {
  description:
    "What a reorder area draws, shared by applying a slot layout (reorder) and editing one (reorder/editor, reorder/edit-mode): the area context, the entry types, and ReorderItemBox — an item box at rest display: contents, which wears the item chrome an editor publishes into it. A leaf library both sides import, imports no drag code.",
  contributions: [],
} satisfies PluginDefinition;
