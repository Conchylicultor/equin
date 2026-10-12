import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { tableSampleRowsServed } from "./internal/served";

export default {
  contributions: [...tableSampleRowsServed.declare],
} satisfies ServerPluginDefinition;
