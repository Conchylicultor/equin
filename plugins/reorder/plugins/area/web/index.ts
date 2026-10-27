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
    "What a reorder area in the layout editor draws (the Config pane's reorder-tree field over reorder/editor): the area context, the entry types, and ReorderItemBox — an item box wearing the item chrome the editor publishes into it. A leaf library, imports no drag code.",
  contributions: [],
} satisfies PluginDefinition;
