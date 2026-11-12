import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { VirtualRows, useVirtualRows } from "./internal/virtual-rows";
export { offscreenSkipClass } from "./internal/offscreen-skip";
export type {
  VirtualRowsProps,
  UseVirtualRowsOptions,
  UseVirtualRowsResult,
} from "./internal/virtual-rows";

export default {
  description:
    "Self-discovering windowed row renderer (@tanstack/react-virtual): renders only the rows intersecting the host's scroll viewport (+overscan) inside a full-height sizer, discovering the scroll container at runtime. Shared by data-view's list / gallery / icons views and data-table. Plus offscreenSkipClass: content-visibility: auto for a mounted box sized from outside its content (a fixed-height line, an aspect-ratio cover), so the browser skips styling it while off screen.",
  contributions: [],
} satisfies PluginDefinition;
