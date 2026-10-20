import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pluginFacetsTreeServed, pluginTreeServed } from "./internal/live";

export default {
  description:
    "Serves the plugin tree data for the plugin-view pane, desktop-only: both trees are read and watched from this checkout's `plugins/` directory, so a host without the computer answers them unavailable.",
  contributions: [
    ...pluginTreeServed.declare,
    ...pluginFacetsTreeServed.declare,
  ],
} satisfies MachinePluginDefinition;
