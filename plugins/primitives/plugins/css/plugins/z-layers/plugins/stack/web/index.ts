import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ZStack } from "./internal/slots";

export { ZStack, defineZLayer } from "./internal/slots";
export type { ZStackLayer, ZStackLayerDef } from "./internal/slots";

export default {
  description:
    "The top-layer stack: app-wide surfaces declare their own z-layer (ZStack.Layer) in their own plugin, ordered by one committed reorder layout; a layer is drawn only through ViewportOverlay (layer={…}), which reads its z-index and hosts its popups.",
  contributions: [],
  slots: ZStack,
} satisfies PluginDefinition;
