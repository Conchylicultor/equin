import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export type { FlowAxis } from "./internal/layout-host";
export { useHostFlowAxis } from "./internal/use-host-flow-axis";

export default {
  description:
    "Which way the box laying a node out flows its children: useHostFlowAxis(sentinelRef, { followResize? }) reads it in the frame's after-layout phase (no forced style recalc on the commit path) — the host being the nearest ancestor that draws a box (skipping display: contents wrappers, whose width is 0 and which never resize), and row only for a row flex container (computed flex-direction alone says row for every element). Shared by the slot renderer and the reorder middleware so neither misreads a wrapped host.",
  contributions: [],
} satisfies PluginDefinition;
