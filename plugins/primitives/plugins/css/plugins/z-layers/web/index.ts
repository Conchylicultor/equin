import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { zLayerClass, type ZLayer, type InTreeLayer } from "./internal/layers";

export default {
  description:
    "Semantic z-layer scale (z-base..z-max) and its enforcing lint rule (no-adhoc-zindex).",
  contributions: [],
} satisfies PluginDefinition;
