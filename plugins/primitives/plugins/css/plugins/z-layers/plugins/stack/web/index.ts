import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ZStack } from "./internal/slots";

export { ZStack, defineZLayer } from "./internal/slots";
export type { ZStackLayer, ZStackLayerDef } from "./internal/slots";
export { useZStackIndex } from "./internal/use-z-stack-index";

export default {
  description:
    "The top-layer stack: app-wide surfaces declare their own z-layer (ZStack.Layer) in their own plugin, ordered by one committed reorder layout; useZStackIndex reads a layer's z-index.",
  contributions: [],
  slots: ZStack,
} satisfies PluginDefinition;
