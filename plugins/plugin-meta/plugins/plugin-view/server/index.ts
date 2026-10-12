import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pluginFacetsTreeServed, pluginTreeServed } from "./internal/live";

export default {
  description: "Serves the plugin tree data for the plugin-view pane.",
  contributions: [
    ...pluginTreeServed.declare,
    ...pluginFacetsTreeServed.declare,
  ],
} satisfies ServerPluginDefinition;
