import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { VirtualRows, useVirtualRows } from "./internal/virtual-rows";
export type {
  VirtualRowsProps,
  UseVirtualRowsOptions,
  UseVirtualRowsResult,
} from "./internal/virtual-rows";

export default {
  description:
    "Self-discovering windowed row renderer (@tanstack/react-virtual): renders only the rows intersecting the host's scroll viewport (+overscan) inside a full-height sizer, discovering the scroll container at runtime. Shared by data-view's list / gallery / icons views and data-table.",
  contributions: [],
} satisfies PluginDefinition;
